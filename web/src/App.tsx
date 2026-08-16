import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  api,
  money,
  pct,
  type EventLogRow,
  type Incident,
  type Overview,
  type Payment,
  type ProviderFault,
  type ReconFinding,
  type ReconSummary,
  type RoutingInfo,
  type TimelineEvent,
} from "./api";

type Tab =
  | "overview"
  | "transactions"
  | "logs"
  | "reconciliation"
  | "routing"
  | "incidents";

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> PayFlow Lab
          <span className="sub">Operations</span>
        </div>
        <nav className="tabs">
          {(
            [
              "overview",
              "transactions",
              "logs",
              "reconciliation",
              "routing",
              "incidents",
            ] as Tab[]
          ).map((t) => (
            <button
              key={t}
              className={t === tab ? "tab active" : "tab"}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === "overview" && <OverviewView />}
        {tab === "transactions" && <TransactionsView />}
        {tab === "logs" && <LogsView />}
        {tab === "reconciliation" && <ReconciliationView />}
        {tab === "routing" && <RoutingView />}
        {tab === "incidents" && <IncidentsView />}
      </main>
    </div>
  );
}

/* ------------------------------- Overview -------------------------------- */

function OverviewView() {
  const [data, setData] = useState<Overview | null>(null);
  const [routing, setRouting] = useState<RoutingInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setErr(null);
      const [o, r] = await Promise.all([api.overview(), api.routing()]);
      setData(o);
      setRouting(r);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <ErrorBox msg={err} />;
  if (!data) return <Loading />;

  const t = data.totals;
  return (
    <div className="stack">
      <SimulationLauncher onDone={load} />
      <section className="tiles">
        <Tile label="Transactions" value={t.transactions.toLocaleString()} />
        <Tile label="Approval rate" value={pct(t.approvalRate)} accent="green" />
        <Tile label="Successful" value={t.successful.toLocaleString()} accent="green" />
        <Tile label="Declined" value={t.declined.toLocaleString()} accent="amber" />
        <Tile label="Failed" value={t.failed.toLocaleString()} accent="red" />
        <Tile label="Pending" value={t.pending.toLocaleString()} accent="blue" />
        <Tile label="Value (success)" value={money(t.valueMinor)} />
      </section>

      <section className="panel">
        <h2>PSP performance</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>Provider</th>
              <th className="num">Transactions</th>
              <th className="num">Successful</th>
              <th className="num">Success rate</th>
              <th className="num">Value</th>
              <th className="num">Health</th>
            </tr>
          </thead>
          <tbody>
            {data.byProvider.map((p) => {
              const h = routing?.providerHealth.find((x) => x.provider === p.provider);
              return (
                <tr key={p.provider}>
                  <td className="mono">{p.provider}</td>
                  <td className="num">{p.transactions.toLocaleString()}</td>
                  <td className="num">{p.successful.toLocaleString()}</td>
                  <td className="num">{pct(p.successRate)}</td>
                  <td className="num">{money(p.valueMinor)}</td>
                  <td className="num">
                    {h ? (
                      <span className={h.healthy ? "pill ok" : "pill bad"}>
                        {h.healthy ? "healthy" : "degraded"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function SimulationLauncher({ onDone }: { onDone: () => void }) {
  const [count, setCount] = useState(500);
  const [tps, setTps] = useState(200);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function start() {
    setRunning(true);
    setMsg("starting…");
    try {
      const run = await api.startSimulation(count, tps);
      // Poll until complete.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await api.simRun(run.id);
        setMsg(`generating… ${s.created}/${s.requested}`);
        if (s.status !== "running") break;
      }
      setMsg("done");
      onDone();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel launcher">
      <div>
        <h2>Traffic generator</h2>
        <p className="muted">Push simulated payments through the aggregator.</p>
      </div>
      <div className="launcher-controls">
        <label>
          Count
          <input
            type="number"
            value={count}
            min={1}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </label>
        <label>
          TPS
          <input
            type="number"
            value={tps}
            min={1}
            onChange={(e) => setTps(Number(e.target.value))}
          />
        </label>
        <button className="btn primary" disabled={running} onClick={() => void start()}>
          {running ? "Running…" : "Start simulation"}
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </section>
  );
}

/* ----------------------------- Transactions ------------------------------ */

const STATUSES = [
  "",
  "success",
  "declined",
  "failed",
  "pending",
  "processing",
  "refunded",
];
const PROVIDERS = [
  "",
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
const ALL_PROVIDERS = PROVIDERS.filter(Boolean);

function TransactionsView() {
  const [items, setItems] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const limit = 25;

  const load = useCallback(async () => {
    const res = await api.payments({ status, provider, limit, offset: page * limit });
    setItems(res.items);
    setTotal(res.total);
  }, [status, provider, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="stack">
      <section className="panel">
        <div className="filters">
          <label>
            Status
            <select
              value={status}
              onChange={(e) => {
                setPage(0);
                setStatus(e.target.value);
              }}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s || "all"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select
              value={provider}
              onChange={(e) => {
                setPage(0);
                setProvider(e.target.value);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p || "all"}
                </option>
              ))}
            </select>
          </label>
          <span className="muted total">{total.toLocaleString()} transactions</span>
        </div>

        <table className="grid rows">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Provider</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th>Failure</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.paymentId} className="clickable" onClick={() => setSelected(p.paymentId)}>
                <td className="mono">{p.paymentId}</td>
                <td className="mono">{p.provider ?? "—"}</td>
                <td className="num">{money(p.amount, p.currency)}</td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td className="mono muted">{p.failureCode ?? "—"}</td>
                <td className="muted">{new Date(p.createdAt).toLocaleTimeString()}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted center">
                  No transactions. Run a simulation on the Overview tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="pager">
          <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </button>
          <span className="muted">
            Page {page + 1} / {pages}
          </span>
          <button
            className="btn"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      </section>

      {selected && <Inspector reference={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Inspector({ reference, onClose }: { reference: string; onClose: () => void }) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  useEffect(() => {
    void (async () => {
      const [p, t] = await Promise.all([api.payment(reference), api.timeline(reference)]);
      setPayment(p);
      setEvents(t.events);
    })();
  }, [reference]);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2 className="mono">{reference}</h2>
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        {!payment ? (
          <Loading />
        ) : (
          <>
            <div className="kv">
              <Field k="Status" v={<StatusBadge status={payment.status} />} />
              <Field k="Provider" v={payment.provider ?? "—"} mono />
              <Field k="Amount" v={money(payment.amount, payment.currency)} />
              <Field k="Method" v={payment.paymentMethod} />
              <Field k="Merchant ref" v={payment.merchantReference ?? "—"} mono />
              <Field k="Failure" v={payment.failureCode ?? "—"} mono />
            </div>
            <h3>Event timeline</h3>
            <ol className="timeline">
              {events.map((e, i) => (
                <li key={i}>
                  <span className="tl-time">
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="tl-type">{e.type}</span>
                  {Object.keys(e.detail).length > 0 && (
                    <code className="tl-detail">{JSON.stringify(e.detail)}</code>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>
    </div>
  );
}

/* ---------------------------- Reconciliation ----------------------------- */

const FINDING_LABELS: Record<string, string> = {
  STATUS_MISMATCH: "Status mismatch",
  AMOUNT_MISMATCH: "Amount mismatch",
  MISSING_AT_PSP: "Missing at PSP",
  MISSING_IN_AGGREGATOR: "Missing in aggregator",
  DUPLICATE: "Duplicate",
};

function ReconciliationView() {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [summary, setSummary] = useState<ReconSummary | null>(null);
  const [findings, setFindings] = useState<ReconFinding[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const s = await api.runRecon(windowMinutes);
      setSummary(s);
      const detail = await api.reconRun(s.runId);
      setFindings(detail.findings);
      setFilter("");
    } finally {
      setBusy(false);
    }
  }

  const shown = filter ? findings.filter((f) => f.type === filter) : findings;

  return (
    <div className="stack">
      <section className="panel launcher">
        <div>
          <h2>Reconciliation</h2>
          <p className="muted">
            Compare our ledger against the PSP ledger. Tip: use a short window right
            after a simulation.
          </p>
        </div>
        <div className="launcher-controls">
          <label>
            Window (min)
            <input
              type="number"
              min={1}
              value={windowMinutes}
              onChange={(e) => setWindowMinutes(Number(e.target.value))}
            />
          </label>
          <button className="btn primary" disabled={busy} onClick={() => void run()}>
            {busy ? "Running…" : "Run reconciliation"}
          </button>
        </div>
      </section>

      {summary && (
        <>
          <section className="tiles">
            <Tile label="Checked" value={summary.checked.toLocaleString()} />
            <Tile label="Matched" value={summary.matched.toLocaleString()} accent="green" />
            {Object.entries(summary.counts).map(([k, v]) => (
              <button
                key={k}
                className={`tile clickable-tile ${filter === k ? "sel" : ""}`}
                onClick={() => setFilter(filter === k ? "" : k)}
              >
                <span className="tile-label">{FINDING_LABELS[k] ?? k}</span>
                <span className={`tile-value ${v > 0 ? "warn" : ""}`}>{v}</span>
              </button>
            ))}
          </section>

          <section className="panel">
            <h2>Findings {filter && <span className="muted">· {FINDING_LABELS[filter]}</span>}</h2>
            <table className="grid rows">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Reference</th>
                  <th>Provider</th>
                  <th>Our status</th>
                  <th>PSP status</th>
                  <th className="num">Our amt</th>
                  <th className="num">PSP amt</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <span className="pill warn-pill">{FINDING_LABELS[f.type] ?? f.type}</span>
                    </td>
                    <td className="mono">{f.aggregator_reference ?? "—"}</td>
                    <td className="mono">{f.provider ?? "—"}</td>
                    <td>{f.our_status ?? "—"}</td>
                    <td>{f.psp_status ?? "—"}</td>
                    <td className="num">{money(f.our_amount)}</td>
                    <td className="num">{money(f.psp_amount)}</td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted center">
                      No findings — everything reconciled.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

/* -------------------------------- Routing -------------------------------- */

function RoutingView() {
  const [info, setInfo] = useState<RoutingInfo | null>(null);

  const load = useCallback(async () => setInfo(await api.routing()), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  if (!info) return <Loading />;

  return (
    <div className="stack">
      <section className="panel">
        <h2>Routing strategy</h2>
        <div className="strategy-row">
          {(["rules", "weighted", "performance"] as const).map((s) => (
            <button
              key={s}
              className={`btn ${info.strategy === s ? "primary" : ""}`}
              onClick={async () => {
                await api.setStrategy(s);
                void load();
              }}
            >
              {s}
            </button>
          ))}
          <span className="muted">
            max attempts: {info.maxAttempts} · weights{" "}
            {Object.entries(info.weights)
              .map(([k, v]) => `${k}:${v}`)
              .join("  ")}
          </span>
        </div>
      </section>

      <section className="panel">
        <h2>Provider health</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>Provider</th>
              <th className="num">Decided</th>
              <th className="num">Success rate</th>
              <th>Health</th>
              <th>Currencies</th>
              <th>Methods</th>
            </tr>
          </thead>
          <tbody>
            {info.providerHealth.map((h) => {
              const capsForProvider = info.capabilities[h.provider];
              return (
                <tr key={h.provider}>
                  <td className="mono">{h.provider}</td>
                  <td className="num">{h.decided}</td>
                  <td className="num">{pct(h.successRate)}</td>
                  <td>
                    <span className={h.healthy ? "pill ok" : "pill bad"}>
                      {h.healthy ? "healthy" : "degraded"}
                    </span>
                  </td>
                  <td className="mono muted">
                    {(capsForProvider?.currencies ?? []).join(", ")}
                  </td>
                  <td className="mono muted">
                    {(capsForProvider?.methods ?? []).join(", ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* --------------------------------- Logs ---------------------------------- */

const EVENT_TYPES = [
  "",
  "PAYMENT_CREATED",
  "ROUTING_DECISION",
  "ROUTING_FAILOVER",
  "PSP_REQUEST_SENT",
  "PSP_RESPONSE_RECEIVED",
  "RETRY_VERIFY",
  "VERIFY_RESULT",
  "RETRY_SCHEDULED",
  "WEBHOOK_RECEIVED",
  "WEBHOOK_SIGNATURE_VERIFIED",
  "PAYMENT_CONFIRMED",
  "STATUS_CHANGED",
  "PSP_VERIFY",
  "CHECKOUT_INITIALIZED",
];

function LogsView() {
  const [rows, setRows] = useState<EventLogRow[]>([]);
  const [type, setType] = useState("");
  const [provider, setProvider] = useState("");
  const [reference, setReference] = useState("");
  const [sinceMinutes, setSinceMinutes] = useState(30);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.events({
        type,
        provider,
        reference,
        sinceMinutes,
        limit: 200,
      });
      setRows(res.items);
    } finally {
      setLoading(false);
    }
  }, [type, provider, reference, sinceMinutes]);

  useEffect(() => {
    void search();
  }, [search]);

  return (
    <div className="stack">
      <section className="panel">
        <h2>Transaction log search</h2>
        <p className="muted">
          Every state change is an event. Search across all transactions the way you'd
          query a log platform during an incident.
        </p>
        <div className="filters">
          <label>
            Event type
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t || "all"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p || "all"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reference contains
            <input
              value={reference}
              placeholder="PAY_…"
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label>
            Since (min)
            <input
              type="number"
              min={1}
              value={sinceMinutes}
              onChange={(e) => setSinceMinutes(Number(e.target.value))}
            />
          </label>
          <button className="btn primary" onClick={() => void search()}>
            {loading ? "Searching…" : "Search"}
          </button>
        </div>

        <table className="grid rows">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Reference</th>
              <th>Provider</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="muted mono">{new Date(r.createdAt).toLocaleTimeString()}</td>
                <td className="mono">{r.type}</td>
                <td className="mono">{r.aggregatorReference}</td>
                <td className="mono">{r.provider ?? "—"}</td>
                <td className="mono muted detail-cell">
                  {Object.keys(r.detail).length ? JSON.stringify(r.detail) : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted center">
                  No log events match. Widen the time window or clear filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ------------------------------- Incidents ------------------------------- */

const FAULT_BUTTONS: { key: keyof ProviderFault; label: string; value: boolean | number }[] = [
  { key: "authError", label: "Expire credentials", value: true },
  { key: "forceTimeout", label: "Force timeouts", value: true },
  { key: "webhooksDisabled", label: "Kill webhooks", value: true },
  { key: "successRate", label: "Degrade (60%)", value: 0.6 },
];

function IncidentsView() {
  const [faults, setFaults] = useState<Record<string, ProviderFault>>({});
  const [incidents, setIncidents] = useState<Incident[]>([]);

  const load = useCallback(async () => {
    const [f, i] = await Promise.all([api.faults(), api.incidents()]);
    setFaults(f.faults);
    setIncidents(i.incidents);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(provider: string, key: keyof ProviderFault, value: boolean | number) {
    await api.setFault(provider, { [key]: value } as ProviderFault);
    void load();
  }
  async function clearP(provider: string) {
    await api.clearFault(provider);
    void load();
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="launcher">
          <div>
            <h2>Incident drill</h2>
            <p className="muted">
              Start a random incident, then diagnose it using Overview, Logs, and
              Reconciliation. Reveal the root cause only when you've found it.
            </p>
          </div>
          <div className="launcher-controls">
            <button
              className="btn primary"
              onClick={async () => {
                await api.startIncident();
                void load();
              }}
            >
              Start random incident
            </button>
            <button
              className="btn"
              onClick={async () => {
                await api.clearAllFaults();
                void load();
              }}
            >
              Clear all faults
            </button>
          </div>
        </div>
        {incidents.length > 0 && (
          <table className="grid rows">
            <thead>
              <tr>
                <th>Incident</th>
                <th>Symptom</th>
                <th>Status</th>
                <th>Root cause</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((inc) => (
                <tr key={inc.id}>
                  <td className="mono">{inc.id}</td>
                  <td>{inc.symptom}</td>
                  <td>
                    <span className={inc.status === "active" ? "pill bad" : "pill ok"}>
                      {inc.status}
                    </span>
                  </td>
                  <td className="muted">
                    {inc.rootCause ?? "— (investigate, then resolve to reveal)"}
                  </td>
                  <td>
                    {inc.status === "active" && (
                      <button
                        className="btn"
                        onClick={async () => {
                          await api.resolveIncident(inc.id);
                          void load();
                        }}
                      >
                        Resolve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Manual fault injection</h2>
        <p className="muted">Break a provider on demand and watch the effects propagate.</p>
        <table className="grid">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Active faults</th>
              <th>Inject</th>
            </tr>
          </thead>
          <tbody>
            {ALL_PROVIDERS.map((p) => {
              const active = faults[p] ?? {};
              const activeKeys = Object.keys(active);
              return (
                <tr key={p}>
                  <td className="mono">{p}</td>
                  <td>
                    {activeKeys.length ? (
                      <span className="pill bad">{activeKeys.join(", ")}</span>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td>
                    <div className="fault-btns">
                      {FAULT_BUTTONS.map((b) => (
                        <button
                          key={b.key}
                          className="btn small"
                          onClick={() => void toggle(p, b.key, b.value)}
                        >
                          {b.label}
                        </button>
                      ))}
                      <button className="btn small ghost" onClick={() => void clearP(p)}>
                        Clear
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ------------------------------ UI helpers ------------------------------- */

function Tile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "green" | "red" | "amber" | "blue";
}) {
  return (
    <div className={`tile ${accent ?? ""}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

function Field({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="field">
      <span className="field-k">{k}</span>
      <span className={mono ? "field-v mono" : "field-v"}>{v}</span>
    </div>
  );
}

function Loading() {
  return <div className="muted center pad">Loading…</div>;
}

function ErrorBox({ msg }: { msg: string }) {
  return <div className="errorbox">Could not load data: {msg}</div>;
}
