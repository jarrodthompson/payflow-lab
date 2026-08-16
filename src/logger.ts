import pino from "pino";
import { config } from "./config.js";

// Structured logging (Pino). In dev we pretty-print; in prod we emit JSON,
// which is what a real ops stack (Grafana/Loki, etc.) would ingest.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: config.isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
    : undefined,
});
