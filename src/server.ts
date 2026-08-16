import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/pool.js";
import { applySchema } from "./db/schema.js";
import { startHealthMonitor } from "./core/provider-health.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Apply the schema in the BACKGROUND with backoff. Runs after the server is
// already listening, so a temporarily-unreachable DB (or a tripped pooler
// circuit breaker) doesn't block startup or fail the deploy — it just keeps
// retrying, with increasing delays, until it succeeds.
async function migrateWithRetry() {
  let delay = 3000;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await applySchema();
      logger.info("AUTO_MIGRATE: schema applied.");
      return;
    } catch (err) {
      logger.warn(
        { attempt, nextRetryMs: delay, err: (err as Error).message },
        "AUTO_MIGRATE attempt failed; will retry",
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
  logger.error("AUTO_MIGRATE gave up after retries; check DATABASE_URL.");
}

async function start() {
  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`PayFlow Lab listening on ${config.baseUrl}`);
    // Begin periodic provider-health refresh (used by performance routing).
    startHealthMonitor();
    // Create the schema in the background (does not block the deploy).
    if (config.autoMigrate) void migrateWithRetry();
  });
  return server;
}

const serverPromise = start();

// Graceful shutdown so the DB pool closes cleanly.
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down...`);
  const server = await serverPromise;
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
