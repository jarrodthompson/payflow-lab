import { config } from "../../config.js";
import { ApiError } from "../../core/errors.js";
import { logger } from "../../logger.js";
import type { PaymentStatus } from "../../core/types.js";

// A thin, real client for the Paystack sandbox. Only the two calls we need:
//   - initialize: create a transaction, get a hosted checkout URL
//   - verify: poll for the final outcome by reference
// Docs: https://paystack.com/docs/api/transaction/

const API = config.paystack.apiBaseUrl;

function authHeader(): Record<string, string> {
  if (!config.paystack.secretKey) {
    throw new ApiError(
      503,
      "PAYSTACK_NOT_CONFIGURED",
      "PAYSTACK_SECRET_KEY is not set. Add your test secret key (sk_test_...) to .env.",
    );
  }
  return { Authorization: `Bearer ${config.paystack.secretKey}` };
}

export interface InitializeInput {
  email: string;
  amount: number; // minor units (kobo/cents), matches our storage
  currency?: string;
  reference: string; // we pass our aggregator reference to link the two systems
}

export interface InitializeResult {
  reference: string;
  authorizationUrl: string;
  accessCode: string;
}

export async function initializeTransaction(
  input: InitializeInput,
): Promise<InitializeResult> {
  const res = await fetch(`${API}/transaction/initialize`, {
    method: "POST",
    headers: { ...authHeader(), "content-type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      amount: input.amount,
      currency: input.currency,
      reference: input.reference,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body?.status !== true) {
    logger.error({ status: res.status, body }, "paystack initialize failed");
    throw new ApiError(
      502,
      "PSP_INITIALIZE_FAILED",
      body?.message ?? `Paystack initialize failed (HTTP ${res.status})`,
    );
  }
  return {
    reference: body.data.reference,
    authorizationUrl: body.data.authorization_url,
    accessCode: body.data.access_code,
  };
}

export interface VerifyResult {
  reference: string;
  status: Extract<PaymentStatus, "success" | "failed" | "pending" | "refunded">;
  rawStatus: string; // Paystack's own status string, for the timeline
  gatewayResponse?: string;
  amount?: number;
  currency?: string;
}

// Map Paystack's transaction status vocabulary onto ours.
function mapStatus(paystackStatus: string): VerifyResult["status"] {
  switch (paystackStatus) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "reversed":
      return "refunded";
    case "abandoned":
    case "ongoing":
    case "pending":
    case "processing":
    default:
      return "pending";
  }
}

export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  const res = await fetch(
    `${API}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { ...authHeader() } },
  );
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body?.status !== true) {
    logger.error({ status: res.status, body }, "paystack verify failed");
    throw new ApiError(
      502,
      "PSP_VERIFY_FAILED",
      body?.message ?? `Paystack verify failed (HTTP ${res.status})`,
    );
  }
  const d = body.data;
  return {
    reference: d.reference,
    status: mapStatus(d.status),
    rawStatus: d.status,
    gatewayResponse: d.gateway_response,
    amount: d.amount,
    currency: d.currency,
  };
}

export function isPaystackConfigured(): boolean {
  return config.paystack.secretKey.length > 0;
}
