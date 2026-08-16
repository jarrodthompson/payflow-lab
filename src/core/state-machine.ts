import type { PaymentStatus } from "./types.js";

// The transaction state machine. Every allowed transition is listed here, so
// illegal moves (e.g. success -> processing, or paying out a declined txn)
// are rejected in one place instead of being scattered through the code.
const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  created: ["processing", "failed"],
  processing: ["success", "declined", "failed", "pending"],
  pending: ["success", "declined", "failed"],
  success: ["refunded"],
  declined: [], // terminal
  failed: [], // terminal
  refunded: [], // terminal
};

export const TERMINAL_STATES: PaymentStatus[] = ["declined", "failed", "refunded"];

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: PaymentStatus,
    public readonly to: PaymentStatus,
  ) {
    super(`Illegal state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

// Throws if the move is not allowed; otherwise returns the target state.
export function assertTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): PaymentStatus {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  return to;
}
