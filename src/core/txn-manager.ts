import { createHash } from "node:crypto";
import type pg from "pg";
import { withTransaction, query } from "../db/pool.js";
import { conflict, notFound } from "./errors.js";
import { generateAggregatorReference } from "./reference.js";
import { routePayment } from "./routing.js";
import { rowToTransaction } from "./mapper.js";
import { assertTransition } from "./state-machine.js";
import { getProvider } from "../providers/registry.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { PaymentStatus, Provider, Transaction } from "./types.js";

export interface CreatePaymentInput {
  merchantId: string;
  merchantReference?: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  customerEmail?: string;
  idempotencyKey?: string;
}

// Stable hash of the semantically meaningful request fields. Used to detect
// when the same idempotency key is reused with a DIFFERENT payload.
function hashRequest(input: CreatePaymentInput): string {
  const canonical = JSON.stringify({
    merchantId: input.merchantId,
    amount: input.amount,
    currency: input.currency.toUpperCase(),
    paymentMethod: input.paymentMethod,
    customerEmail: input.customerEmail ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function recordEvent(
  client: pg.PoolClient,
  transactionId: number,
  type: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO payment_events (transaction_id, type, detail)
     VALUES ($1, $2, $3::jsonb)`,
    [transactionId, type, JSON.stringify(detail)],
  );
}

// Same as recordEvent but on the shared pool (no open transaction required).
// Used while talking to a PSP, which we deliberately do OUTSIDE a DB transaction,
// and by the webhook processor. Exported as recordPaymentEvent.
export async function recordPaymentEvent(
  transactionId: number,
  type: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `INSERT INTO payment_events (transaction_id, type, detail)
     VALUES ($1, $2, $3::jsonb)`,
    [transactionId, type, JSON.stringify(detail)],
  );
}
const recordEventPool = recordPaymentEvent;

// Look up a payment by the PSP's own reference. Used by the webhook receiver to
// match an inbound event to the transaction it belongs to.
export async function getByProviderReference(
  provider: string,
  providerReference: string,
): Promise<Transaction | null> {
  const result = await query(
    `SELECT * FROM transactions WHERE provider = $1 AND provider_reference = $2`,
    [provider, providerReference],
  );
  return result.rowCount ? rowToTransaction(result.rows[0]) : null;
}

export interface CreatePaymentResult {
  transaction: Transaction;
  idempotentReplay: boolean; // true when we returned an existing payment
}

/**
 * Create a payment. If an idempotency key is supplied and already seen for this
 * merchant, the original transaction is returned instead of creating a new one
 * (a replay). Reusing a key with a different body is a 409 conflict.
 */
export async function createPayment(
  input: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  const requestHash = hashRequest(input);

  const created = await withTransaction(async (client) => {
    // --- Idempotency check ------------------------------------------------
    if (input.idempotencyKey) {
      const existing = await client.query(
        `SELECT k.request_hash, t.*
           FROM idempotency_keys k
           JOIN transactions t ON t.id = k.transaction_id
          WHERE k.merchant_id = $1 AND k.idem_key = $2`,
        [input.merchantId, input.idempotencyKey],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row.request_hash !== requestHash) {
          throw conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used with a different request body.",
          );
        }
        return {
          transaction: rowToTransaction(row),
          idempotentReplay: true,
          candidates: [] as Provider[],
        };
      }
    }

    // --- Routing decision -------------------------------------------------
    // The router returns an ordered candidate list: candidates[0] is the primary
    // and the rest are the failover order used by the retry loop.
    const route = routePayment({
      currency: input.currency,
      paymentMethod: input.paymentMethod,
    });
    const provider = route.candidates[0];

    // --- Insert the transaction (status: processing) ----------------------
    const aggregatorReference = generateAggregatorReference();
    const inserted = await client.query(
      `INSERT INTO transactions
         (aggregator_reference, merchant_id, merchant_reference, provider,
          payment_method, amount, currency, customer_email, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing')
       RETURNING *`,
      [
        aggregatorReference,
        input.merchantId,
        input.merchantReference ?? null,
        provider,
        input.paymentMethod,
        input.amount,
        input.currency.toUpperCase(),
        input.customerEmail ?? null,
      ],
    );
    const txn = rowToTransaction(inserted.rows[0]);

    await recordEvent(client, txn.id, "PAYMENT_CREATED", {
      amount: txn.amount,
      currency: txn.currency,
    });
    await recordEvent(client, txn.id, "ROUTING_DECISION", {
      strategy: route.strategy,
      eligible: route.eligible,
      candidates: route.candidates,
      chosen: provider,
    });
    await recordEvent(client, txn.id, "STATUS_CHANGED", { status: "processing" });

    // --- Persist the idempotency key --------------------------------------
    if (input.idempotencyKey) {
      await client.query(
        `INSERT INTO idempotency_keys
           (merchant_id, idem_key, request_hash, transaction_id)
         VALUES ($1, $2, $3, $4)`,
        [input.merchantId, input.idempotencyKey, requestHash, txn.id],
      );
    }

    return { transaction: txn, idempotentReplay: false, candidates: route.candidates };
  });

  // An idempotent replay returns the stored payment untouched — do NOT re-charge.
  if (created.idempotentReplay) {
    return { transaction: created.transaction, idempotentReplay: true };
  }

  // Hand the freshly-created (status: processing) payment to the retry/failover
  // loop, which drives it to a final state. Done outside the DB transaction
  // above so we never hold a row/connection open across a provider call.
  const settled = await processPayment(created.transaction, created.candidates);
  return { transaction: settled, idempotentReplay: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A synchronous technical failure is retryable; a business decline or a
// webhook-bound outcome is not.
function isRetryable(failureCode?: string): boolean {
  return failureCode === "PSP_TIMEOUT" || failureCode === "PSP_ERROR";
}

/**
 * Drive a `processing` payment to a final state, attempting each candidate
 * provider in order until one accepts it or we run out of attempts.
 *
 * Key behaviors (the Phase 5 orchestration lessons):
 *  - Failover: a technical failure (timeout / provider error) rolls to the next
 *    eligible provider, up to config.routing.maxAttempts, with backoff.
 *  - Verify-before-retry: on a TIMEOUT we don't know if the charge went through,
 *    so we call verify() first — if it actually succeeded, we stop (never
 *    double-charge). Only a confirmed non-success proceeds to failover.
 *  - Async: an accepted attempt returns `pending`; the terminal outcome arrives
 *    later via that provider's webhook.
 */
export async function processPayment(
  txn: Transaction,
  candidates?: Provider[],
): Promise<Transaction> {
  if (!txn.provider) {
    throw new Error(`Transaction ${txn.id} has no provider to process with`);
  }
  const order = candidates && candidates.length > 0 ? candidates : [txn.provider as Provider];
  const maxAttempts = Math.min(config.routing.maxAttempts, order.length);
  let currentProvider = txn.provider as Provider;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const provider = order[attempt];

    // On failover, repoint the transaction at the new provider so any webhook
    // it schedules matches by (provider, provider_reference).
    if (provider !== currentProvider) {
      await query(
        `UPDATE transactions SET provider = $2, updated_at = now() WHERE id = $1`,
        [txn.id, provider],
      );
      await recordEventPool(txn.id, "ROUTING_FAILOVER", {
        from: currentProvider,
        to: provider,
        attempt,
      });
      currentProvider = provider;
    }

    await recordEventPool(txn.id, "PSP_REQUEST_SENT", { provider, attempt });
    const result = await getProvider(provider).initiatePayment({
      ...txn,
      provider,
    });
    await recordEventPool(txn.id, "PSP_RESPONSE_RECEIVED", {
      provider,
      attempt,
      status: result.status,
      failureCode: result.failureCode ?? null,
      latencyMs: result.latencyMs,
      providerReference: result.providerReference,
    });

    // Verify-before-retry: a timeout leaves the true outcome unknown.
    if (result.status === "failed" && result.failureCode === "PSP_TIMEOUT") {
      await recordEventPool(txn.id, "RETRY_VERIFY", {
        provider,
        providerReference: result.providerReference,
      });
      const verified = await getProvider(provider).verifyPayment(
        result.providerReference,
      );
      await recordEventPool(txn.id, "VERIFY_RESULT", { status: verified.status });
      if (verified.status === "success") {
        // It actually went through — settle as success, do NOT retry.
        return transitionStatus(txn.id, "success", {
          providerReference: result.providerReference,
        });
      }
    }

    const canFailover = isRetryable(result.failureCode) && attempt < maxAttempts - 1;
    if (canFailover) {
      const backoff = config.routing.retryBackoffMs * 2 ** attempt;
      await recordEventPool(txn.id, "RETRY_SCHEDULED", {
        reason: result.failureCode,
        nextProvider: order[attempt + 1],
        backoffMs: backoff,
      });
      await sleep(backoff);
      continue;
    }

    // Accepted (`pending`) or a final failure with no failover left.
    return transitionStatus(txn.id, result.status, {
      failureCode: result.failureCode,
      failureMessage: result.failureMessage,
      providerReference: result.providerReference,
    });
  }

  // Should be unreachable (last attempt always returns), but keep TS happy.
  logger.warn({ txn: txn.aggregatorReference }, "processPayment exhausted attempts");
  return getPaymentByReference(txn.aggregatorReference);
}

export interface ListFilters {
  status?: string;
  provider?: string;
  currency?: string;
  merchantId?: string;
  limit?: number;
  offset?: number;
}

// Paginated, filterable transaction list for the dashboard.
export async function listPayments(
  filters: ListFilters,
): Promise<{ items: Transaction[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.status) {
    clauses.push(`status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.provider) {
    clauses.push(`provider = $${i++}`);
    params.push(filters.provider);
  }
  if (filters.currency) {
    clauses.push(`currency = $${i++}`);
    params.push(filters.currency.toUpperCase());
  }
  if (filters.merchantId) {
    clauses.push(`merchant_id = $${i++}`);
    params.push(filters.merchantId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const totalRes = await query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM transactions ${where}`,
    params,
  );
  const total = Number(totalRes.rows[0]?.count ?? 0);

  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const items = await query(
    `SELECT * FROM transactions ${where} ORDER BY id DESC LIMIT $${i++} OFFSET $${i++}`,
    [...params, limit, offset],
  );
  return { items: items.rows.map(rowToTransaction), total };
}

export async function getPaymentByReference(
  aggregatorReference: string,
): Promise<Transaction> {
  const result = await query(
    `SELECT * FROM transactions WHERE aggregator_reference = $1`,
    [aggregatorReference],
  );
  if (!result.rowCount) {
    throw notFound(`No payment with reference ${aggregatorReference}`);
  }
  return rowToTransaction(result.rows[0]);
}

export interface PaymentEvent {
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface EventLogFilters {
  type?: string;
  reference?: string; // aggregator reference (partial match)
  provider?: string;
  sinceMinutes?: number;
  limit?: number;
}

export interface EventLogRow {
  createdAt: string;
  type: string;
  aggregatorReference: string;
  provider: string | null;
  status: string;
  detail: Record<string, unknown>;
}

// Cross-transaction event-log search — the "log console" for investigating
// incidents (filter by type, reference, provider, time window). This is the
// searchable transaction log a specialist lives in during an incident.
export async function searchEvents(
  filters: EventLogFilters,
): Promise<{ items: EventLogRow[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filters.type) {
    clauses.push(`e.type = $${i++}`);
    params.push(filters.type);
  }
  if (filters.reference) {
    clauses.push(`t.aggregator_reference ILIKE $${i++}`);
    params.push(`%${filters.reference}%`);
  }
  if (filters.provider) {
    clauses.push(`t.provider = $${i++}`);
    params.push(filters.provider);
  }
  if (filters.sinceMinutes) {
    clauses.push(`e.created_at > now() - make_interval(mins => $${i++})`);
    params.push(filters.sinceMinutes);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

  const rows = await query(
    `SELECT e.created_at, e.type, e.detail,
            t.aggregator_reference, t.provider, t.status
       FROM payment_events e
       JOIN transactions t ON t.id = e.transaction_id
       ${where}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${i++}`,
    [...params, limit],
  );
  return {
    total: rows.rowCount ?? 0,
    items: rows.rows.map((r) => ({
      createdAt:
        r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      type: r.type,
      aggregatorReference: r.aggregator_reference,
      provider: r.provider,
      status: r.status,
      detail: r.detail,
    })),
  };
}

export async function getPaymentTimeline(
  aggregatorReference: string,
): Promise<PaymentEvent[]> {
  const txn = await getPaymentByReference(aggregatorReference);
  const result = await query(
    `SELECT type, detail, created_at
       FROM payment_events
      WHERE transaction_id = $1
      ORDER BY created_at ASC, id ASC`,
    [txn.id],
  );
  return result.rows.map((r) => ({
    type: r.type,
    detail: r.detail,
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  }));
}

/**
 * Transition a transaction to a new status, enforcing the state machine.
 * Exposed now so later phases (PSP responses, webhooks) have a single, safe
 * entry point for status changes. Not yet wired to an HTTP route.
 */
export async function transitionStatus(
  transactionId: number,
  to: PaymentStatus,
  opts: { failureCode?: string; failureMessage?: string; providerReference?: string } = {},
): Promise<Transaction> {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
      [transactionId],
    );
    if (!current.rowCount) {
      throw notFound(`No transaction with id ${transactionId}`);
    }
    const from = current.rows[0].status as PaymentStatus;
    assertTransition(from, to); // throws IllegalTransitionError if not allowed

    const updated = await client.query(
      `UPDATE transactions
          SET status = $2,
              failure_code = COALESCE($3, failure_code),
              failure_message = COALESCE($4, failure_message),
              provider_reference = COALESCE($5, provider_reference),
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [
        transactionId,
        to,
        opts.failureCode ?? null,
        opts.failureMessage ?? null,
        opts.providerReference ?? null,
      ],
    );
    await recordEvent(client, transactionId, "STATUS_CHANGED", { from, to });
    return rowToTransaction(updated.rows[0]);
  });
}
