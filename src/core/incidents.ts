import { randomInt, randomUUID } from "node:crypto";
import type { Provider } from "./types.js";
import { clearFault, setFault, type ProviderFault } from "./faults.js";

// Incident drills (Phase 8). Starting an incident applies a hidden fault to a
// random provider. You then investigate using the dashboard/logs, and reveal or
// resolve when you've found the root cause — exactly the loop an on-call payment
// specialist runs.

interface FaultKind {
  key: string;
  fault: ProviderFault;
  symptom: string; // what you'd observe
  rootCause: string; // revealed only on demand / resolve
}

const PROVIDERS: Provider[] = [
  "stripe",
  "paystack",
  "flutterwave",
  "payfast",
  "ozow",
  "peach",
  "airtel",
  "mpesa",
  "capitec",
];

function faultKinds(): FaultKind[] {
  return [
    {
      key: "expired_credentials",
      fault: { authError: true },
      symptom: "A provider's payments are failing at a high rate.",
      rootCause: "Invalid/expired PSP API credentials (HTTP 401 INVALID_API_KEY).",
    },
    {
      key: "provider_degradation",
      fault: { successRate: 0.6 },
      symptom: "A provider's approval rate has dropped sharply.",
      rootCause: "Provider degradation — issuer declines elevated (~40% CARD_DECLINED).",
    },
    {
      key: "webhooks_down",
      fault: { webhooksDisabled: true },
      symptom: "Payments for a provider are piling up in pending.",
      rootCause: "Provider stopped delivering webhooks — outcomes never confirmed.",
    },
    {
      key: "psp_timeouts",
      fault: { forceTimeout: true },
      symptom: "A provider is timing out; failovers and retries are spiking.",
      rootCause: "Provider outage/latency — all initiate calls time out (PSP_TIMEOUT).",
    },
  ];
}

export interface Incident {
  id: string;
  provider: Provider;
  kind: string;
  symptom: string;
  rootCause: string;
  startedAt: string;
  resolvedAt: string | null;
}

const incidents = new Map<string, Incident>();

// Public (masked) view — hides the root cause unless explicitly revealed.
export function maskIncident(inc: Incident, reveal: boolean) {
  return {
    id: inc.id,
    provider: reveal ? inc.provider : "(investigate to find out)",
    kind: reveal ? inc.kind : undefined,
    symptom: inc.symptom,
    rootCause: reveal ? inc.rootCause : undefined,
    startedAt: inc.startedAt,
    resolvedAt: inc.resolvedAt,
    status: inc.resolvedAt ? "resolved" : "active",
  };
}

export function startRandomIncident(): Incident {
  const provider = PROVIDERS[randomInt(0, PROVIDERS.length)];
  const kinds = faultKinds();
  const kind = kinds[randomInt(0, kinds.length)];

  setFault(provider, kind.fault);

  const incident: Incident = {
    id: `INC_${randomUUID().slice(0, 8)}`,
    provider,
    kind: kind.key,
    symptom: kind.symptom,
    rootCause: kind.rootCause,
    startedAt: new Date().toISOString(),
    resolvedAt: null,
  };
  incidents.set(incident.id, incident);
  return incident;
}

export function getIncident(id: string): Incident | undefined {
  return incidents.get(id);
}

export function listIncidents(): Incident[] {
  return [...incidents.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// Resolve: lift the fault and reveal the root cause.
export function resolveIncident(id: string): Incident | undefined {
  const inc = incidents.get(id);
  if (!inc) return undefined;
  clearFault(inc.provider);
  inc.resolvedAt = new Date().toISOString();
  return inc;
}
