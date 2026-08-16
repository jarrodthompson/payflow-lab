import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

// Guard for admin/operator endpoints (fault injection, incidents, simulation,
// routing changes, reconciliation runs). When ADMIN_API_KEY is set, callers must
// send it as `x-admin-key`. When it's empty (local dev), the gate is a no-op.
//
// This keeps the merchant-facing endpoints (POST /payments, GET reads) open while
// preventing strangers from triggering incidents on a public deployment.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminApiKey) {
    next(); // gate disabled in dev
    return;
  }
  const provided = req.header("x-admin-key");
  if (provided && provided === config.adminApiKey) {
    next();
    return;
  }
  res.status(401).json({
    error: { code: "UNAUTHORIZED", message: "Missing or invalid x-admin-key." },
  });
}
