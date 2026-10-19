/**
 * Payment rail abstraction. Generated SOP code and the Operator call this interface,
 * never a provider SDK directly, so Stripe (hackathon / international) and
 * Xendit or Midtrans (Indonesia: VA, QRIS, e-wallets, payouts) are interchangeable.
 * Only the broker holds real provider keys.
 *
 * Amounts are whole rupiah everywhere in Reeve; each adapter converts to its provider's unit.
 */

export * from "./types";

export { MockRail } from "./mock";
export { StripeRail, type StripeRailOptions } from "./stripe";
export { XenditRail, type XenditRailOptions } from "./xendit";
export { railEntries, type RailEntry, type RailInfo } from "./env";
