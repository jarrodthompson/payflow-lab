import type { PaymentStatus, Transaction } from "../core/types.js";

// The SYNCHRONOUS acknowledgement a PSP returns from an initiate call. In the
// async model, most payments come back `pending` here and the terminal outcome
// arrives later via a webhook. Immediate technical failures (timeout, provider
// error) resolve to `failed` synchronously with no webhook to follow.
export interface PspInitiation {
  providerReference: string; // the PSP's own id for this charge
  status: Extract<PaymentStatus, "pending" | "failed">;
  failureCode?: string; // set only on a synchronous failure
  failureMessage?: string;
  latencyMs: number; // how long the PSP "took" (simulated for the fake provider)
}

// The outcome a verify/refund call reports, in OUR normalized vocabulary.
export interface PspResult {
  providerReference: string;
  status: Extract<PaymentStatus, "success" | "declined" | "failed" | "pending">;
  failureCode?: string;
  failureMessage?: string;
  latencyMs: number;
}

// The single interface every payment provider implements. This is the contract
// the rest of the aggregator depends on — it never talks to a PSP directly.
export interface PaymentProvider {
  readonly name: string;
  // Returns a synchronous ack; the terminal outcome may follow via webhook.
  initiatePayment(txn: Transaction): Promise<PspInitiation>;
  verifyPayment(providerReference: string): Promise<PspResult>;
  refund(providerReference: string): Promise<PspResult>;
}
