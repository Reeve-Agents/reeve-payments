/** Shared rail types. Amounts are whole rupiah; each adapter converts to its provider's unit. */

export interface InvoiceRequest {
  /** Who pays. `ref` is Reeve's id for them (e.g. the room), unique within one operation. */
  customer: { ref: string; name: string; email?: string };
  amount: number; // IDR, integer
  description: string;
  dueDate: string; // YYYY-MM-DD
  /** Same key, same invoice: a retried operation never bills twice. */
  idempotencyKey: string;
}

export interface RailInvoice {
  invoiceId: string;
  status: "open" | "paid" | "expired" | "void";
  amount: number;
  amountPaid: number;
  /** The hosted page the customer pays on. */
  payUrl?: string;
  /** The provider's payment id, needed for a refund. */
  paymentRef?: string;
}

export interface PayoutRequest {
  destination: { kind: "bank" | "virtual_account" | "ewallet"; bankCode?: string; account: string; name?: string };
  amount: number;
  description: string;
  idempotencyKey: string;
}

/**
 * Who the money belongs to. For a rail with `perMerchantAccount`, `account` is the merchant's own sub-account
 * (Xendit xenPlatform user id): every call is made on its behalf, so funds settle there and never in Reeve's balance.
 */
export interface RailContext {
  account?: string;
}

export type RailEvent =
  | { type: "invoice.paid"; eventId: string; invoiceId: string; amount: number; at: string; paymentRef?: string; account?: string }
  | { type: "invoice.expired"; eventId: string; invoiceId: string; at: string; account?: string };

export class RailConfigError extends Error {}
export class WebhookVerificationError extends Error {}
/** The merchant has not connected their own payment account, so Reeve will not bill on their behalf. */
export class SubAccountRequiredError extends RailConfigError {
  constructor(rail = "Xendit") {
    super(`Hubungkan akun ${rail} Anda dulu: Reeve tidak menampung uang pelanggan Anda, jadi tagihan hanya bisa dibuat lewat akun ${rail} milik Anda sendiri.`);
  }
}

export interface PaymentRail {
  readonly name: string;
  /** True for every rail Reeve builds today: live keys are refused. */
  readonly testMode: boolean;
  /** True when every call needs the merchant's own sub-account in `ctx.account`; without it the rail refuses (SubAccountRequiredError). */
  readonly perMerchantAccount?: boolean;
  createInvoice(req: InvoiceRequest, ctx?: RailContext): Promise<RailInvoice>;
  getInvoice(invoiceId: string, ctx?: RailContext): Promise<RailInvoice>;
  /** Irreversible: the broker checks the rulebook's limit and the owner's passkey before calling. */
  refund(invoice: RailInvoice, amount: number, idempotencyKey: string, ctx?: RailContext): Promise<{ refundId: string; status: string }>;
  /** Test mode only: pay an open invoice as the customer would. */
  simulatePayment?(invoiceId: string, ctx?: RailContext): Promise<RailInvoice>;
  /** Verify and translate a provider webhook. Unknown event types return null; a forged one throws. */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): RailEvent | null;
  /** Irreversible: the broker must check the mandate and owner approval before calling. */
  payout?(req: PayoutRequest, ctx?: RailContext): Promise<{ payoutId: string; status: "pending" | "awaiting_approval" | "completed" }>;
}
