import { query, withTransaction } from "../db/pool.js";
import { logger } from "../logger.js";

// Reconciliation compares OUR ledger (transactions) against the PSP's ledger
// (psp_ledger) over a time window and reports every disagreement. This is the
// core payment-ops skill: catching cases where the two systems don't agree.

export type FindingType =
  | "STATUS_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "MISSING_AT_PSP"
  | "MISSING_IN_AGGREGATOR"
  | "DUPLICATE";

interface Finding {
  type: FindingType;
  aggregatorReference: string | null;
  provider: string | null;
  providerReference: string | null;
  ourStatus: string | null;
  pspStatus: string | null;
  ourAmount: number | null;
  pspAmount: number | null;
  detail: Record<string, unknown>;
}

interface OurRow {
  aggregator_reference: string;
  provider: string;
  provider_reference: string;
  status: string;
  amount: string;
}
interface PspRow {
  provider: string;
  provider_reference: string;
  aggregator_reference: string | null;
  status: string;
  amount: string;
}

export interface ReconSummary {
  runId: number;
  windowMinutes: number;
  checked: number;
  matched: number;
  counts: Record<FindingType, number>;
}

const key = (provider: string, ref: string) => `${provider}|${ref}`;

// Do our final status and the PSP's status describe the same money outcome?
// Anything still in flight on our side (pending/processing) disagrees with a
// terminal PSP status by definition — that's the money-received-but-not-recorded
// case we most want to catch.
function statusAgrees(ourStatus: string, pspStatus: string): boolean {
  if (ourStatus === "pending" || ourStatus === "processing") return false;
  if (ourStatus === "refunded") return pspStatus === "success"; // refunded implies it had succeeded
  return ourStatus === pspStatus;
}

export async function runReconciliation(windowMinutes = 60): Promise<ReconSummary> {
  const ours = await query<OurRow>(
    `SELECT aggregator_reference, provider, provider_reference, status, amount
       FROM transactions
      WHERE provider_reference IS NOT NULL
        AND created_at > now() - make_interval(mins => $1)`,
    [windowMinutes],
  );
  const psp = await query<PspRow>(
    `SELECT provider, provider_reference, aggregator_reference, status, amount
       FROM psp_ledger
      WHERE created_at > now() - make_interval(mins => $1)`,
    [windowMinutes],
  );

  // Index the PSP side by (provider, reference); a key may hold multiple rows.
  const pspByKey = new Map<string, PspRow[]>();
  for (const r of psp.rows) {
    const k = key(r.provider, r.provider_reference);
    (pspByKey.get(k) ?? pspByKey.set(k, []).get(k)!).push(r);
  }

  const findings: Finding[] = [];
  const seenKeys = new Set<string>();
  let matched = 0;

  for (const o of ours.rows) {
    const k = key(o.provider, o.provider_reference);
    seenKeys.add(k);
    const pspRows = pspByKey.get(k);
    const ourAmount = Number(o.amount);

    if (!pspRows || pspRows.length === 0) {
      // We attempted at a PSP and think it succeeded / is still pending, but the
      // PSP has no record. (A failed/declined txn with no PSP row is consistent.)
      if (o.status === "success" || o.status === "pending") {
        findings.push({
          type: "MISSING_AT_PSP",
          aggregatorReference: o.aggregator_reference,
          provider: o.provider,
          providerReference: o.provider_reference,
          ourStatus: o.status,
          pspStatus: null,
          ourAmount,
          pspAmount: null,
          detail: {},
        });
      }
      continue;
    }

    if (pspRows.length > 1) {
      findings.push({
        type: "DUPLICATE",
        aggregatorReference: o.aggregator_reference,
        provider: o.provider,
        providerReference: o.provider_reference,
        ourStatus: o.status,
        pspStatus: pspRows[0].status,
        ourAmount,
        pspAmount: Number(pspRows[0].amount),
        detail: { pspRowCount: pspRows.length },
      });
    }

    const p = pspRows[0];
    const pspAmount = Number(p.amount);
    let clean = true;

    if (!statusAgrees(o.status, p.status)) {
      clean = false;
      findings.push({
        type: "STATUS_MISMATCH",
        aggregatorReference: o.aggregator_reference,
        provider: o.provider,
        providerReference: o.provider_reference,
        ourStatus: o.status,
        pspStatus: p.status,
        ourAmount,
        pspAmount,
        detail: {},
      });
    }
    if (ourAmount !== pspAmount) {
      clean = false;
      findings.push({
        type: "AMOUNT_MISMATCH",
        aggregatorReference: o.aggregator_reference,
        provider: o.provider,
        providerReference: o.provider_reference,
        ourStatus: o.status,
        pspStatus: p.status,
        ourAmount,
        pspAmount,
        detail: { deltaMinor: pspAmount - ourAmount },
      });
    }
    if (clean && pspRows.length === 1) matched += 1;
  }

  // PSP rows we never matched to any of our transactions.
  for (const [k, rows] of pspByKey) {
    if (seenKeys.has(k)) continue;
    for (const r of rows) {
      findings.push({
        type: "MISSING_IN_AGGREGATOR",
        aggregatorReference: r.aggregator_reference,
        provider: r.provider,
        providerReference: r.provider_reference,
        ourStatus: null,
        pspStatus: r.status,
        ourAmount: null,
        pspAmount: Number(r.amount),
        detail: {},
      });
    }
  }

  const counts: Record<FindingType, number> = {
    STATUS_MISMATCH: 0,
    AMOUNT_MISMATCH: 0,
    MISSING_AT_PSP: 0,
    MISSING_IN_AGGREGATOR: 0,
    DUPLICATE: 0,
  };
  for (const f of findings) counts[f.type] += 1;

  // Persist the run and its findings together.
  const runId = await withTransaction(async (client) => {
    const run = await client.query(
      `INSERT INTO reconciliation_runs (window_minutes, checked, matched, summary, finished_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       RETURNING id`,
      [windowMinutes, ours.rowCount, matched, JSON.stringify(counts)],
    );
    const id = Number(run.rows[0].id);
    for (const f of findings) {
      await client.query(
        `INSERT INTO reconciliation_findings
           (run_id, type, aggregator_reference, provider, provider_reference,
            our_status, psp_status, our_amount, psp_amount, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          id,
          f.type,
          f.aggregatorReference,
          f.provider,
          f.providerReference,
          f.ourStatus,
          f.pspStatus,
          f.ourAmount,
          f.pspAmount,
          JSON.stringify(f.detail),
        ],
      );
    }
    return id;
  });

  logger.info({ runId, checked: ours.rowCount, matched, counts }, "reconciliation complete");
  return { runId, windowMinutes, checked: ours.rowCount ?? 0, matched, counts };
}

export async function getReconRun(runId: number) {
  const run = await query(
    `SELECT * FROM reconciliation_runs WHERE id = $1`,
    [runId],
  );
  if (!run.rowCount) return null;
  const findings = await query(
    `SELECT type, aggregator_reference, provider, provider_reference,
            our_status, psp_status, our_amount, psp_amount, detail
       FROM reconciliation_findings
      WHERE run_id = $1
      ORDER BY type, id`,
    [runId],
  );
  return { run: run.rows[0], findings: findings.rows };
}

export async function listReconRuns() {
  const runs = await query(
    `SELECT id, window_minutes, checked, matched, summary, started_at, finished_at
       FROM reconciliation_runs ORDER BY id DESC LIMIT 50`,
  );
  return runs.rows;
}
