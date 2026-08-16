// Internal payment model. Every PSP adapter will map its own vocabulary onto
// these types, so the rest of the system only ever deals with ONE shape.

export type Provider =
  | "stripe"
  | "paystack"
  | "flutterwave"
  | "payfast"
  | "ozow"
  | "peach"
  | "airtel"
  | "mpesa"
  | "capitec";

export type PaymentStatus =
  | "created" // row exists, nothing sent to a PSP yet
  | "processing" // handed to a PSP, awaiting outcome
  | "pending" // PSP acknowledged, final result still to come (e.g. via webhook)
  | "success"
  | "declined" // PSP said no (business decline, e.g. insufficient funds)
  | "failed" // technical failure (timeout, 5xx, signature error, ...)
  | "refunded";

export interface Transaction {
  id: number;
  aggregatorReference: string;
  merchantId: string;
  merchantReference: string | null;
  provider: Provider | null;
  providerReference: string | null;
  paymentMethod: string;
  amount: number; // minor units
  currency: string;
  customerEmail: string | null;
  status: PaymentStatus;
  failureCode: string | null;
  failureMessage: string | null;
  checkoutUrl: string | null; // hosted-page URL for real redirect PSPs (Phase 4)
  createdAt: string;
  updatedAt: string;
}
