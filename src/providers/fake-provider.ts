import { randomInt, randomUUID } from "node:crypto";
import type { Provider, Transaction } from "../core/types.js";
import {
  DEFAULT_OUTCOMES,
  pickOutcome,
  type OutcomeSpec,
  type ResolvedOutcome,
} from "../core/outcomes.js";
import { scheduleWebhook } from "../webhooks/dispatcher.js";
import { recordPspOutcome } from "../core/psp-ledger.js";
import { getFault } from "../core/faults.js";
import type { WebhookEvent, WebhookStatus } from "../webhooks/codecs.js";
import type { PaymentProvider, PspInitiation, PspResult } from "./types.js";

export interface FakeProviderOptions {
  name: Provider;
  referencePrefix: string; // e.g. "pi", "PSK", "FLW"
  outcomes?: OutcomeSpec[]; // override the distribution (Phase 5/8 tuning)
}

// A stand-in PSP that behaves ASYNCHRONOUSLY, like the real thing:
//  - initiatePayment returns a `pending` ack immediately (or a synchronous
//    technical `failed` for timeouts / provider errors),
//  - the terminal outcome (success/declined/failed) is delivered later via a
//    signed webhook — sometimes late, duplicated, or never (stuck pending).
export class FakeProvider implements PaymentProvider {
  readonly name: Provider;
  private readonly prefix: string;
  private readonly outcomes: OutcomeSpec[];

  constructor(opts: FakeProviderOptions) {
    this.name = opts.name;
    this.prefix = opts.referencePrefix;
    this.outcomes = opts.outcomes ?? DEFAULT_OUTCOMES;
  }

  private newReference(): string {
    return `${this.prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  async initiatePayment(txn: Transaction): Promise<PspInitiation> {
    const fault = getFault(this.name);
    const extra = fault.extraLatencyMs ?? 0;
    const providerReference = this.newReference();

    // Fault: rejected credentials. Nothing happens at the PSP (no ledger, no
    // webhook). This is the classic "expired API key" incident.
    if (fault.authError) {
      return {
        providerReference,
        status: "failed",
        failureCode: "INVALID_API_KEY",
        failureMessage: "Invalid API credentials (HTTP 401).",
        latencyMs: 150 + extra,
      };
    }

    // Start from the normal distribution, then apply any active faults.
    let outcome: ResolvedOutcome = pickOutcome(this.outcomes);
    if (fault.forceTimeout) {
      outcome = { label: "TIMEOUT", status: "failed", failureCode: "PSP_TIMEOUT" };
    } else if (fault.httpErrorRate && Math.random() < fault.httpErrorRate) {
      outcome = { label: "PSP_ERROR", status: "failed", failureCode: "PSP_ERROR" };
    } else if (fault.successRate != null && Math.random() >= fault.successRate) {
      // Degraded provider: force a decline so the success rate visibly drops.
      outcome = {
        label: "DECLINED",
        status: "declined",
        failureCode: "CARD_DECLINED",
        failureMessage: "The issuer declined the transaction.",
      };
    }

    // Synchronous technical failures: no ack from the PSP, nothing to webhook.
    if (outcome.failureCode === "PSP_TIMEOUT" || outcome.failureCode === "PSP_ERROR") {
      return {
        providerReference,
        status: "failed",
        failureCode: outcome.failureCode,
        failureMessage: outcome.failureMessage,
        latencyMs:
          (outcome.failureCode === "PSP_TIMEOUT" ? 30000 + randomInt(0, 5000) : 200) +
          extra,
      };
    }

    // Everything else is accepted now; the real result arrives via webhook.
    // Map the sampled outcome to a terminal webhook status.
    const terminal: WebhookStatus =
      outcome.status === "success" || outcome.status === "pending"
        ? "success"
        : outcome.status === "declined"
          ? "declined"
          : "failed";

    const event: WebhookEvent = {
      eventId: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      providerReference,
      status: terminal,
      failureCode: outcome.failureCode,
      failureMessage: outcome.failureMessage,
    };

    // Record the PSP's ground truth NOW (what really happened at the PSP),
    // independent of whether our webhook ever arrives. This is what makes stuck-
    // pending payments show up in reconciliation as "PSP says success".
    await recordPspOutcome({
      provider: this.name,
      providerReference,
      aggregatorReference: txn.aggregatorReference,
      status: event.status,
      amount: txn.amount,
      currency: txn.currency,
    });

    const baseDelay = 500 + randomInt(0, 2500) + extra;

    // Fault: webhooks disabled — the PSP decided the outcome (ledger written
    // above) but never calls us back, so every payment sticks in `pending`.
    if (fault.webhooksDisabled) {
      return { providerReference, status: "pending", latencyMs: 40 + randomInt(0, 160) + extra };
    }

    switch (outcome.label) {
      case "PENDING":
      case "WEBHOOK_FAILED":
        // The webhook never arrives → the payment stays `pending`. This is the
        // "stuck pending, go investigate" scenario.
        break;
      case "DUPLICATE":
        // Same event delivered twice → the receiver's dedup must handle it.
        scheduleWebhook(this.name, event, baseDelay);
        scheduleWebhook(this.name, event, baseDelay + 300 + randomInt(0, 700));
        break;
      default:
        scheduleWebhook(this.name, event, baseDelay);
    }

    return {
      providerReference,
      status: "pending",
      latencyMs: 40 + randomInt(0, 160) + extra,
    };
  }

  // When an initiate call times out we don't actually know what happened at the
  // PSP. verify tells us the truth: ~30% of the time the charge DID go through
  // (so retrying would double-charge — hence verify BEFORE retry). Otherwise it
  // genuinely didn't and we can safely fail over.
  async verifyPayment(providerReference: string): Promise<PspResult> {
    const wentThrough = randomInt(0, 100) < 30;
    return {
      providerReference,
      status: wentThrough ? "success" : "failed",
      failureCode: wentThrough ? undefined : "NOT_FOUND",
      latencyMs: 50 + randomInt(0, 150),
    };
  }

  async refund(providerReference: string): Promise<PspResult> {
    return { providerReference, status: "success", latencyMs: 50 + randomInt(0, 150) };
  }
}
