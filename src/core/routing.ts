import { randomInt } from "node:crypto";
import { config } from "../config.js";
import type { Provider } from "./types.js";
import { getHealth, isHealthy } from "./provider-health.js";

export type RoutingStrategy = "rules" | "weighted" | "performance";

// What each provider can handle — currencies AND payment methods. For a given
// (currency, method) only some providers are ELIGIBLE, which is what makes
// routing a real decision (e.g. M-Pesa only does mobile money in KES/TZS).
interface Capability {
  currencies: Set<string>;
  methods: Set<string>;
}
const cap = (currencies: string[], methods: string[]): Capability => ({
  currencies: new Set(currencies),
  methods: new Set(methods),
});

const CAPABILITIES: Record<Provider, Capability> = {
  stripe: cap(["USD", "EUR", "GBP", "ZAR"], ["card"]),
  paystack: cap(["NGN", "GHS", "ZAR", "USD"], ["card", "bank_transfer"]),
  flutterwave: cap(["NGN", "KES", "GHS", "ZAR", "USD"], ["card", "mobile_money", "bank_transfer"]),
  // South African instant EFT / pay-by-bank / card
  payfast: cap(["ZAR"], ["card", "bank_transfer"]),
  ozow: cap(["ZAR"], ["bank_transfer"]),
  // Pan-African card + mobile money
  peach: cap(["ZAR", "USD", "KES"], ["card", "mobile_money"]),
  // Mobile money across East/Central Africa
  airtel: cap(["KES", "UGX", "TZS"], ["mobile_money"]),
  mpesa: cap(["KES", "TZS"], ["mobile_money"]),
  // Capitec Pay — SA pay-by-bank / wallet
  capitec: cap(["ZAR"], ["bank_transfer", "wallet"]),
};

const ALL: Provider[] = [
  "stripe",
  "paystack",
  "flutterwave",
  "payfast",
  "ozow",
  "peach",
  "airtel",
  "mpesa",
  "capitec",
];
const weights = config.routing.weights;

// Runtime-changeable strategy (see /api/v1/routing), seeded from config.
let currentStrategy: RoutingStrategy = config.routing.defaultStrategy;
export const getStrategy = (): RoutingStrategy => currentStrategy;
export const setStrategy = (s: RoutingStrategy): void => {
  currentStrategy = s;
};

export const getCapabilities = () =>
  Object.fromEntries(
    ALL.map((p) => [
      p,
      {
        currencies: [...CAPABILITIES[p].currencies],
        methods: [...CAPABILITIES[p].methods],
      },
    ]),
  );

// Providers that support BOTH the currency and the method. Falls back to
// currency-only, then to a single default, so a payment always routes somewhere.
export function eligibleProviders(currency: string, method = "card"): Provider[] {
  const cur = currency.toUpperCase();
  const both = ALL.filter(
    (p) => CAPABILITIES[p].currencies.has(cur) && CAPABILITIES[p].methods.has(method),
  );
  if (both.length > 0) return both;
  const byCurrency = ALL.filter((p) => CAPABILITIES[p].currencies.has(cur));
  return byCurrency.length > 0 ? byCurrency : ["stripe"];
}

// Produce a full ordering of `items` by repeatedly picking one at random in
// proportion to weight(item), without replacement. The first element is the
// primary; the rest form the failover order.
function weightedShuffle<T>(items: T[], weight: (item: T) => number): T[] {
  const pool = [...items];
  const ordered: T[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((s, it) => s + Math.max(weight(it), 0.0001), 0);
    let roll = (randomInt(0, 1_000_000) / 1_000_000) * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      roll -= Math.max(weight(pool[i]), 0.0001);
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    ordered.push(pool.splice(idx, 1)[0]);
  }
  return ordered;
}

export interface RouteResult {
  strategy: RoutingStrategy;
  eligible: Provider[];
  candidates: Provider[]; // ordered: primary first, then failover order
}

// Decide how to route a payment. Returns the eligible set and an ordered
// candidate list the caller uses for the primary attempt and any failovers.
export function routePayment(input: {
  currency: string;
  paymentMethod?: string;
}): RouteResult {
  const strategy = currentStrategy;
  const eligible = eligibleProviders(input.currency, input.paymentMethod ?? "card");

  let candidates: Provider[];
  switch (strategy) {
    case "rules":
      // Deterministic priority by base weight (highest first).
      candidates = [...eligible].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));
      break;

    case "performance": {
      // Prefer healthy providers, ordered by a blend of success rate and base
      // weight; unhealthy eligible providers go last as a last resort.
      const healthy = eligible.filter(isHealthy);
      const pool = healthy.length > 0 ? healthy : eligible;
      const perfWeight = (p: Provider) => {
        const rate = getHealth(p).successRate ?? 0.85; // assume decent when unknown
        return rate * (weights[p] ?? 1);
      };
      const primaryOrder = weightedShuffle(pool, perfWeight);
      const rest = eligible.filter((p) => !primaryOrder.includes(p));
      candidates = [...primaryOrder, ...rest];
      break;
    }

    case "weighted":
    default:
      candidates = weightedShuffle(eligible, (p) => weights[p] ?? 1);
      break;
  }

  return { strategy, eligible, candidates };
}
