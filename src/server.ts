import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/pool.js";
import { applySchema } from "./db/schema.js";
import { startHealthMonitor } from "./core/provider-health.js";

async function start() {
  // Optional: create the schema on boot (for hosts without a separate migrate step).
  if (config.autoMigrate) {
    try {
      await applySchema();
      logger.info("AUTO_MIGRATE: schema applied.");
    } catch (err) {
      logger.error({ err }, "AUTO_MIGRATE failed");
    }
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`PayFlow Lab listening on ${config.baseUrl}`);
    // Begin periodic provider-health refresh (used by performance routing).
    startHealthMonitor();
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
