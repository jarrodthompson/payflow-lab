import { query } from "../db/pool.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Provider } from "./types.js";

// A cached, rolling view of each provider's recent health. Performance-based
// routing reads this instead of hitting the DB on every payment. A real payment
// orchestrator caches provider metrics the same way.
export interface ProviderHealth {
  provider: Provider;
  decided: number; // payments that reached a decision in the window
  success: number;
  successRate: number | null; // null when we don't have enough samples yet
  healthy: boolean; // false only when we have enough samples AND rate is low
}

const PROVIDERS: Provider[] = [
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
const { minSamples, minSuccessRate, windowMinutes, refreshMs } = config.routing.health;

let snapshot: Record<Provider, ProviderHealth> = emptySnapshot();

function emptySnapshot(): Record<Provider, ProviderHealth> {
  return Object.fromEntries(
    PROVIDERS.map((p) => [
      p,
      { provider: p, decided: 0, success: 0, successRate: null, healthy: true },
    ]),
  ) as Record<Provider, ProviderHealth>;
}

// Returns true on success, false on failure — the monitor uses this to back off
// so a DB problem doesn't hammer the connection (which would keep a pooler
// circuit breaker permanently tripped).
export async function refreshHealth(): Promise<boolean> {
  try {
    const rows = await query<{ provider: string; decided: string; success: string }>(
      `SELECT provider,
              COUNT(*) FILTER (WHERE status IN ('success','declined','failed'))::int AS decided,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success
         FROM transactions
        WHERE provider IS NOT NULL
          AND created_at > now() - make_interval(mins => $1)
        GROUP BY provider`,
      [windowMinutes],
    );

    const next = emptySnapshot();
    for (const r of rows.rows) {
      const provider = r.provider as Provider;
      if (!next[provider]) continue;
      const decided = Number(r.decided);
      const success = Number(r.success);
      const successRate = decided > 0 ? success / decided : null;
      // Unknown (too few samples) is treated as healthy so we don't exclude a
      // provider just because it's quiet. Only a proven-bad rate marks it down.
      const healthy =
        decided < minSamples || (successRate ?? 1) >= minSuccessRate;
      next[provider] = { provider, decided, success, successRate, healthy };
    }
    snapshot = next;
    return true;
  } catch (err) {
    logger.warn({ err }, "provider-health refresh failed; keeping last snapshot");
    return false;
  }
}

export function getHealth(provider: Provider): ProviderHealth {
  return snapshot[provider];
}

export function getAllHealth(): ProviderHealth[] {
  return PROVIDERS.map((p) => snapshot[p]);
}

export function isHealthy(provider: Provider): boolean {
  return snapshot[provider]?.healthy ?? true;
}

let timer: ReturnType<typeof setTimeout> | undefined;
const MAX_DELAY = 60_000; // back off up to 60s when the DB is unreachable

// Self-scheduling refresh loop with exponential backoff on failure. On success
// it runs every refreshMs; on repeated failure it slows down (5s → 10s → … → 60s)
// so a DB outage / tripped pooler breaker gets quiet time to recover instead of
// being hammered every 5 seconds.
export function startHealthMonitor(): void {
  let delay = refreshMs;
  const tick = async () => {
    const ok = await refreshHealth();
    delay = ok ? refreshMs : Math.min(delay * 2, MAX_DELAY);
    timer = setTimeout(() => void tick(), delay);
    timer.unref?.();
  };
  void tick();
}
