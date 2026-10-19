import Stripe from "stripe";
import { RailConfigError, WebhookVerificationError, type InvoiceRequest, type PaymentRail, type RailEvent, type RailInvoice } from "./types";

export interface StripeRailOptions {
  /** A test-mode secret or restricted key (sk_test_… / rk_test_…). Live keys are refused. */
  secretKey: string;
  /** whsec_… from the Dashboard webhook endpoint or `stripe listen`; without it webhooks are refused and Reeve polls. */
  webhookSecret?: string;
  client?: Stripe;
  now?: () => Date;
}

/** IDR is a two-decimal currency on Stripe: Rp1,500,000 is sent as 150000000. */
const toMinor = (rupiah: number) => Math.round(rupiah * 100);
const fromMinor = (minor: number) => Math.round(minor / 100);

/**
 * Stripe Invoicing in test mode: one customer, one invoice item and one finalised
 * `send_invoice` invoice per bill, paid on Stripe's hosted invoice page.
 */
export class StripeRail implements PaymentRail {
  readonly name = "stripe";
  readonly testMode = true;
  private readonly stripe: Stripe;
  private readonly now: () => Date;

  constructor(private readonly opts: StripeRailOptions) {
    if (!/^(sk|rk)_test_/.test(opts.secretKey)) throw new RailConfigError("Reeve only runs Stripe in test mode: STRIPE_SECRET_KEY must start with sk_test_ or rk_test_");
    this.stripe = opts.client ?? new Stripe(opts.secretKey);
    this.now = opts.now ?? (() => new Date());
  }

  async createInvoice(req: InvoiceRequest): Promise<RailInvoice> {
    const key = req.idempotencyKey;
    const metadata = { reeve_ref: req.customer.ref, reeve_key: key };
    // Stripe requires an email on send_invoice customers. Reeve never asks Stripe to send the invoice (the
    // owner shares the hosted link), so a tenant without one gets an address on example.com, which is reserved.
    const email = req.customer.email ?? `tenant-${req.customer.ref.toLowerCase().replace(/[^a-z0-9]/g, "")}@example.com`;
    const customer = await this.stripe.customers.create({ name: req.customer.name, email, metadata }, { idempotencyKey: `${key}:customer` });
    await this.stripe.invoiceItems.create(
      { customer: customer.id, amount: toMinor(req.amount), currency: "idr", description: req.description },
      { idempotencyKey: `${key}:item` },
    );
    const draft = await this.stripe.invoices.create(
      {
        customer: customer.id,
        collection_method: "send_invoice",
        days_until_due: this.daysUntil(req.dueDate),
        pending_invoice_items_behavior: "include",
        auto_advance: false,
        description: req.description,
        metadata,
      },
      { idempotencyKey: `${key}:invoice` },
    );
    const invoice = await this.stripe.invoices.finalizeInvoice(draft.id!, {}, { idempotencyKey: `${key}:finalize` });
    return this.map(invoice);
  }

  async getInvoice(invoiceId: string): Promise<RailInvoice> {
    return this.map(await this.stripe.invoices.retrieve(invoiceId));
  }

  /** Pays the invoice with Stripe's test Visa card, as a tenant would on the hosted page. */
  async simulatePayment(invoiceId: string): Promise<RailInvoice> {
    const invoice = await this.stripe.invoices.retrieve(invoiceId);
    const customer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    if (!customer) throw new Error(`invoice ${invoiceId} has no customer`);
    // Stripe only charges a payment method attached to the invoice's customer.
    const card = await this.stripe.paymentMethods.attach("pm_card_visa", { customer });
    return this.map(await this.stripe.invoices.pay(invoiceId, { payment_method: card.id }));
  }

  async refund(invoice: RailInvoice, amount: number, idempotencyKey: string) {
    const payments = await this.stripe.invoicePayments.list({ invoice: invoice.invoiceId, limit: 10 });
    const paid = payments.data.find((p) => p.status === "paid" && p.payment.payment_intent);
    const pi = paid?.payment.payment_intent;
    if (!pi) throw new Error(`invoice ${invoice.invoiceId} has no card payment to refund`);
    const refund = await this.stripe.refunds.create(
      { payment_intent: typeof pi === "string" ? pi : pi.id, amount: toMinor(amount), reason: "duplicate" },
      { idempotencyKey },
    );
    return { refundId: refund.id, status: refund.status ?? "pending" };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): RailEvent | null {
    if (!this.opts.webhookSecret) throw new WebhookVerificationError("STRIPE_WEBHOOK_SECRET is not set; refusing unverified webhooks");
    const signature = headers["stripe-signature"];
    if (!signature) throw new WebhookVerificationError("missing Stripe-Signature header");
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.opts.webhookSecret);
    } catch (err) {
      throw new WebhookVerificationError(`Stripe signature check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const at = new Date(event.created * 1000).toISOString();
    if (event.type === "invoice.paid") {
      const inv = event.data.object;
      return { type: "invoice.paid", eventId: event.id, invoiceId: inv.id!, amount: fromMinor(inv.amount_paid), at };
    }
    if (event.type === "invoice.voided" || event.type === "invoice.marked_uncollectible") {
      return { type: "invoice.expired", eventId: event.id, invoiceId: event.data.object.id!, at };
    }
    return null;
  }

  private daysUntil(dueDate: string): number {
    const due = Date.parse(`${dueDate}T23:59:59Z`);
    return Math.max(1, Math.ceil((due - this.now().getTime()) / 86_400_000));
  }

  private map(inv: Stripe.Invoice): RailInvoice {
    const status = inv.status === "paid" ? "paid" : inv.status === "void" || inv.status === "uncollectible" ? "void" : "open";
    return {
      invoiceId: inv.id!,
      status,
      amount: fromMinor(inv.amount_due),
      amountPaid: fromMinor(inv.amount_paid),
      payUrl: inv.hosted_invoice_url ?? undefined,
    };
  }
}
