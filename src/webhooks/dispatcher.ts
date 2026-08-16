import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Provider } from "../core/types.js";
import { getCodec, type WebhookEvent } from "./codecs.js";

// Simulates a PSP calling our webhook endpoint. Builds the provider-native
// payload, signs it, and POSTs it to /webhooks/:provider after `delayMs`.
// This deliberately goes over real HTTP so the whole receive → verify → dedup →
// process path is exercised, exactly like a real integration.
export function scheduleWebhook(
  provider: Provider,
  event: WebhookEvent,
  delayMs: number,
): void {
  setTimeout(() => {
    void deliver(provider, event);
  }, delayMs);
}

async function deliver(provider: Provider, event: WebhookEvent): Promise<void> {
  const codec = getCodec(provider);
  const secret = config.webhookSecrets[provider];
  const payload = codec.build(event);
  const rawBody = JSON.stringify(payload);
  const signature = codec.sign(secret, rawBody);
  const url = `${config.baseUrl}/webhooks/${provider}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [codec.signatureHeader]: signature,
      },
      body: rawBody,
    });
    logger.debug(
      { provider, eventId: event.eventId, status: res.status },
      "webhook delivered",
    );
  } catch (err) {
    logger.error({ err, provider, eventId: event.eventId }, "webhook delivery failed");
  }
}
