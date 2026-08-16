# PayFlow Lab — Payment Aggregation & Orchestration Simulator

A simulated multi-PSP payment aggregation platform for learning real payment
operations: routing, webhooks, idempotency, retries, reconciliation, monitoring,
failure injection, and incident diagnostics.

Merchants integrate against **one standardized API**, regardless of which PSP
(Stripe / Paystack / Flutterwave) ultimately handles a transaction.

## Status: Phase 3 (of 8)

| Phase | Scope | State |
|------|-------|-------|
| **1** | Node/TS + Express + PostgreSQL, transactions schema + state machine, `POST /payments` with idempotency | ✅ |
| **2** | Fake PSP (outcome distribution + latency) + bulk transaction generator (`POST /simulation/start`) + `/stats` | ✅ |
| **3** | Async webhooks: signed delivery, per-provider signature verification, event dedup, stuck-pending | ✅ |
| **4** | Real **Paystack** sandbox via `/checkout` (initialize + poll verify), kept separate from the fake simulation engine | ✅ |
| **5** | Capability-aware routing (rules / weighted / performance) + retry, failover, verify-before-retry | ✅ |
| **6** | Reconciliation engine: PSP ledger vs our ledger → status/amount mismatch, missing, duplicate findings | ✅ |
| **7** | React operations dashboard (overview, transactions + inspector, reconciliation, routing) | ✅ |
| **8** | Fault injection + incident drills + transaction log search | ✅ |

**All 8 phases complete.** For a full walkthrough — running it, every page, the API,
and how to search transaction logs — see **[GUIDE.md](GUIDE.md)**.

## Stack

Node.js + TypeScript · Express · PostgreSQL · Pino (logging) · Zod (validation).
Docker Compose for Postgres. (Redis/BullMQ, Grafana/Prometheus, k6, React arrive
in later phases.)

## Getting started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Start Postgres** (needs Docker on your PATH)

   ```bash
   docker compose up -d
   ```

   No Docker yet? Point `DATABASE_URL` in `.env` at any local Postgres instead.

3. **Configure env**

   ```bash
   cp .env.example .env
   ```

4. **Create the schema**

   ```bash
   npm run migrate        # add --reset to drop and recreate
   ```

5. **Run the API**

   ```bash
   npm run dev            # http://localhost:3000
   ```

## API (Phase 1)

### `POST /api/v1/payments`

Header (optional but recommended): `Idempotency-Key: <your-key>`

```json
{
  "merchantId": "MERCHANT_001",
  "amount": 49900,
  "currency": "ZAR",
  "paymentMethod": "card",
  "customer": { "email": "test@example.com" }
}
```

`amount` is in **minor units** (49900 == R499.00). Returns `201` for a new
payment, `200` for an idempotent replay. The response uses the public shape:

```json
{
  "paymentId": "PAY_847293",
  "status": "processing",
  "amount": 49900,
  "currency": "ZAR",
  "provider": "flutterwave"
}
```

### `GET /api/v1/payments/:reference`

Fetch a payment by its aggregator reference.

### `GET /api/v1/payments/:reference/timeline`

The event timeline for a payment (the basis of the future transaction inspector).

### `POST /api/v1/simulation/start`  (Phase 2)

Generate bulk dummy traffic. Returns `202` with a run id immediately; generation
runs in the background paced to the target rate.

```json
{ "transactions": 1000, "transactionsPerSecond": 200 }
```

Poll `GET /api/v1/simulation/:runId` for live progress and the outcome breakdown,
or `GET /api/v1/simulation` to list runs. The fake PSP samples outcomes ~85%
success / 5% declined / ~7% failed / ~2% pending, so you get a realistic mix of
transactions to investigate.

### `GET /api/v1/stats`  (Phase 2)

Aggregate overview: totals, approval rate, transaction value, and per-provider
performance — the raw data behind the future ops dashboard.

### `POST /webhooks/:provider`  (Phase 3)

Inbound webhook endpoint (`stripe` | `paystack` | `flutterwave`). The fake PSP
calls this over real HTTP to deliver the terminal outcome. The body is read raw
and its signature verified before anything else:

- **Stripe** — `Stripe-Signature: t=..,v1=..`, HMAC-SHA256 over `${t}.${body}`
- **Paystack** — `x-paystack-signature`, HMAC-SHA512 over the raw body
- **Flutterwave** — `verif-hash`, a static secret compared directly

Bad signature → `401`. Each event is deduped on `(provider, event_id)`, so a
duplicate delivery is acknowledged (`200`) but processed only once.

## How a payment flows (Phase 3 — async)

