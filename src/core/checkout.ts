import { query } from "../db/pool.js";
import { logger } from "../logger.js";
import { generateAggregatorReference } from "./reference.js";
import { rowToTransaction } from "./mapper.js";
import { notFound } from "./errors.js";
import {
  getPaymentByReference,
  recordPaymentEvent,
  transitionStatus,
} from "./txn-manager.js";
import { isTerminal } from "./state-machine.js";
import {
  initializeTransaction,
  verifyTransaction,
} from "../providers/real/paystack.js";
import type { Transaction } from "./types.js";

export interface CheckoutInput {
  merchantId: string;
  merchantReference?: string;
  amount: number; // minor units
  currency?: string;
  email: string;
}

export interface CheckoutResult {
  transaction: Transaction;
  authorizationUrl: string;
}

/**
 * Start a REAL Paystack checkout. Unlike the fake flow, this returns a hosted
 * authorization URL the customer must open to pay with a test card. The outcome
 * is discovered by polling Paystack's verify endpoint (no webhook/tunnel).
 */
export async function createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const reference = generateAggregatorReference();

  // Insert as processing; provider is Paystack for the real flow.
  const inserted = await query(
    `INSERT INTO transactions
       (aggregator_reference, merchant_id, merchant_reference, provider,
        payment_method, amount, currency, customer_email, status)
     VALUES ($1, $2, $3, 'paystack', 'card', $4, $5, $6, 'processing')
     RETURNING *`,
    [
      reference,
      input.merchantId,
      input.merchantReference ?? null,
      input.amount,
      (input.currency ?? "NGN").toUpperCase(),
      input.email,
    ],
  );
  let txn = rowToTransaction(inserted.rows[0]);

  await recordPaymentEvent(txn.id, "PAYMENT_CREATED", {
    amount: txn.amount,
    currency: txn.currency,
    mode: "live",
  });
  await recordPaymentEvent(txn.id, "ROUTING_DECISION", {
    provider: "paystack",
    mode: "live",
  });

  // Call the real Paystack sandbox. We pass our own reference so the two systems
  // share one id — the verify poll uses it directly.
  const init = await initializeTransaction({
    email: input.email,
    amount: txn.amount,
    currency: txn.currency,
    reference,
  });

  await query(
    `UPDATE transactions
        SET provider_reference = $2, checkout_url = $3, updated_at = now()
      WHERE id = $1`,
    [txn.id, init.reference, init.authorizationUrl],
  );
  await recordPaymentEvent(txn.id, "CHECKOUT_INITIALIZED", {
    authorizationUrl: init.authorizationUrl,
    providerReference: init.reference,
  });

  txn = await transitionStatus(txn.id, "pending");

  // Kick off background polling so the state updates automatically once the
  // customer completes (or abandons) the hosted checkout.
  startVerifyPolling(reference, init.reference);

  return { transaction: { ...txn, checkoutUrl: init.authorizationUrl }, authorizationUrl: init.authorizationUrl };
}

/**
 * Verify a checkout once against Paystack and apply the outcome. Safe to call
 * repeatedly (idempotent) — this is what a "refresh status" button would hit.
 */
export async function verifyCheckout(aggregatorReference: string): Promise<Transaction> {
  const txn = await getPaymentByReference(aggregatorReference);
  if (!txn.providerReference) {
    throw notFound(`Payment ${aggregatorReference} has no provider reference to verify`);
  }

  const result = await verifyTransaction(txn.providerReference);
  await recordPaymentEvent(txn.id, "PSP_VERIFY", {
    rawStatus: result.rawStatus,
    mappedStatus: result.status,
    gatewayResponse: result.gatewayResponse ?? null,
  });

  // Only move if still in flight and Paystack has reached a different state.
  const inFlight = txn.status === "pending" || txn.status === "processing";
  if (inFlight && result.status !== txn.status) {
    const updated = await transitionStatus(txn.id, result.status, {
      failureMessage: result.gatewayResponse,
    });
    await recordPaymentEvent(txn.id, "PAYMENT_CONFIRMED", {
      status: result.status,
      source: "verify",
    });
    return updated;
  }
  return txn;
}

// Poll verify every few seconds for a few minutes; stop once terminal. This is
// the polling pattern you'd use when you can't (or don't want to) receive
// webhooks. Best-effort: errors are logged, not thrown.
function startVerifyPolling(aggregatorReference: string, providerReference: string): void {
  const intervalMs = 5000;
  const maxAttempts = 36; // ~3 minutes
  let attempts = 0;

  const timer = setInterval(async () => {
    attempts += 1;
    try {
      const txn = await verifyCheckout(aggregatorReference);
      if (isTerminal(txn.status) || txn.status === "success") {
        clearInterval(timer);
        logger.info(
          { ref: aggregatorReference, status: txn.status },
          "verify polling: settled",
        );
        return;
      }
    } catch (err) {
      logger.warn({ err, ref: aggregatorReference }, "verify polling: attempt failed");
    }
    if (attempts >= maxAttempts) {
      clearInterval(timer);
      logger.info(
        { ref: aggregatorReference, providerReference },
        "verify polling: gave up (still pending)",
      );
    }
  }, intervalMs);

  // Don't let the poller keep the process alive on shutdown.
  timer.unref?.();
}
