-- PayFlow Lab — Phase 1 schema
-- Run via: npm run migrate

-- ---------------------------------------------------------------------------
-- transactions: the core table and your troubleshooting environment.
-- amount is stored in MINOR units (e.g. cents), so R499.00 == 49900.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    aggregator_reference TEXT        NOT NULL UNIQUE,          -- e.g. PAY_847293
    merchant_id          TEXT        NOT NULL,
    merchant_reference   TEXT,                                  -- merchant's own order id (optional)
    provider             TEXT,                                  -- stripe | paystack | flutterwave (chosen by router)
    provider_reference   TEXT,                                  -- id returned by the PSP (filled later)
    payment_method       TEXT        NOT NULL,
    amount               BIGINT      NOT NULL CHECK (amount > 0),
    currency             CHAR(3)     NOT NULL,
    customer_email       TEXT,
    status               TEXT        NOT NULL DEFAULT 'created',
    failure_code         TEXT,
    failure_message      TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 4: hosted-checkout URL for real (redirect-based) PSPs like Paystack.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS checkout_url TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions (merchant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status   ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_provider ON transactions (provider);
CREATE INDEX IF NOT EXISTS idx_transactions_created  ON transactions (created_at);

-- ---------------------------------------------------------------------------
-- idempotency_keys: dedupe inbound merchant POST /payments requests.
-- A merchant sends the SAME key when retrying; we return the original payment.
-- request_hash lets us detect key reuse with a DIFFERENT body (a client bug).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id    TEXT        NOT NULL,
    idem_key       TEXT        NOT NULL,
    request_hash   TEXT        NOT NULL,
    transaction_id BIGINT      NOT NULL REFERENCES transactions (id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, idem_key)
);

-- ---------------------------------------------------------------------------
-- payment_events: append-only timeline for the transaction inspector.
-- Every meaningful state change / action gets a row here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
    id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id BIGINT      NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    type           TEXT        NOT NULL,                        -- PAYMENT_CREATED, ROUTING_DECISION, ...
    detail         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_txn ON payment_events (transaction_id, created_at);

-- ---------------------------------------------------------------------------
-- webhook_events: dedupe inbound PSP webhooks by the PSP's event id.
-- Populated in a later phase; created now so the schema is stable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider     TEXT        NOT NULL,
    event_id     TEXT        NOT NULL,                          -- PSP's unique event id
    payload      JSONB       NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- psp_ledger: the PSP's OWN record of what it did — the source of truth we
-- reconcile against. For the fake providers this is written at decision time.
-- Intentionally NOT unique on provider_reference, so duplicate rows (a real
-- reconciliation hazard) can exist and be detected.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS psp_ledger (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider             TEXT        NOT NULL,
    provider_reference   TEXT        NOT NULL,
    aggregator_reference TEXT,                                  -- null for phantom rows
    status               TEXT        NOT NULL,                  -- success | declined | failed
    amount               BIGINT      NOT NULL,
    currency             CHAR(3)     NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_psp_ledger_ref ON psp_ledger (provider, provider_reference);
CREATE INDEX IF NOT EXISTS idx_psp_ledger_created ON psp_ledger (created_at);

-- ---------------------------------------------------------------------------
-- reconciliation runs + findings: each run compares transactions vs psp_ledger
-- over a window and stores the discrepancies for investigation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    window_minutes INT         NOT NULL,
    checked        INT         NOT NULL DEFAULT 0,
    matched        INT         NOT NULL DEFAULT 0,
    summary        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reconciliation_findings (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id               BIGINT      NOT NULL REFERENCES reconciliation_runs (id) ON DELETE CASCADE,
    type                 TEXT        NOT NULL,   -- STATUS_MISMATCH | AMOUNT_MISMATCH | MISSING_AT_PSP | MISSING_IN_AGGREGATOR | DUPLICATE
    aggregator_reference TEXT,
    provider             TEXT,
    provider_reference   TEXT,
    our_status           TEXT,
    psp_status           TEXT,
    our_amount           BIGINT,
    psp_amount           BIGINT,
    detail               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recon_findings_run ON reconciliation_findings (run_id, type);
