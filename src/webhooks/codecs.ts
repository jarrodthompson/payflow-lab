import { createHmac, timingSafeEqual } from "node:crypto";
import type { Provider } from "../core/types.js";
import { isDeclineReason } from "../core/outcomes.js";

// A webhook carries a terminal outcome for one payment, in OUR vocabulary.
export type WebhookStatus = "success" | "declined" | "failed";

export interface WebhookEvent {
  eventId: string;
  providerReference: string;
  status: WebhookStatus;
  failureCode?: string;
  failureMessage?: string;
}

// A codec owns everything provider-specific about webhooks:
//   build()  - construct the provider's native JSON envelope (used by the fake PSP)
//   parse()  - normalize a native envelope back into WebhookEvent (used by receiver)
//   sign()   - produce the provider's signature header value
//   verify() - validate an inbound signature
// Real Stripe/Paystack/Flutterwave adapters would each own one of these.
export interface WebhookCodec {
  readonly signatureHeader: string; // lowercase header name we read on inbound
  build(event: WebhookEvent): unknown;
  parse(payload: any): WebhookEvent;
  sign(secret: string, rawBody: string): string;
  verify(secret: string, rawBody: string, headerValue: string | undefined): boolean;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// --- Stripe: HMAC-SHA256 over `${timestamp}.${body}`, header `t=..,v1=..` -----
const stripeCodec: WebhookCodec = {
  signatureHeader: "stripe-signature",
  build(event) {
    return {
      id: event.eventId, // evt_...
      object: "event",
      type:
        event.status === "success"
          ? "payment_intent.succeeded"
          : "payment_intent.payment_failed",
      data: {
        object: {
          id: event.providerReference, // pi_...
          object: "payment_intent",
          status: event.status === "success" ? "succeeded" : "requires_payment_method",
          last_payment_error:
            event.failureCode != null
              ? { code: event.failureCode, message: event.failureMessage }
              : null,
        },
      },
    };
  },
  parse(payload) {
    const obj = payload?.data?.object ?? {};
    if (payload?.type === "payment_intent.succeeded") {
      return { eventId: payload.id, providerReference: obj.id, status: "success" };
    }
    const code: string | undefined = obj?.last_payment_error?.code ?? undefined;
    return {
      eventId: payload.id,
      providerReference: obj.id,
      status: isDeclineReason(code) ? "declined" : "failed",
      failureCode: code,
      failureMessage: obj?.last_payment_error?.message,
    };
  },
  sign(secret, rawBody) {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
    return `t=${t},v1=${sig}`;
  },
  verify(secret, rawBody, headerValue) {
    if (!headerValue) return false;
    const parts = Object.fromEntries(
      headerValue.split(",").map((kv) => kv.split("=") as [string, string]),
    );
    const t = parts["t"];
    const v1 = parts["v1"];
    if (!t || !v1) return false;
    const expected = createHmac("sha256", secret)
      .update(`${t}.${rawBody}`)
      .digest("hex");
    return safeEqualHex(expected, v1);
  },
};

// --- Paystack: HMAC-SHA512 over the raw body, header `x-paystack-signature` ---
const paystackCodec: WebhookCodec = {
  signatureHeader: "x-paystack-signature",
  build(event) {
    return {
      id: event.eventId,
      event: event.status === "success" ? "charge.success" : "charge.failed",
      data: {
        id: event.providerReference, // PSK_...
        status: event.status === "success" ? "success" : "failed",
        gateway_response: event.failureMessage ?? "Approved",
        failure_code: event.failureCode ?? null,
      },
    };
  },
  parse(payload) {
    const d = payload?.data ?? {};
    if (payload?.event === "charge.success") {
      return { eventId: payload.id, providerReference: d.id, status: "success" };
    }
    const code: string | undefined = d.failure_code ?? undefined;
    return {
      eventId: payload.id,
      providerReference: d.id,
      status: isDeclineReason(code) ? "declined" : "failed",
      failureCode: code,
      failureMessage: d.gateway_response,
    };
  },
  sign(secret, rawBody) {
    return createHmac("sha512", secret).update(rawBody).digest("hex");
  },
  verify(secret, rawBody, headerValue) {
    if (!headerValue) return false;
    const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
    return safeEqualHex(expected, headerValue);
  },
};

// --- Flutterwave: static secret hash compared directly, header `verif-hash` ---
const flutterwaveCodec: WebhookCodec = {
  signatureHeader: "verif-hash",
  build(event) {
    return {
      id: event.eventId,
      event: "charge.completed",
      "event.type": "CARD_TRANSACTION",
      data: {
        id: event.providerReference, // FLW_...
        status: event.status === "success" ? "successful" : "failed",
        processor_response: event.failureCode ?? null,
        narration: event.failureMessage ?? null,
      },
    };
  },
  parse(payload) {
    const d = payload?.data ?? {};
    if (payload?.event === "charge.completed" && d.status === "successful") {
      return { eventId: payload.id, providerReference: d.id, status: "success" };
    }
    const code: string | undefined = d.processor_response ?? undefined;
    return {
      eventId: payload.id,
      providerReference: d.id,
      status: isDeclineReason(code) ? "declined" : "failed",
      failureCode: code,
      failureMessage: d.narration,
    };
  },
  sign(secret) {
    return secret; // Flutterwave sends the configured hash verbatim
  },
  verify(secret, _rawBody, headerValue) {
    if (!headerValue) return false;
    return safeEqualHex(secret, headerValue);
  },
};

// --- Generic: a plain JSON envelope + HMAC-SHA256 header. Used by the simulated
// providers (payfast, ozow, peach, airtel, mpesa, capitec) that don't have a
// bespoke codec. A real adapter for any of them would replace this later.
const genericCodec: WebhookCodec = {
  signatureHeader: "x-webhook-signature",
  build(event) {
    return {
      id: event.eventId,
      event: `payment.${event.status}`, // payment.success | payment.declined | payment.failed
      data: {
        reference: event.providerReference,
        status: event.status,
        failure_code: event.failureCode ?? null,
        message: event.failureMessage ?? null,
      },
    };
  },
  parse(payload) {
    const d = payload?.data ?? {};
    const suffix = String(payload?.event ?? "").split(".")[1];
    const status: WebhookStatus =
      suffix === "success" ? "success" : suffix === "declined" ? "declined" : "failed";
    return {
      eventId: payload.id,
      providerReference: d.reference,
      status,
      failureCode: d.failure_code ?? undefined,
      failureMessage: d.message ?? undefined,
    };
  },
  sign(secret, rawBody) {
    return createHmac("sha256", secret).update(rawBody).digest("hex");
  },
  verify(secret, rawBody, headerValue) {
    if (!headerValue) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqualHex(expected, headerValue);
  },
};

const codecs: Partial<Record<Provider, WebhookCodec>> = {
  stripe: stripeCodec,
  paystack: paystackCodec,
  flutterwave: flutterwaveCodec,
};

export function getCodec(provider: Provider): WebhookCodec {
  return codecs[provider] ?? genericCodec;
}
