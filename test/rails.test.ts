import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RailConfigError, railEntries, StripeRail, WebhookVerificationError, XenditRail } from "../src/index";

/** A fake api.stripe.com: records every request (path, form body, idempotency key) and answers like Stripe. */
const calls: { method: string; path: string; body: URLSearchParams; idem?: string }[] = [];
let invoiceStatus = "open";
const server = createServer(async (req: IncomingMessage, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const path = (req.url ?? "").split("?")[0]!;
  calls.push({ method: req.method!, path, body: new URLSearchParams(raw || (req.url ?? "").split("?")[1] || ""), idem: req.headers["idempotency-key"] as string | undefined });
  const invoice = (status: string) => ({
    id: "in_1",
    customer: "cus_1",
    object: "invoice",
    status,
    amount_due: 150_000_000,
    amount_paid: status === "paid" ? 150_000_000 : 0,
    hosted_invoice_url: "https://invoice.stripe.com/i/test_1",
  });
  const json = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (path === "/v1/customers") return json({ id: "cus_1", object: "customer" });
  if (path === "/v1/invoiceitems") return json({ id: "ii_1", object: "invoiceitem" });
  if (path === "/v1/invoices") return json({ ...invoice("draft") });
  if (path === "/v1/invoices/in_1/finalize") return json(invoice("open"));
  if (path === "/v1/payment_methods/pm_card_visa/attach") return json({ id: "pm_attached_1", object: "payment_method" });
  if (path === "/v1/invoices/in_1/pay") return json(invoice((invoiceStatus = "paid")));
  if (path === "/v1/invoices/in_1") return json(invoice(invoiceStatus));
  if (path === "/v1/invoice_payments") return json({ object: "list", has_more: false, data: [{ id: "inpay_1", status: "paid", payment: { type: "payment_intent", payment_intent: "pi_1" } }] });
  if (path === "/v1/refunds") return json({ id: "re_1", object: "refund", status: "succeeded" });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `unexpected ${path}` } }));
});
let stripe: StripeRail;
let client: Stripe;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  client = new Stripe("sk_test_fake", { host: "127.0.0.1", port, protocol: "http", maxNetworkRetries: 0 });
  stripe = new StripeRail({ secretKey: "sk_test_fake", webhookSecret: "whsec_test", client, now: () => new Date("2026-10-18T00:00:00Z") });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req = { customer: { ref: "K01", name: "Penghuni 1" }, amount: 1_500_000, description: "Sewa K01-2026-11 · Kamar 1", dueDate: "2026-11-01", idempotencyKey: "op_1:K01-2026-11" };

