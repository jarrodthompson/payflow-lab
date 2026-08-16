// Typed client for the PayFlow Lab API. All calls go to /api/v1 (proxied to the
// Express server in dev; same origin in a built deployment).

const BASE = "/api/v1";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export type PaymentStatus =
  | "created"
  | "processing"
  | "pending"
  | "success"
  | "declined"
  | "failed"
  | "refunded";

export interface Payment {
  paymentId: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  provider: string | null;
  paymentMethod: string;
  merchantReference: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPerf {
  provider: string;
  transactions: number;
  successful: number;
  successRate: number;
  valueMinor: number;
}

export interface Overview {
  totals: {
    transactions: number;
    successful: number;
    declined: number;
    failed: number;
    pending: number;
    processing: number;
    approvalRate: number;
    valueMinor: number;
  };
  byStatus: Record<string, number>;
  byProvider: ProviderPerf[];
}

export interface ProviderHealth {
  provider: string;
  decided: number;
  success: number;
  successRate: number | null;
  healthy: boolean;
}

export interface RoutingInfo {
  strategy: "rules" | "weighted" | "performance";
  weights: Record<string, number>;
  maxAttempts: number;
  capabilities: Record<string, { currencies: string[]; methods: string[] }>;
  providerHealth: ProviderHealth[];
}

export interface TimelineEvent {
  type: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ReconSummary {
  runId: number;
  windowMinutes: number;
  checked: number;
  matched: number;
  counts: Record<string, number>;
}

export interface ReconFinding {
  type: string;
  aggregator_reference: string | null;
  provider: string | null;
  provider_reference: string | null;
  our_status: string | null;
  psp_status: string | null;
  our_amount: number | null;
  psp_amount: number | null;
  detail: Record<string, unknown>;
}

export interface ReconRunRow {
  id: number;
  window_minutes: number;
  checked: number;
  matched: number;
  summary: Record<string, number>;
  started_at: string;
  finished_at: string | null;
}

export interface SimRun {
  id: string;
  requested: number;
  created: number;
  errors: number;
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  status: string;
}

export interface ProviderFault {
  authError?: boolean;
  forceTimeout?: boolean;
  successRate?: number;
  webhooksDisabled?: boolean;
  httpErrorRate?: number;
  extraLatencyMs?: number;
}

export interface Incident {
  id: string;
  provider: string;
  kind?: string;
  symptom: string;
  rootCause?: string;
  startedAt: string;
  resolvedAt: string | null;
  status: string;
}

export interface EventLogRow {
  createdAt: string;
  type: string;
  aggregatorReference: string;
  provider: string | null;
  status: string;
  detail: Record<string, unknown>;
}

export const api = {
  overview: () => get<Overview>("/stats"),
  routing: () => get<RoutingInfo>("/routing"),
  setStrategy: (strategy: string) => post<{ strategy: string }>("/routing", { strategy }),
  payments: (q: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== "" && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return get<{ items: Payment[]; total: number }>(`/payments?${qs}`);
  },
  payment: (ref: string) => get<Payment>(`/payments/${ref}`),
  timeline: (ref: string) =>
    get<{ paymentId: string; events: TimelineEvent[] }>(`/payments/${ref}/timeline`),
  startSimulation: (transactions: number, transactionsPerSecond: number) =>
    post<SimRun>("/simulation/start", { transactions, transactionsPerSecond }),
  simRun: (id: string) => get<SimRun>(`/simulation/${id}`),
  runRecon: (windowMinutes: number) =>
    post<ReconSummary>("/reconciliation/run", { windowMinutes }),
  reconRuns: () => get<{ runs: ReconRunRow[] }>("/reconciliation"),
  reconRun: (id: number) =>
    get<{ run: ReconRunRow; findings: ReconFinding[] }>(`/reconciliation/${id}`),
  faults: () => get<{ faults: Record<string, ProviderFault> }>("/faults"),
  setFault: (provider: string, fault: ProviderFault) =>
    post<{ provider: string; fault: ProviderFault }>("/faults", { provider, ...fault }),
  clearFault: (provider: string) => del<{ provider: string }>(`/faults/${provider}`),
  clearAllFaults: () => post<{ cleared: boolean }>("/faults/clear"),
  startIncident: () => post<Incident>("/incidents/start"),
  incidents: () => get<{ incidents: Incident[] }>("/incidents"),
  resolveIncident: (id: string) => post<Incident>(`/incidents/${id}/resolve`),
  events: (q: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== "" && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return get<{ items: EventLogRow[]; total: number }>(`/events?${qs}`);
  },
};

export function money(minor: number | null, currency = ""): string {
  if (minor == null) return "—";
  return `${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`.trim();
}

export function pct(x: number | null): string {
  if (x == null) return "—";
  return `${(x * 100).toFixed(1)}%`;
}
