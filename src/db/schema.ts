import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./pool.js";

// Side-effect-free schema helpers, shared by the migrate CLI and the server's
// optional AUTO_MIGRATE. Importing this file does NOT run anything.
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "..", "db", "schema.sql");

export const RESET_SQL = `
  DROP TABLE IF EXISTS reconciliation_findings CASCADE;
  DROP TABLE IF EXISTS reconciliation_runs CASCADE;
  DROP TABLE IF EXISTS psp_ledger CASCADE;
  DROP TABLE IF EXISTS webhook_events CASCADE;
  DROP TABLE IF EXISTS payment_events CASCADE;
  DROP TABLE IF EXISTS idempotency_keys CASCADE;
  DROP TABLE IF EXISTS transactions CASCADE;
`;

// Apply db/schema.sql (idempotent — IF NOT EXISTS throughout).
export async function applySchema(): Promise<void> {
  const schema = readFileSync(schemaPath, "utf8");
  await pool.query(schema);
}

export async function resetSchema(): Promise<void> {
  await pool.query(RESET_SQL);
}
