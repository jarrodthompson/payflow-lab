import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Provider } from "./types.js";

// The PSP's own ground-truth record of a decided payment. The fake providers
// write here so the reconciliation engine has an independent source to compare
// against. Real PSPs would expose this via a settlement report / verify API.
export interface PspOutcome {
  provider: Provider;
  providerReference: string;
  aggregatorReference: string;
  status: "success" | "declined" | "failed";
  amount: number; // minor units
  currency: string;
}

async function insertRow(row: {
  provider: string;
  providerReference: string;
  aggregatorReference: string | null;
  status: string;
  amount: number;
  currency: string;
}): Promise<void> {
  await query(
    `INSERT INTO psp_ledger
       (provider, provider_reference, aggregator_reference, status, amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.provider,
      row.providerReference,
      row.aggregatorReference,
      row.status,
      row.amount,
      row.currency,
    ],
  );
}

// Record what the PSP "really" did. With noise enabled, occasionally diverge
// from the truth the way real PSP data does: a wrong amount, a duplicate row, or
// a phantom charge with no matching aggregator transaction.
export async function recordPspOutcome(outcome: PspOutcome): Promise<void> {
  try {
    const n = config.recon.noise;
    const noisy = config.recon.injectNoise;

    // Amount as the PSP records it (occasionally off by a small delta).
    const recordedAmount =
      noisy && Math.random() < n.amountMismatchRate
        ? outcome.amount + n.amountDeltaMinor
        : outcome.amount;

    await insertRow({
      provider: outcome.provider,
      providerReference: outcome.providerReference,
      aggregatorReference: outcome.aggregatorReference,
      status: outcome.status,
      amount: recordedAmount,
      currency: outcome.currency,
    });

    // Duplicate settlement row for the same charge.
    if (noisy && Math.random() < n.duplicateRate) {
      await insertRow({
        provider: outcome.provider,
        providerReference: outcome.providerReference,
        aggregatorReference: outcome.aggregatorReference,
        status: outcome.status,
        amount: outcome.amount,
        currency: outcome.currency,
      });
    }

    // Phantom charge: the PSP has a success we have no record of.
    if (noisy && Math.random() < n.phantomRate) {
      await insertRow({
        provider: outcome.provider,
        providerReference: `${outcome.provider}_ghost_${randomUUID().slice(0, 12)}`,
        aggregatorReference: null,
        status: "success",
        amount: outcome.amount,
        currency: outcome.currency,
      });
    }
  } catch (err) {
    // Ledger writes must never break the payment flow.
    logger.warn({ err }, "psp-ledger write failed");
  }
}
