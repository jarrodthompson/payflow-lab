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

export async function refreshHealth(): Promise<void> {
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
  } catch (err) {
    logger.warn({ err }, "provider-health refresh failed; keeping last snapshot");
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

let timer: NodeJS.Timeout | undefined;

// Start periodic refresh. Called once from server startup.
export function startHealthMonitor(): void {
  void refreshHealth();
  timer = setInterval(() => void refreshHealth(), refreshMs);
  timer.unref?.();
}
