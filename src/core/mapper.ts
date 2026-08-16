import type pg from "pg";
import type { Transaction } from "./types.js";

// Maps a raw transactions row (snake_case) to the internal Transaction type
// (camelCase). BIGINT columns arrive from pg as strings, so we coerce them.
export function rowToTransaction(row: pg.QueryResultRow): Transaction {
  return {
    id: Number(row.id),
    aggregatorReference: row.aggregator_reference,
    merchantId: row.merchant_id,
    merchantReference: row.merchant_reference,
    provider: row.provider,
    providerReference: row.provider_reference,
    paymentMethod: row.payment_method,
    amount: Number(row.amount),
    currency: row.currency,
    customerEmail: row.customer_email,
    status: row.status,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    checkoutUrl: row.checkout_url ?? null,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}
