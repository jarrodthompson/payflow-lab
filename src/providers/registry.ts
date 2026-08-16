import type { Provider } from "../core/types.js";
import { FakeProvider } from "./fake-provider.js";
import type { PaymentProvider } from "./types.js";

// Maps a provider name to its adapter. In Phase 2 all three are FakeProviders
// (each with its own reference style). Phase 4 replaces individual entries with
// real sandbox adapters — the rest of the codebase doesn't change.
const registry: Record<Provider, PaymentProvider> = {
  stripe: new FakeProvider({ name: "stripe", referencePrefix: "pi" }),
  paystack: new FakeProvider({ name: "paystack", referencePrefix: "PSK" }),
  flutterwave: new FakeProvider({ name: "flutterwave", referencePrefix: "FLW" }),
  payfast: new FakeProvider({ name: "payfast", referencePrefix: "PF" }),
  ozow: new FakeProvider({ name: "ozow", referencePrefix: "OZW" }),
  peach: new FakeProvider({ name: "peach", referencePrefix: "PCH" }),
  airtel: new FakeProvider({ name: "airtel", referencePrefix: "ATL" }),
  mpesa: new FakeProvider({ name: "mpesa", referencePrefix: "MPX" }),
  capitec: new FakeProvider({ name: "capitec", referencePrefix: "CPT" }),
};

export function getProvider(name: Provider): PaymentProvider {
  const provider = registry[name];
  if (!provider) {
    throw new Error(`No adapter registered for provider: ${name}`);
  }
  return provider;
}