describe("Stripe rail (test mode)", () => {
  it("refuses live keys", () => {
    expect(() => new StripeRail({ secretKey: "sk_live_x" })).toThrow(RailConfigError);
  });

  it("bills in IDR minor units, idempotently, as a finalised send_invoice invoice", async () => {
    calls.length = 0;
    const inv = await stripe.createInvoice(req);
    expect(inv).toEqual({ invoiceId: "in_1", status: "open", amount: 1_500_000, amountPaid: 0, payUrl: "https://invoice.stripe.com/i/test_1" });
    expect(calls.map((c) => c.path)).toEqual(["/v1/customers", "/v1/invoiceitems", "/v1/invoices", "/v1/invoices/in_1/finalize"]);
    expect(calls[0]!.body.get("email")).toBe("tenant-k01@example.com");
    const item = calls[1]!.body;
    expect([item.get("amount"), item.get("currency")]).toEqual(["150000000", "idr"]);
    const invoice = calls[2]!.body;
    expect([invoice.get("collection_method"), invoice.get("days_until_due"), invoice.get("pending_invoice_items_behavior")]).toEqual(["send_invoice", "15", "include"]);
    expect(calls.map((c) => c.idem)).toEqual(["op_1:K01-2026-11:customer", "op_1:K01-2026-11:item", "op_1:K01-2026-11:invoice", "op_1:K01-2026-11:finalize"]);
  });

  it("pays with the test card, then refunds the payment intent", async () => {
    calls.length = 0;
    const paid = await stripe.simulatePayment("in_1");
    expect(paid.status).toBe("paid");
    expect(calls.map((c) => c.path)).toEqual(["/v1/invoices/in_1", "/v1/payment_methods/pm_card_visa/attach", "/v1/invoices/in_1/pay"]);
    expect(calls[2]!.body.get("payment_method")).toBe("pm_attached_1");
    const r = await stripe.refund(paid, 250_000, "op_1:ex-1:refund");
    expect(r).toEqual({ refundId: "re_1", status: "succeeded" });
    const refund = calls.find((c) => c.path === "/v1/refunds")!;
    expect([refund.body.get("payment_intent"), refund.body.get("amount"), refund.idem]).toEqual(["pi_1", "25000000", "op_1:ex-1:refund"]);
  });

  it("verifies webhook signatures", () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", created: 1_792_300_000, data: { object: { id: "in_1", object: "invoice", amount_paid: 150_000_000 } } });
    const header = client.webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
    expect(stripe.parseWebhook(payload, { "stripe-signature": header })).toMatchObject({ type: "invoice.paid", eventId: "evt_1", invoiceId: "in_1", amount: 1_500_000 });
    const forged = client.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    expect(() => stripe.parseWebhook(payload, { "stripe-signature": forged })).toThrow(WebhookVerificationError);
    expect(() => new StripeRail({ secretKey: "sk_test_x", client }).parseWebhook(payload, { "stripe-signature": header })).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});

describe("Xendit rail (test mode)", () => {
  const sessions: Record<string, unknown> = {};
  const seen: { method: string; url: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ method: init.method!, url, body, headers: init.headers as Record<string, string> });
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
    if (url.endsWith("/sessions") && init.method === "POST") {
      const s = { payment_session_id: "ps-1", status: "ACTIVE", amount: body!.amount, payment_link_url: "https://xen.to/abc", latest_payment_request_id: null };
      sessions["ps-1"] = s;
      return reply(201, s);
    }
    if (url.endsWith("/sessions/ps-1")) return reply(200, sessions["ps-1"]);
    if (url.includes("/v3/payment_requests/pr-1/simulate")) {
      Object.assign(sessions["ps-1"] as object, { status: "COMPLETED", payment_request_id: "pr-1" });
      return reply(200, { status: "PENDING" });
    }
    if (url.endsWith("/refunds")) return reply(200, { id: "rfd-1", status: "PENDING" });
    return reply(404, { error_code: "DATA_NOT_FOUND", message: url });
  }) as unknown as typeof fetch;
  const xendit = new XenditRail({ secretKey: "xnd_development_fake", webhookToken: "tok_123", fetch: fakeFetch });

  it("refuses production keys", () => {
    expect(() => new XenditRail({ secretKey: "xnd_production_x" })).toThrow(RailConfigError);
  });

  it("creates a PAY session with a hosted link, whole rupiah, Basic auth", async () => {
    const inv = await xendit.createInvoice(req);
    expect(inv).toMatchObject({ invoiceId: "ps-1", status: "open", amount: 1_500_000, payUrl: "https://xen.to/abc" });
    const call = seen[0]!;
    expect(call.url).toBe("https://api.xendit.co/sessions");
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from("xnd_development_fake:").toString("base64")}`);
    expect(call.body).toMatchObject({ session_type: "PAY", mode: "PAYMENT_LINK", currency: "IDR", country: "ID", amount: 1_500_000, reference_id: "op_1:K01-2026-11" });
    expect((call.body!.customer as { reference_id: string }).reference_id).toBe("op1K01202611");
    expect(call.body!.expires_at).toBe("2026-11-01T16:59:59.000Z");
  });

  it("can only settle a payment the tenant started on the hosted page", async () => {
    await expect(xendit.simulatePayment("ps-1")).rejects.toThrow(/open the payment link/);
    Object.assign(sessions["ps-1"] as object, { latest_payment_request_id: "pr-1" });
    const paid = await xendit.simulatePayment("ps-1");
    expect(paid).toMatchObject({ status: "paid", amountPaid: 1_500_000, paymentRef: "pr-1" });
    const sim = seen.find((s) => s.url.includes("/simulate"))!;
    expect(sim.headers["api-version"]).toBe("2024-11-11");
    const r = await xendit.refund(paid, 250_000, "op_1:ex-1:refund");
    expect(r).toEqual({ refundId: "rfd-1", status: "pending" });
    expect(seen.at(-1)!.body).toMatchObject({ payment_request_id: "pr-1", amount: 250_000, reason: "DUPLICATE", currency: "IDR" });
  });

  it("checks the callback token on webhooks", () => {
    const body = JSON.stringify({ event: "payment_session.completed", created: "2026-10-18T03:00:00Z", data: { payment_session_id: "ps-1", amount: 1_500_000, payment_id: "py-1", payment_request_id: "pr-1", status: "COMPLETED" } });
    expect(xendit.parseWebhook(body, { "x-callback-token": "tok_123" })).toEqual({ type: "invoice.paid", eventId: "py-1", invoiceId: "ps-1", amount: 1_500_000, at: "2026-10-18T03:00:00Z", paymentRef: "pr-1" });
    expect(() => xendit.parseWebhook(body, { "x-callback-token": "nope" })).toThrow(WebhookVerificationError);
    expect(() => xendit.parseWebhook(body, {})).toThrow(WebhookVerificationError);
  });
});

describe("rails from env", () => {
  it("offers only test keys, never exposes them", () => {
    const list = railEntries({ STRIPE_SECRET_KEY: "sk_live_secret", XENDIT_SECRET_KEY: "xnd_development_secret" }).map((e) => e.info);
    expect(list.find((r) => r.id === "stripe")).toMatchObject({ available: false, setup: expect.stringContaining("live keys are refused") });
    expect(list.find((r) => r.id === "xendit")).toMatchObject({ available: true, webhooks: false });
    expect(list.find((r) => r.id === "mock")!.available).toBe(true);
    expect(JSON.stringify(list)).not.toContain("secret");
  });
});
