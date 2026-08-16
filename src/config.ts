import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const port = Number(process.env.PORT ?? 3000);

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port,
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://payflow:payflow@localhost:5432/payflow",
  ),
  isDev: (process.env.NODE_ENV ?? "development") === "development",

  // Where the fake PSP delivers webhooks back to (our own receiver). On Render,
  // RENDER_EXTERNAL_URL is set automatically, so BASE_URL rarely needs setting.
  baseUrl:
    process.env.BASE_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    `http://localhost:${port}`,

  // Postgres over SSL — required by Supabase (and most managed Postgres). Auto-on
  // when the connection string points at Supabase, or force with PGSSL=true.
  pgSsl:
    process.env.PGSSL === "true" ||
    (process.env.DATABASE_URL ?? "").includes("supabase"),

  // Admin API key. When set, the fault/incident/simulation/admin endpoints require
  // header `x-admin-key: <key>`. Empty (dev) => gate disabled.
  adminApiKey: process.env.ADMIN_API_KEY ?? "",

  // CORS allow-origin for the JSON API (merchant app + dashboard). "*" for the lab.
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  // Apply db/schema.sql on startup (handy on hosts without a separate migrate step).
  autoMigrate: process.env.AUTO_MIGRATE === "true",

  // Webhook secrets. In the lab the fake PSP signs with these and the receiver
  // verifies with the same values. Stripe/Paystack use HMAC; Flutterwave uses a
  // static "verif-hash" secret compared directly.
  webhookSecrets: {
    stripe: process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_stripe_dev",
    paystack: process.env.PAYSTACK_WEBHOOK_SECRET ?? "sk_paystack_dev",
    flutterwave: process.env.FLUTTERWAVE_WEBHOOK_HASH ?? "flw_verif_dev",
    // Simulated providers share a generic HMAC secret in the lab.
    payfast: process.env.PAYFAST_WEBHOOK_SECRET ?? "pf_sim_dev",
    ozow: process.env.OZOW_WEBHOOK_SECRET ?? "ozow_sim_dev",
    peach: process.env.PEACH_WEBHOOK_SECRET ?? "peach_sim_dev",
    airtel: process.env.AIRTEL_WEBHOOK_SECRET ?? "airtel_sim_dev",
    mpesa: process.env.MPESA_WEBHOOK_SECRET ?? "mpesa_sim_dev",
    capitec: process.env.CAPITEC_WEBHOOK_SECRET ?? "capitec_sim_dev",
    default: "generic_sim_dev",
  } as Record<string, string>,

  // Real Paystack sandbox (Phase 4). Put your TEST secret key in .env as
  // PAYSTACK_SECRET_KEY (starts with sk_test_...). Empty => live checkout disabled.
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY ?? "",
    apiBaseUrl: process.env.PAYSTACK_API_URL ?? "https://api.paystack.co",
  },

  // Routing + retries (Phase 5).
  routing: {
    // rules | weighted | performance. Changeable at runtime via /api/v1/routing.
    defaultStrategy: (process.env.ROUTING_STRATEGY ?? "weighted") as
      | "rules"
      | "weighted"
      | "performance",
    // Base weights for weighted routing (only eligible providers are considered).
    weights: {
      stripe: 50,
      flutterwave: 30,
      paystack: 20,
      payfast: 25,
      ozow: 20,
      peach: 20,
      airtel: 15,
      mpesa: 25,
      capitec: 15,
    } as Record<string, number>,
    maxAttempts: Number(process.env.ROUTING_MAX_ATTEMPTS ?? 3),
    retryBackoffMs: Number(process.env.ROUTING_RETRY_BACKOFF_MS ?? 50),
    health: {
      windowMinutes: 15, // rolling window for success-rate calc
      minSamples: 20, // below this we treat a provider as "unknown = healthy"
      minSuccessRate: 0.5, // below this (with enough samples) => unhealthy
      refreshMs: 5000, // how often the health snapshot is recomputed
    },
  },

  // Reconciliation (Phase 6). The fake PSP's ledger is honest by default, but we
  // inject a little realistic "noise" so recon reports exercise every finding
  // type. Set RECON_NOISE=off to make the PSP ledger perfectly honest.
  recon: {
    injectNoise: (process.env.RECON_NOISE ?? "on") !== "off",
    noise: {
      amountMismatchRate: 0.01, // PSP records a slightly different amount
      duplicateRate: 0.005, // PSP writes the same charge twice
      phantomRate: 0.005, // PSP has a charge with no aggregator record
      amountDeltaMinor: 100, // size of the injected amount discrepancy
    },
  },
};
