import type { Provider } from "./types.js";

// Operator-controlled fault injection (Phase 8). These knobs deliberately break
// a provider so you can practise diagnosing incidents on the dashboard. The
// fake provider reads this state on every payment.
export interface ProviderFault {
  authError?: boolean; // creds rejected -> INVALID_API_KEY (nothing happens at PSP)
  forceTimeout?: boolean; // every attempt times out
  successRate?: number; // override success probability (0..1); rest become declines
  webhooksDisabled?: boolean; // outcome decided but webhook never sent -> stuck pending
  httpErrorRate?: number; // fraction that return PSP_ERROR
  extraLatencyMs?: number; // added to every response
}

const faults = new Map<Provider, ProviderFault>();

export function getFault(provider: Provider): ProviderFault {
  return faults.get(provider) ?? {};
}

export function setFault(provider: Provider, fault: ProviderFault): ProviderFault {
  // Merge so you can toggle one knob without clearing the others.
  const merged = { ...faults.get(provider), ...fault };
  faults.set(provider, merged);
  return merged;
}

export function clearFault(provider: Provider): void {
  faults.delete(provider);
}

export function clearAllFaults(): void {
  faults.clear();
}

export function getAllFaults(): Record<string, ProviderFault> {
  return Object.fromEntries(faults.entries());
}

export function hasAnyFault(provider: Provider): boolean {
  const f = faults.get(provider);
  return !!f && Object.keys(f).length > 0;
}
