import { MockRail } from "./mock";
import type { PaymentRail } from "./types";
import { StripeRail } from "./stripe";
import { XenditRail } from "./xendit";

/** What the studio's rail picker shows. Keys never leave the server. */
export interface RailInfo {
  id: "stripe" | "xendit" | "mock";
  label: string;
  note: string;
  available: boolean;
  /** Whether webhooks can be verified; without them Reeve polls the rail for payment status. */
  webhooks: boolean;
  /** When not available: what to add to reeve/.env. */
  setup?: string;
}

export interface RailEntry {
  info: RailInfo;
  create: () => PaymentRail;
}

const isTestStripe = (k?: string) => Boolean(k && /^(sk|rk)_test_/.test(k));
const isTestXendit = (k?: string) => Boolean(k?.startsWith("xnd_development_"));

export function railEntries(env: NodeJS.ProcessEnv = process.env): RailEntry[] {
  const stripeKey = env.STRIPE_SECRET_KEY?.trim();
  const xenditKey = env.XENDIT_SECRET_KEY?.trim();
  const mock = new MockRail();
  return [
    {
      info: {
        id: "stripe",
        label: "Stripe (test mode)",
        note: "Hosted invoice page, card payments. Test card 4242 4242 4242 4242.",
        available: isTestStripe(stripeKey),
        webhooks: Boolean(env.STRIPE_WEBHOOK_SECRET),
        ...(isTestStripe(stripeKey) ? {} : { setup: stripeKey ? "a test key (sk_test_…) in STRIPE_SECRET_KEY; live keys are refused" : "STRIPE_SECRET_KEY (sk_test_…)" }),
      },
      create: () => new StripeRail({ secretKey: stripeKey!, webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() }),
    },
    {
      info: {
        id: "xendit",
        label: "Xendit (test mode)",
        note: "Hosted payment link: virtual accounts, QRIS and e-wallets, in rupiah.",
        available: isTestXendit(xenditKey),
        webhooks: Boolean(env.XENDIT_WEBHOOK_TOKEN),
        ...(isTestXendit(xenditKey) ? {} : { setup: xenditKey ? "a development key (xnd_development_…) in XENDIT_SECRET_KEY; production keys are refused" : "XENDIT_SECRET_KEY (xnd_development_…)" }),
      },
      create: () => new XenditRail({ secretKey: xenditKey!, webhookToken: env.XENDIT_WEBHOOK_TOKEN?.trim() }),
    },
    {
      info: { id: "mock", label: "Offline rail", note: "No provider: invoices live in memory. For demos without a key.", available: true, webhooks: true },
      create: () => mock,
    },
  ];
}