```
POST /payments -> validate -> idempotency -> route (by currency)
   -> INSERT (processing) -> PSP.initiatePayment()
        -> synchronous technical failure? -> failed        (no webhook)
        -> otherwise -> pending  (ack now, outcome to follow)

... later, over HTTP ...
POST /webhooks/:provider -> verify signature -> dedup on event_id
   -> match by provider_reference -> pending -> success | declined | failed
```

Undelivered webhooks (the `PENDING` / `WEBHOOK_FAILED` outcomes) leave a payment
stuck in `pending` on purpose — the classic thing you have to investigate. Every
step writes to `payment_events`, so each payment has a full timeline
(`PAYMENT_CREATED → ROUTING_DECISION → PSP_REQUEST_SENT → PSP_RESPONSE_RECEIVED →
WEBHOOK_RECEIVED → WEBHOOK_SIGNATURE_VERIFIED → PAYMENT_CONFIRMED`).

## Real Paystack sandbox (Phase 4)

Two engines run side by side: the **fake PSP** drives bulk/failure **simulation**
(`/payments`, `/simulation`), and a **real Paystack adapter** handles authentic
single transactions via **`/checkout`**. Real hosted checkouts can't be automated
at volume, so this is for genuine end-to-end test payments.

**Setup (one time):**

1. In your Paystack dashboard → Settings → API Keys, copy your **TEST secret key**
   (`sk_test_...`).
2. Put it in `.env`:  `PAYSTACK_SECRET_KEY=sk_test_xxx`
3. Restart the server (`npm run dev`).

**Flow:**

### `POST /api/v1/checkout`

```json
{ "merchantId": "M1", "amount": 500000, "currency": "NGN", "customer": { "email": "you@example.com" } }
```

Returns an `authorizationUrl`. Open it, pay with a Paystack
[test card](https://paystack.com/docs/payments/test-payments/) (e.g. success card
`4084 0840 8408 4081`, any future expiry, any CVV). Amount is in **minor units**
(kobo/cents). Currency must be one your Paystack account supports (Nigerian test
accounts are `NGN`; `ZAR` needs a South African account).

The server then **polls** `/transaction/verify` every 5s for ~3 min and updates
the payment automatically. You can also poll manually:

### `POST /api/v1/checkout/:reference/verify`

Verifies against Paystack now and applies the outcome. Idempotent — this is what a
"refresh status" button hits. Watch the payment's `/timeline` to see
`CHECKOUT_INITIALIZED → PSP_VERIFY → PAYMENT_CONFIRMED`.

## Routing & retries (Phase 5)

The router is an orchestrator. Each provider has **capabilities** — the
currencies **and** payment methods it supports — so only *eligible* providers are
considered for a given `(currency, method)`:

| Provider | Currencies | Methods |
|----------|-----------|---------|
| stripe | USD, EUR, GBP, ZAR | card |
| paystack | NGN, GHS, ZAR, USD | card, bank_transfer |
| flutterwave | NGN, KES, GHS, ZAR, USD | card, mobile_money, bank_transfer |
| payfast | ZAR | card, bank_transfer |
| ozow | ZAR | bank_transfer |
| peach | ZAR, USD, KES | card, mobile_money |
| airtel | KES, UGX, TZS | mobile_money |
| mpesa | KES, TZS | mobile_money |
| capitec | ZAR | bank_transfer, wallet |

So e.g. `ZAR + bank_transfer` routes across payfast/ozow/paystack/flutterwave/
capitec; `KES + mobile_money` across airtel/mpesa/peach/flutterwave; `ZAR + wallet`
only capitec.

> **PSP roster:** stripe/paystack/flutterwave and the six above are all **simulated**
> providers today. Real sandbox integrations (Paystack and PayFast first) are
> planned for later — the adapter seam (`src/providers/`) is built for it, so a
> real adapter drops in per-provider without touching the rest of the system.

**Three strategies** (switch at runtime):

- **rules** — deterministic priority by base weight.
- **weighted** — distribute across eligible providers by base weight (stripe 50 /
  flutterwave 30 / paystack 20).
- **performance** — prefer providers with a healthy recent success rate (from a
  cached rolling window), routing *around* a degraded one.

**Retry / failover** on a technical failure (`PSP_TIMEOUT`, `PSP_ERROR`): the
payment rolls to the next eligible provider (up to `maxAttempts`, with backoff).
On a **timeout** specifically, we **verify before retrying** — if the charge
actually went through, we settle it as `success` instead of risking a double
charge. The timeline shows `PSP_REQUEST_SENT → PSP_RESPONSE_RECEIVED →
RETRY_VERIFY → VERIFY_RESULT → RETRY_SCHEDULED → ROUTING_FAILOVER → ...`.

### `GET /api/v1/routing`

Current strategy, weights, capabilities, and live per-provider health.

