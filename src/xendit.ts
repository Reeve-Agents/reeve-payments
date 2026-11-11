import { timingSafeEqual } from "node:crypto";
import { RailConfigError, SubAccountRequiredError, WebhookVerificationError, type InvoiceRequest, type PaymentRail, type RailContext, type RailEvent, type RailInvoice } from "./types";

export interface XenditRailOptions {
  /** A development (test) secret key, xnd_development_…. Production keys are refused. */
  secretKey: string;
  /** The callback verification token from Dashboard → Webhooks; without it webhooks are refused and Reeve polls. */
  webhookToken?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

interface Session {
  payment_session_id: string;
  status: "ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELED";
  amount: number;
  payment_link_url?: string;
  payment_request_id?: string | null;
  latest_payment_request_id?: string | null;
}

class XenditError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Xendit wants alphanumeric customer reference ids. */
const refId = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(0, 64) || "reeve";

/**
 * Xendit Payment Sessions (the successor of the legacy Invoice API) in test mode: one
 * PAY session with a hosted payment link per bill, so the tenant can pay by VA, QRIS
 * or e-wallet. Amounts are whole rupiah.
 *
 * Reeve never holds a merchant's money: every call is made with the merchant's own xenPlatform
 * sub-account in the `for-user-id` header, so the payment settles in that sub-account, not in Reeve's
 * master balance. No sub-account, no call (SubAccountRequiredError).
 * Docs: https://docs.xendit.co/docs/accepting-payments-for-sub-accounts (the `for-user-id` header),
 * https://docs.xendit.co/apidocs/create-session.md and https://docs.xendit.co/apidocs/get-session.md (both accept it),
 * https://docs.xendit.co/apidocs/create-a-refund.md (accepts it), and
 * https://docs.xendit.co/apidocs/webhook-notification-sent-defined-webhook-url-updates-payment-session.md
 * (webhooks carry the account in the top-level `business_id`).
 */
export class XenditRail implements PaymentRail {
  readonly name = "xendit";
  readonly testMode = true;
  readonly perMerchantAccount = true;
  private readonly fetch: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: XenditRailOptions) {
    if (!opts.secretKey.startsWith("xnd_development_")) throw new RailConfigError("Reeve only runs Xendit in test mode: XENDIT_SECRET_KEY must start with xnd_development_");
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.base = (opts.baseURL ?? "https://api.xendit.co").replace(/\/+$/, "");
  }

  async createInvoice(req: InvoiceRequest, ctx?: RailContext): Promise<RailInvoice> {
    const session = await this.call<Session>("POST", "/sessions", ctx, {
      reference_id: req.idempotencyKey.slice(0, 64),
      session_type: "PAY",
      mode: "PAYMENT_LINK",
      amount: req.amount,
      currency: "IDR",
      country: "ID",
      customer: {
        type: "INDIVIDUAL",
        reference_id: refId(req.idempotencyKey),
        ...(req.customer.email ? { email: req.customer.email } : {}),
        individual_detail: { given_names: req.customer.name },
      },
      description: req.description,
      // A session lasts 30 minutes by default; keep the link open until the end of the due date.
      expires_at: new Date(`${req.dueDate}T23:59:59+07:00`).toISOString(),
    });
    return this.map(session);
  }

  async getInvoice(invoiceId: string, ctx?: RailContext): Promise<RailInvoice> {
    return this.map(await this.call<Session>("GET", `/sessions/${encodeURIComponent(invoiceId)}`, ctx));
  }

  /**
   * Test mode: settles the payment request the tenant started on the hosted page (after picking a
   * channel such as a BCA virtual account). A session nobody has opened yet has nothing to settle.
   */
  async simulatePayment(invoiceId: string, ctx?: RailContext): Promise<RailInvoice> {
    const session = await this.call<Session>("GET", `/sessions/${encodeURIComponent(invoiceId)}`, ctx);
    const pr = session.latest_payment_request_id ?? session.payment_request_id;
    if (!pr) throw new Error("open the payment link and pick a test payment channel first; then Reeve can settle it");
    // The simulate page does not list `for-user-id`; it is sent so the request is made as the sub-account like every other call (test mode only).
    await this.call("POST", `/v3/payment_requests/${encodeURIComponent(pr)}/simulate`, ctx, { amount: session.amount }, { "api-version": "2024-11-11" });
    return this.getInvoice(invoiceId, ctx);
  }

  async refund(invoice: RailInvoice, amount: number, idempotencyKey: string, ctx?: RailContext) {
    if (!invoice.paymentRef) throw new Error(`session ${invoice.invoiceId} has no payment request to refund`);
    const refund = await this.call<{ id: string; status: string }>("POST", "/refunds", ctx, {
      payment_request_id: invoice.paymentRef,
      reference_id: idempotencyKey.slice(0, 255),
      amount,
      currency: "IDR",
      reason: "DUPLICATE",
    });
    return { refundId: refund.id, status: refund.status.toLowerCase() };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): RailEvent | null {
    if (!this.opts.webhookToken) throw new WebhookVerificationError("XENDIT_WEBHOOK_TOKEN is not set; refusing unverified webhooks");
    const got = Buffer.from(headers["x-callback-token"] ?? "");
    const want = Buffer.from(this.opts.webhookToken);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new WebhookVerificationError("x-callback-token does not match");
    const body = JSON.parse(rawBody) as { event?: string; created?: string; business_id?: string; data?: Session & { payment_id?: string; business_id?: string } };
    const data = body.data;
    if (!data?.payment_session_id) return null;
    const at = body.created ?? new Date().toISOString();
    // The sub-account the payment settled in: top-level business_id, else the one inside data.
    const account = body.business_id ?? data.business_id;
    if (body.event === "payment_session.completed") {
      return {
        type: "invoice.paid",
        // Xendit has no event id; the payment id is unique per payment (its own advice for de-duplication).
        eventId: data.payment_id ?? `${data.payment_session_id}:completed`,
        invoiceId: data.payment_session_id,
        amount: data.amount,
        at,
        paymentRef: data.payment_request_id ?? undefined,
        account,
      };
    }
    if (body.event === "payment_session.expired") return { type: "invoice.expired", eventId: `${data.payment_session_id}:expired`, invoiceId: data.payment_session_id, at, account };
    return null;
  }

  private map(s: Session): RailInvoice {
    const status = s.status === "COMPLETED" ? "paid" : s.status === "EXPIRED" ? "expired" : s.status === "CANCELED" ? "void" : "open";
    return {
      invoiceId: s.payment_session_id,
      status,
      amount: s.amount,
      amountPaid: status === "paid" ? s.amount : 0,
      payUrl: s.payment_link_url,
      paymentRef: s.payment_request_id ?? s.latest_payment_request_id ?? undefined,
    };
  }

  private async call<T>(method: string, path: string, ctx: RailContext | undefined, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    // Refused before any request leaves: Reeve's master balance is never the destination.
    if (!ctx?.account) throw new SubAccountRequiredError("Xendit");
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.opts.secretKey}:`).toString("base64")}`,
        "for-user-id": ctx.account,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as T & { error_code?: string; message?: string }) : ({} as T & { error_code?: string; message?: string });
    if (!res.ok) throw new XenditError(res.status, json.error_code ?? "HTTP_ERROR", `Xendit ${method} ${path}: HTTP ${res.status} ${json.error_code ?? ""} ${json.message ?? ""}`.trim());
    return json;
  }
}
