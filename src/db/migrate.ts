import { pool } from "./pool.js";
import { logger } from "../logger.js";
import { applySchema, resetSchema } from "./schema.js";

// Migration CLI: applies db/schema.sql (idempotent). Pass --reset to drop first.
async function main() {
  const reset = process.argv.includes("--reset");
  try {
    if (reset) {
      logger.warn("Resetting database (dropping all PayFlow tables)...");
      await resetSchema();
    }
    await applySchema();
    logger.info("Migration complete.");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
