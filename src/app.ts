import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { paymentsRouter } from "./api/payments.routes.js";
import { simulationRouter } from "./api/simulation.routes.js";
import { statsRouter } from "./api/stats.routes.js";
import { checkoutRouter } from "./api/checkout.routes.js";
import { routingRouter } from "./api/routing.routes.js";
import { reconciliationRouter } from "./api/reconciliation.routes.js";
import { faultsRouter } from "./api/faults.routes.js";
import { eventsRouter } from "./api/events.routes.js";
import { webhookRouter } from "./webhooks/receiver.js";
import { errorHandler } from "./api/error-handler.js";

export function createApp() {
  const app = express();

  app.use(pinoHttp({ logger }));

  // CORS — the merchant app (and a wrapped APK) call the JSON API cross-origin.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", config.corsOrigin);
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Idempotency-Key, x-admin-key",
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Webhooks are mounted FIRST and read the body raw (for signature checks), so
  // they must come before the JSON body parser below.
  app.use(webhookRouter);

  app.use(express.json());

  // Liveness probe.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "payflow-lab", phase: 8 });
  });

  // Versioned API surface — merchants only ever see this standardized shape.
  app.use("/api/v1", paymentsRouter);
  app.use("/api/v1", simulationRouter);
  app.use("/api/v1", statsRouter);
  app.use("/api/v1", checkoutRouter);
  app.use("/api/v1", routingRouter);
  app.use("/api/v1", reconciliationRouter);
  app.use("/api/v1", faultsRouter);
  app.use("/api/v1", eventsRouter);

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

  // Mobile-first merchant storefront (what a future APK wraps). Served from
  // public/ so it works same-origin with the API.
  const publicDir = join(rootDir, "public");
  if (existsSync(publicDir)) {
    app.use("/public", express.static(publicDir));
    app.get("/merchant", (_req, res) => {
      res.sendFile(join(publicDir, "merchant.html"));
    });
  }

  // Serve the built React dashboard (web/dist) if it exists. In dev you'd run
  // the Vite dev server instead (it proxies /api here); in a demo/prod build the
  // whole app runs on this one port.
  const webDist = join(rootDir, "web", "dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA fallback: any non-API, non-webhook GET returns index.html.
    app.get(/^\/(?!api\/|webhooks\/|health).*/, (_req, res) => {
      res.sendFile(join(webDist, "index.html"));
    });
  }

  // 404 for anything else.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  app.use(errorHandler);

  return app;
}
