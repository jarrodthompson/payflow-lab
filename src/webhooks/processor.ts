import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import type { Provider } from "../core/types.js";
import {
  getByProviderReference,
  recordPaymentEvent,
  transitionStatus,
} from "../core/txn-manager.js";
import { isTerminal } from "../core/state-machine.js";
import { getCodec } from "./codecs.js";

export interface WebhookProcessResult {
  httpStatus: number;
  outcome:
    | "processed"
    | "duplicate_ignored"
    | "invalid_signature"
    | "unmatched"
    | "already_settled";
  detail?: Record<string, unknown>;
}

// The full inbound-webhook pipeline for one delivery:
//   1. verify signature        (reject tampered/forged events)
//   2. dedup on (provider, event_id)  (PSPs retry; process each event once)
//   3. match to a transaction by provider reference
//   4. drive the payment to its terminal state (idempotently)
export async function processWebhook(
  provider: Provider,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<WebhookProcessResult> {
  const codec = getCodec(provider);
  const secret = config.webhookSecrets[provider];

  // 1. Signature verification.
  if (!codec.verify(secret, rawBody, signatureHeader)) {
    logger.warn({ provider }, "WEBHOOK_SIGNATURE_INVALID");
    return { httpStatus: 401, outcome: "invalid_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, outcome: "invalid_signature", detail: { reason: "bad_json" } };
  }

  const event = codec.parse(payload);

  // 2. Dedup gate. The UNIQUE(provider, event_id) constraint makes this atomic:
  // if the row already exists, ON CONFLICT DO NOTHING returns no rows.
  const insert = await query(
    `INSERT INTO webhook_events (provider, event_id, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [provider, event.eventId, rawBody],
  );
  if (!insert.rowCount) {
    logger.info({ provider, eventId: event.eventId }, "WEBHOOK_DUPLICATE_IGNORED");
    return { httpStatus: 200, outcome: "duplicate_ignored", detail: { eventId: event.eventId } };
  }
  const webhookRowId = insert.rows[0].id;

  // 3. Match to a transaction.
  const txn = await getByProviderReference(provider, event.providerReference);
  if (!txn) {
    logger.warn(
      { provider, providerReference: event.providerReference },
      "WEBHOOK_UNMATCHED",
    );
    // Ack anyway (200) so the PSP stops retrying an event we can't place.
    return { httpStatus: 200, outcome: "unmatched", detail: { eventId: event.eventId } };
  }

  await recordPaymentEvent(txn.id, "WEBHOOK_RECEIVED", {
    provider,
    eventId: event.eventId,
    status: event.status,
  });
  await recordPaymentEvent(txn.id, "WEBHOOK_SIGNATURE_VERIFIED", {});

  // 4. Transition — but only if still in flight. If a prior event already
  // settled it, this is a no-op (idempotent), which is exactly what we want.
  if (isTerminal(txn.status) || txn.status === "success") {
    await query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [
      webhookRowId,
    ]);
    logger.info({ txn: txn.aggregatorReference }, "WEBHOOK_ALREADY_SETTLED");
    return { httpStatus: 200, outcome: "already_settled" };
  }

  await transitionStatus(txn.id, event.status, {
    failureCode: event.failureCode,
    failureMessage: event.failureMessage,
  });
  await recordPaymentEvent(txn.id, "PAYMENT_CONFIRMED", { status: event.status });
  await query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [
    webhookRowId,
  ]);

  return {
    httpStatus: 200,
    outcome: "processed",
    detail: { paymentId: txn.aggregatorReference, status: event.status },
  };
}
