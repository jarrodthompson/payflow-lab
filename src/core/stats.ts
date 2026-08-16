import { query } from "../db/pool.js";

// Aggregate views over the transactions table. This is the raw material for the
// operations dashboard (Phase 7) and is handy right now to see the distribution
// the simulator produces.

export interface StatusCounts {
  [status: string]: number;
}

export interface ProviderPerformance {
  provider: string;
  transactions: number;
  successful: number;
  successRate: number; // 0..1
  valueMinor: number; // total amount in minor units
}

export interface OverviewStats {
  totals: {
    transactions: number;
    successful: number;
    declined: number;
    failed: number;
    pending: number;
    processing: number;
    approvalRate: number; // successful / (transactions that reached a decision)
    valueMinor: number; // sum of successful amounts, minor units
  };
  byStatus: StatusCounts;
  byProvider: ProviderPerformance[];
}

export async function getOverview(): Promise<OverviewStats> {
  const statusRows = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::int AS count FROM transactions GROUP BY status`,
  );
  const byStatus: StatusCounts = {};
  for (const r of statusRows.rows) byStatus[r.status] = Number(r.count);

  const get = (s: string) => byStatus[s] ?? 0;
  const transactions = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const successful = get("success");
  const declined = get("declined");
  const failed = get("failed");
  const pending = get("pending");
  const processing = get("processing");
  // Approval rate = successes over payments that reached a final decision
  // (success + declined + failed). Pending/processing are still in flight.
  const decided = successful + declined + failed;
  const approvalRate = decided > 0 ? successful / decided : 0;

  const valueRow = await query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS sum
       FROM transactions WHERE status = 'success'`,
  );
  const valueMinor = Number(valueRow.rows[0]?.sum ?? 0);

  const providerRows = await query<{
    provider: string;
    transactions: string;
    successful: string;
    value_minor: string;
  }>(
    `SELECT provider,
            COUNT(*)::int AS transactions,
            COUNT(*) FILTER (WHERE status = 'success')::int AS successful,
            COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0)::bigint AS value_minor
       FROM transactions
      WHERE provider IS NOT NULL
      GROUP BY provider
      ORDER BY provider`,
  );
  const byProvider: ProviderPerformance[] = providerRows.rows.map((r) => {
    const t = Number(r.transactions);
    const s = Number(r.successful);
    return {
      provider: r.provider,
      transactions: t,
      successful: s,
      successRate: t > 0 ? s / t : 0,
      valueMinor: Number(r.value_minor),
    };
  });

  return {
    totals: {
      transactions,
      successful,
      declined,
      failed,
      pending,
      processing,
      approvalRate,
      valueMinor,
    },
    byStatus,
    byProvider,
  };
}
