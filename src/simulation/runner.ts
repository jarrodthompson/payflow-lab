import { randomInt, randomUUID } from "node:crypto";
import { createPayment } from "../core/txn-manager.js";
import { logger } from "../logger.js";

// Traffic mix as (currency, method) combos, chosen so routing spreads across the
// whole PSP roster: SA cards/EFT/pay-by-bank, West-African cards, and East/Central
// African mobile money. The router picks the actual provider from capabilities.
const TRAFFIC: { currency: string; method: string; weight: number }[] = [
  { currency: "USD", method: "card", weight: 22 }, // stripe/paystack/flutterwave/peach
  { currency: "ZAR", method: "card", weight: 16 }, // stripe/payfast/paystack/flutterwave/peach
  { currency: "ZAR", method: "bank_transfer", weight: 14 }, // payfast/ozow/paystack/flutterwave/capitec
  { currency: "ZAR", method: "wallet", weight: 5 }, // capitec
  { currency: "NGN", method: "card", weight: 12 }, // paystack/flutterwave
  { currency: "GHS", method: "card", weight: 5 }, // paystack/flutterwave
  { currency: "KES", method: "mobile_money", weight: 12 }, // flutterwave/peach/airtel/mpesa
  { currency: "KES", method: "card", weight: 4 }, // peach/flutterwave
  { currency: "TZS", method: "mobile_money", weight: 6 }, // airtel/mpesa
  { currency: "UGX", method: "mobile_money", weight: 4 }, // airtel
];

// Amounts in MINOR units: R50, R100, R250, R500, R1,000, R5,000.
const AMOUNTS = [5000, 10000, 25000, 50000, 100000, 500000];

const MERCHANTS = ["MERCHANT_001", "MERCHANT_002", "MERCHANT_003"];

function weightedTraffic(): { currency: string; method: string } {
  const total = TRAFFIC.reduce((s, c) => s + c.weight, 0);
  let roll = randomInt(0, total);
  for (const c of TRAFFIC) {
    if (roll < c.weight) return { currency: c.currency, method: c.method };
    roll -= c.weight;
  }
  return { currency: TRAFFIC[0].currency, method: TRAFFIC[0].method };
}

function pick<T>(arr: T[]): T {
  return arr[randomInt(0, arr.length)];
}

export interface RunState {
  id: string;
  requested: number;
  transactionsPerSecond: number;
  created: number;
  errors: number;
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  status: "running" | "completed" | "error";
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
}

// In-memory registry of simulation runs. Fine for a single-process learning lab;
// a real system would persist these.
const runs = new Map<string, RunState>();

export function getRun(id: string): RunState | undefined {
  return runs.get(id);
}

export function listRuns(): RunState[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function generateOne(state: RunState): Promise<void> {
  try {
    const traffic = weightedTraffic();
    const { transaction } = await createPayment({
      merchantId: pick(MERCHANTS),
      merchantReference: `ORDER-${randomUUID().slice(0, 8)}`,
      amount: pick(AMOUNTS),
      currency: traffic.currency,
      paymentMethod: traffic.method,
      customerEmail: `customer${randomInt(1, 100000)}@example.com`,
    });
    state.created += 1;
    state.byStatus[transaction.status] = (state.byStatus[transaction.status] ?? 0) + 1;
    if (transaction.provider) {
      state.byProvider[transaction.provider] =
        (state.byProvider[transaction.provider] ?? 0) + 1;
    }
  } catch (err) {
    state.errors += 1;
    logger.error({ err }, "simulation: failed to generate a payment");
  }
}

// Paces generation into ~10 ticks per second to approximate the target TPS,
// without blocking the HTTP response. Returns the initial run state immediately.
export function startRun(requested: number, transactionsPerSecond: number): RunState {
  const id = `SIM_${randomUUID().slice(0, 8)}`;
  const state: RunState = {
    id,
    requested,
    transactionsPerSecond,
    created: 0,
    errors: 0,
    byStatus: {},
    byProvider: {},
    status: "running",
    startedAt: new Date().toISOString(),
  };
  runs.set(id, state);

  const ticksPerSecond = 10;
  const perTick = Math.max(1, Math.round(transactionsPerSecond / ticksPerSecond));
  const tickMs = 1000 / ticksPerSecond;

  const runLoop = async () => {
    try {
      while (state.created + state.errors < requested) {
        const remaining = requested - (state.created + state.errors);
        const batchSize = Math.min(perTick, remaining);
        const batch = Array.from({ length: batchSize }, () => generateOne(state));
        const started = Date.now();
        await Promise.all(batch);
        const elapsed = Date.now() - started;
        const wait = Math.max(0, tickMs - elapsed);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      state.status = "completed";
      state.finishedAt = new Date().toISOString();
      logger.info(
        { runId: id, created: state.created, errors: state.errors },
        "simulation run completed",
      );
    } catch (err) {
      state.status = "error";
      state.finishedAt = new Date().toISOString();
      state.errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, runId: id }, "simulation run failed");
    }
  };

  void runLoop();
  return state;
}