### `POST /api/v1/routing`  `{ "strategy": "performance" }`

Switch strategy at runtime (`rules` | `weighted` | `performance`).

## Reconciliation (Phase 6)

The fake PSP keeps its **own ground-truth ledger** (`psp_ledger`) of what it
actually did, written at decision time — independent of whether our webhook ever
arrived. Reconciliation compares our `transactions` against that ledger over a
window and reports every disagreement:

| Finding | Meaning |
|---------|---------|
| `STATUS_MISMATCH` | we and the PSP disagree on the outcome (e.g. we say `pending`, PSP says `success` — money received but not recorded) |
| `AMOUNT_MISMATCH` | same charge, different amount |
| `MISSING_AT_PSP` | we think it succeeded, PSP has no record |
| `MISSING_IN_AGGREGATOR` | PSP charged, we have no transaction |
| `DUPLICATE` | the PSP settled the same charge more than once |

Stuck-pending payments (webhooks that never arrived) surface here **organically**
as `STATUS_MISMATCH`. A little realistic noise (wrong amounts, duplicate/phantom
rows) is injected into the PSP ledger so every finding type appears; set
`RECON_NOISE=off` in `.env` for a perfectly honest ledger.

### `POST /api/v1/reconciliation/run`  `{ "windowMinutes": 60 }`

Run reconciliation now; returns counts and a `runId`. (Use a short window right
after a simulation so you only compare freshly-generated data.)

### `GET /api/v1/reconciliation/:runId`

Full findings for a run — each row is one thing to investigate.

### `GET /api/v1/reconciliation`

List recent runs.

## Operations dashboard (Phase 7)

A React + TypeScript (Vite) single-page app in `web/`, the screen a Payment
Integration Specialist actually works in:

- **Overview** — stat tiles (transactions, approval rate, value), a traffic
  generator, and the per-PSP performance table with live health.
- **Transactions** — filterable, paginated list; click any row for the
  **inspector**: payment details + the full event timeline.
- **Reconciliation** — run a reconciliation over a window; click a finding-type
  tile to filter the findings table.
- **Routing** — switch strategy live and see provider health + capabilities.

**Run it two ways:**

Dev (hot reload, two processes):

```bash
npm run dev          # API on :3000  (terminal 1)
npm run web:dev      # dashboard on :5173, proxies /api -> :3000  (terminal 2)
```

Single-server (build once, Express serves it on :3000):

```bash
npm run web:install  # first time only
npm run web:build    # emits web/dist
npm run dev          # open http://localhost:3000
```

> The Express server registers static serving at startup, so **build the web app
> before starting the server** (or restart the server after building).

## Fault injection, incidents & log search (Phase 8)

The **Incidents** dashboard tab (and the fault API) let you deliberately break a
provider, then diagnose the fallout using the other tabs — the on-call loop.

- **Inject a fault:** `POST /api/v1/faults` `{ "provider": "stripe", "authError": true }`
  — knobs: `authError`, `forceTimeout`, `webhooksDisabled`, `successRate`,
  `httpErrorRate`, `extraLatencyMs`. Clear with `DELETE /api/v1/faults/:provider`.
- **Incident drill:** `POST /api/v1/incidents/start` applies a *hidden* fault to a
  random provider and returns only the symptom. Investigate, then
  `POST /api/v1/incidents/:id/resolve` to reveal the root cause and lift the fault.
- **Log search:** `GET /api/v1/events?type=&provider=&reference=&sinceMinutes=` —
  the searchable transaction event log (also the **Logs** dashboard tab). See
  [GUIDE.md §4](GUIDE.md) for the Rapid7-style investigation workflow.

## Design notes

- **Amounts are integers in minor units** — never floats. This avoids rounding
  bugs, which are a classic payments footgun.
- **The state machine** (`src/core/state-machine.ts`) is the single place that
  decides which status transitions are legal. Illegal moves are rejected.
- **Idempotency** is keyed on `(merchantId, Idempotency-Key)`. Reusing a key
  with a different body is a `409` — that mirrors real PSP behavior.
- **Routing** is currency-based for now (`ZAR→Flutterwave`, `NGN→Paystack`,
  `USD→Stripe`); weighted/performance routing lands in Phase 5.
- **Phase 1 stops at `processing`** — no real PSP is called yet, so payments sit
  in `processing` after routing. Phases 2–4 drive them to a final state.

## Project layout

```
src/
  api/        HTTP layer: routes, validation, error handler
  core/       domain: types, state machine, router, txn-manager, errors
  db/         pool + migration runner
  config.ts   env config
  logger.ts   Pino logger
  app.ts      Express app wiring
  server.ts   HTTP server + graceful shutdown
db/schema.sql the database schema
```
