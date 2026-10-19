import type { InvoiceRequest, PaymentRail, PayoutRequest, RailEvent, RailInvoice } from "./types";

/** In-memory rail for tests and offline demos. */
export class MockRail implements PaymentRail {
  readonly name = "mock";
  readonly testMode = true;
  readonly log: string[] = [];
  private n = 0;
  private readonly invoices = new Map<string, RailInvoice>();
  private readonly byKey = new Map<string, string>();

  async createInvoice(req: InvoiceRequest) {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return { ...this.invoices.get(existing)! };
    const invoiceId = `inv_mock_${++this.n}`;
    const inv: RailInvoice = { invoiceId, status: "open", amount: req.amount, amountPaid: 0, payUrl: `https://pay.mock.reeve/${invoiceId}` };
    this.invoices.set(invoiceId, inv);
    this.byKey.set(req.idempotencyKey, invoiceId);
    this.log.push(`createInvoice ${invoiceId} ${req.customer.ref} ${req.amount}`);
    return { ...inv };
  }

  async getInvoice(invoiceId: string) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error(`no such invoice ${invoiceId}`);
    return { ...inv };
  }

  async simulatePayment(invoiceId: string) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error(`no such invoice ${invoiceId}`);
    if (inv.status !== "open") throw new Error(`invoice ${invoiceId} is ${inv.status}`);
    Object.assign(inv, { status: "paid", amountPaid: inv.amount, paymentRef: `pay_mock_${++this.n}` });
    this.log.push(`paid ${invoiceId} ${inv.amount}`);
    return { ...inv };
  }

  async refund(invoice: RailInvoice, amount: number) {
    const refundId = `re_mock_${++this.n}`;
    this.log.push(`refund ${refundId} ${invoice.invoiceId} ${amount}`);
    return { refundId, status: "succeeded" };
  }

  parseWebhook(rawBody: string): RailEvent | null {
    const body = JSON.parse(rawBody) as RailEvent;
    return body.type === "invoice.paid" || body.type === "invoice.expired" ? body : null;
  }

  async payout(req: PayoutRequest) {
    const payoutId = `po_mock_${++this.n}`;
    this.log.push(`payout ${payoutId} ${req.destination.kind}:${req.destination.account} ${req.amount}`);
    return { payoutId, status: "awaiting_approval" as const };
  }
}
