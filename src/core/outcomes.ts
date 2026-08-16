import { randomInt } from "node:crypto";
import type { PaymentStatus } from "./types.js";

// The outcome distribution the fake PSP samples from. Weights mirror the spec:
//   85% success, 5% declined, 3% timeout, 2% 3DS, 2% psp error,
//   1% duplicate, 1% webhook-failed, 1% pending.
// Duplicate / webhook-failed behave like their base state in Phase 2; Phase 3
// (webhooks) gives them their distinctive behavior.
export interface OutcomeSpec {
  label: string; // human name, recorded in the event timeline
  weight: number; // relative probability
  status: Extract<PaymentStatus, "success" | "declined" | "failed" | "pending">;
  failureCode?: string;
  // For declines we pick a specific reason at random from this list.
  declineReasons?: string[];
}

export const DEFAULT_OUTCOMES: OutcomeSpec[] = [
  { label: "SUCCESS", weight: 85, status: "success" },
  {
    label: "DECLINED",
    weight: 5,
    status: "declined",
    declineReasons: [
      "INSUFFICIENT_FUNDS",
      "CARD_DECLINED",
      "DO_NOT_HONOR",
      "EXPIRED_CARD",
      "FRAUD_SUSPECTED",
    ],
  },
  { label: "TIMEOUT", weight: 3, status: "failed", failureCode: "PSP_TIMEOUT" },
  { label: "3DS_FAILED", weight: 2, status: "failed", failureCode: "3DS_FAILED" },
  { label: "PSP_ERROR", weight: 2, status: "failed", failureCode: "PSP_ERROR" },
  { label: "DUPLICATE", weight: 1, status: "success", failureCode: undefined },
  {
    label: "WEBHOOK_FAILED",
    weight: 1,
    status: "pending",
    failureCode: "WEBHOOK_FAILED",
  },
  { label: "PENDING", weight: 1, status: "pending" },
];

// The set of failure codes that represent a business DECLINE (issuer said no)
// rather than a technical FAILURE. Webhook parsers use this to normalize a
// provider's failed event into `declined` vs `failed`.
export const DECLINE_REASONS = new Set([
  "INSUFFICIENT_FUNDS",
  "CARD_DECLINED",
  "DO_NOT_HONOR",
  "EXPIRED_CARD",
  "FRAUD_SUSPECTED",
]);

export function isDeclineReason(code: string | null | undefined): boolean {
  return !!code && DECLINE_REASONS.has(code);
}

const FAILURE_MESSAGES: Record<string, string> = {
  INSUFFICIENT_FUNDS: "The card had insufficient funds.",
  CARD_DECLINED: "The issuer declined the transaction.",
  DO_NOT_HONOR: "Issuer response: do not honor.",
  EXPIRED_CARD: "The card has expired.",
  FRAUD_SUSPECTED: "The transaction was flagged as potentially fraudulent.",
  PSP_TIMEOUT: "The provider did not respond in time.",
  "3DS_FAILED": "3-D Secure authentication failed.",
  PSP_ERROR: "The provider returned an internal error.",
  WEBHOOK_FAILED: "The confirmation webhook could not be delivered.",
};

export interface ResolvedOutcome {
  label: string;
  status: OutcomeSpec["status"];
  failureCode?: string;
  failureMessage?: string;
}

// Pick one outcome according to the weights. randomInt gives crypto-quality
// randomness; weights don't need to sum to 100.
export function pickOutcome(outcomes: OutcomeSpec[] = DEFAULT_OUTCOMES): ResolvedOutcome {
  const total = outcomes.reduce((sum, o) => sum + o.weight, 0);
  let roll = randomInt(0, total); // 0 <= roll < total
  let chosen = outcomes[outcomes.length - 1];
  for (const o of outcomes) {
    if (roll < o.weight) {
      chosen = o;
      break;
    }
    roll -= o.weight;
  }

  let failureCode = chosen.failureCode;
  if (chosen.declineReasons && chosen.declineReasons.length > 0) {
    failureCode = chosen.declineReasons[randomInt(0, chosen.declineReasons.length)];
  }

  return {
    label: chosen.label,
    status: chosen.status,
    failureCode,
    failureMessage: failureCode ? FAILURE_MESSAGES[failureCode] : undefined,
  };
}
