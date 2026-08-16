# PayFlow Lab — How-To Guide

Everything you need to run, use, and demo the payment aggregator: how to start it,
every dashboard page, the full API, and how to search transaction logs (the way
you'd query Rapid7 during an incident).

- Dashboard: **http://localhost:3000**
- API base: **http://localhost:3000/api/v1**
- Health check: **http://localhost:3000/health**

---

## 1. Start it up

You need **Docker Desktop running** (for Postgres). Then, from the project root:

```bash
# 1. Start the database
docker compose up -d

# 2. First time only: install deps + create the schema + build the dashboard
npm install
npm run migrate
npm run web:install
npm run web:build

# 3. Start the server (serves API + dashboard on one port)
npm run dev
```

Open **http://localhost:3000**.

> **Important:** the server checks for the built dashboard (`web/dist`) at startup.
> If you rebuild the dashboard, **restart the server** so it serves the new build.

**Two ways to run the UI:**

| Mode | Commands | When |
|------|----------|------|
| Single server | `npm run web:build` then `npm run dev` → open `:3000` | demos, the simple path |
| Hot reload | `npm run dev` **and** `npm run web:dev` → open `:5173` | editing the React UI |

**If the server won't start / a page is stale** — a previous server may still hold
port 3000. On Windows:

```bash
# PowerShell: find and kill whatever owns port 3000
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 2. The dashboard — every page

The dashboard is a single app at **http://localhost:3000**; switch pages with the
tabs across the top.

| Tab | What it's for |
|-----|---------------|
| **Overview** | KPI tiles (transactions, approval rate, value), the traffic generator, and per-PSP performance with health. Your at-a-glance operations screen. |
| **Transactions** | Filterable, paginated list of every payment. Click a row to open the **inspector** — full details plus the event timeline. |
| **Logs** | Search the transaction event log across all payments (see §4). Your incident-investigation console. |
| **Reconciliation** | Run a reconciliation over a time window and drill into findings by type. |
| **Routing** | See and switch the routing strategy live; view provider health and capabilities. |
| **Incidents** | Start an incident drill or inject faults manually, then diagnose using the other tabs. |

### Typical demo flow
1. **Overview → Start simulation** (e.g. 500 @ 200/s). Watch the tiles fill in.
2. **Transactions** → click a `failed` or `pending` payment → read its timeline.
3. **Reconciliation** → run over a 3-minute window → click a `Status mismatch` tile.
4. **Incidents** → **Start random incident** → diagnose → **Resolve** to reveal the cause.

---

## 3. API reference

Base URL: `http://localhost:3000/api/v1`. All bodies are JSON. Amounts are in
**minor units** (e.g. `49900` = 499.00).

### Payments

**`POST /api/v1/payments`** — create a (simulated) payment.
Optional header `Idempotency-Key: <key>` dedupes retries.
```bash
curl -X POST http://localhost:3000/api/v1/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: ORDER-123' \
  -d '{"merchantId":"M1","amount":49900,"currency":"ZAR","paymentMethod":"card","customer":{"email":"a@b.com"}}'
```

**`GET /api/v1/payments`** — list/filter payments.
Query params: `status`, `provider`, `currency`, `merchantId`, `limit`, `offset`.
```bash
curl "http://localhost:3000/api/v1/payments?status=failed&provider=stripe&limit=25"
```

**`GET /api/v1/payments/:reference`** — one payment by its `PAY_…` reference.

**`GET /api/v1/payments/:reference/timeline`** — the event timeline for one payment.

### Simulation

**`POST /api/v1/simulation/start`** — generate bulk traffic.
```bash
curl -X POST http://localhost:3000/api/v1/simulation/start \
  -H 'Content-Type: application/json' -d '{"transactions":1000,"transactionsPerSecond":200}'
```
**`GET /api/v1/simulation`** — list runs. **`GET /api/v1/simulation/:runId`** — progress.

### Stats

**`GET /api/v1/stats`** — totals, approval rate, value, per-provider performance.

### Event log (see §4)

**`GET /api/v1/events`** — search events. Params: `type`, `reference`, `provider`,
`sinceMinutes`, `limit`.

### Routing

**`GET /api/v1/routing`** — strategy, weights, capabilities, live provider health.
**`POST /api/v1/routing`** — switch strategy: `{"strategy":"performance"}`
(`rules` | `weighted` | `performance`).

### Reconciliation

**`POST /api/v1/reconciliation/run`** — `{"windowMinutes":60}`; returns counts + `runId`.
**`GET /api/v1/reconciliation`** — list runs.
**`GET /api/v1/reconciliation/:runId`** — full findings.

### Fault injection & incidents

**`GET /api/v1/faults`** — active faults per provider.
**`POST /api/v1/faults`** — inject: `{"provider":"stripe","authError":true}`.
Knobs: `authError`, `forceTimeout`, `webhooksDisabled`, `successRate` (0–1),
`httpErrorRate` (0–1), `extraLatencyMs`.
**`DELETE /api/v1/faults/:provider`** — clear one. **`POST /api/v1/faults/clear`** — clear all.
**`POST /api/v1/incidents/start`** — start a drill (root cause hidden).
**`GET /api/v1/incidents`** — list. **`POST /api/v1/incidents/:id/resolve`** — reveal + fix.

### Real Paystack checkout (needs `PAYSTACK_SECRET_KEY` in `.env`)

**`POST /api/v1/checkout`** — `{"merchantId","amount","currency","customer":{"email"}}`;
returns an `authorizationUrl` to open. **`POST /api/v1/checkout/:reference/verify`** — poll now.

### Webhooks (called by the PSP, not you)

**`POST /webhooks/:provider`** — `stripe` | `paystack` | `flutterwave` | `payfast` |
`ozow` | `peach` | `airtel` | `mpesa` | `capitec`. Signature-verified.

> **Providers:** all nine above are **simulated** today (no credentials needed).
> Real sandbox integrations (Paystack, PayFast first) are planned for later; the
> adapter layer is built so each can be swapped to real independently.

---

## 4. Checking transaction logs (the Rapid7 equivalent)

At WalletTec you searched transaction logs in Rapid7. Here, **every state change a
payment goes through is written as a log event** (`payment_events`), and there are
three ways to read them — from finest to broadest.

### A. One payment's story — the timeline
The clearest view. **Transactions tab → click a payment**, or:
```bash
curl http://localhost:3000/api/v1/payments/PAY_123456/timeline
```
You'll see the full life of that payment, e.g.:
```
PAYMENT_CREATED → ROUTING_DECISION → PSP_REQUEST_SENT → PSP_RESPONSE_RECEIVED
→ WEBHOOK_RECEIVED → WEBHOOK_SIGNATURE_VERIFIED → PAYMENT_CONFIRMED
```

### B. Search across ALL payments — the Logs tab (this is the Rapid7-style view)
**Logs tab** — filter by **event type**, **provider**, **reference**, and a **time
window**, exactly like a saved log query. Or via the API:
```bash
# All failed PSP responses on stripe in the last 15 minutes
curl "http://localhost:3000/api/v1/events?type=PSP_RESPONSE_RECEIVED&provider=stripe&sinceMinutes=15"

# Everything that happened to one payment
curl "http://localhost:3000/api/v1/events?reference=PAY_123456"

# Recent routing failovers (retries kicking in)
curl "http://localhost:3000/api/v1/events?type=ROUTING_FAILOVER&sinceMinutes=30"
```

**Rapid7 → PayFlow Lab mental map:**

| In Rapid7 you… | Here you… |
|----------------|-----------|
| pick a log set | choose an **event type** (or leave "all") |
| filter by a field (e.g. host, user) | filter by **provider** / **reference** |
| set a time range | set **Since (min)** |
| read the raw log line | read the **detail** JSON column |

**Event types you'll search for:**
`PAYMENT_CREATED`, `ROUTING_DECISION`, `ROUTING_FAILOVER`, `PSP_REQUEST_SENT`,
`PSP_RESPONSE_RECEIVED`, `RETRY_VERIFY`, `VERIFY_RESULT`, `RETRY_SCHEDULED`,
`WEBHOOK_RECEIVED`, `WEBHOOK_SIGNATURE_VERIFIED`, `PAYMENT_CONFIRMED`,
`STATUS_CHANGED`, `PSP_VERIFY`, `CHECKOUT_INITIALIZED`.

### C. System logs — the server console
The server also emits **structured (Pino) logs** to its terminal: every HTTP
request, plus operational events like `WEBHOOK_SIGNATURE_INVALID`,
`WEBHOOK_DUPLICATE_IGNORED`, and reconciliation summaries. This is the
lower-level, infrastructure view (like the raw agent logs feeding Rapid7).

### D. Query the database directly (deepest)
```bash
docker exec payflow-db psql -U payflow -c \
  "SELECT created_at, type, detail FROM payment_events ORDER BY id DESC LIMIT 20;"
```

---

## 5. Running an incident drill (put it together)

1. **Incidents tab → Start random incident.** You get a *symptom*, not the cause.
2. **Investigate** like on-call:
   - **Overview** → which provider's approval rate dropped, or is `pending` piling up?
   - **Logs** → filter to that provider; look for `INVALID_API_KEY`, `PSP_TIMEOUT`,
     or missing `WEBHOOK_RECEIVED` events.
   - **Reconciliation** → run it; a spike in `Status mismatch` means money was taken
     but not recorded (webhooks down).
3. **Form the root cause**, then **Resolve** to check yourself (it reveals the cause
   and lifts the fault).

You can also inject faults manually (Incidents tab, or `POST /api/v1/faults`) to
rehearse a specific failure: expired credentials, provider timeouts, dead webhooks,
or a degraded approval rate.

---

## 6. Where things live (for reference)

| Area | Path |
|------|------|
| Payment API + state machine | `src/api/`, `src/core/` |
| PSP adapters (fake + real Paystack) | `src/providers/` |
| Webhooks (receive/verify/dedup) | `src/webhooks/` |
| Reconciliation | `src/recon/` |
| Dashboard (React) | `web/src/` |
| Database schema | `db/schema.sql` |
| Example API calls | `requests.http` |
