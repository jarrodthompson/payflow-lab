import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { badRequest, notFound } from "../core/errors.js";
import { getReconRun, listReconRuns, runReconciliation } from "../recon/engine.js";
import { requireAdmin } from "./auth.js";

export const reconciliationRouter = Router();

const runSchema = z.object({
  windowMinutes: z.number().int().positive().max(10080).default(60),
});

// POST /api/v1/reconciliation/run  { windowMinutes? } — run recon now.
reconciliationRouter.post(
  "/reconciliation/run",
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = runSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw badRequest("VALIDATION_ERROR", "Invalid parameters.", parsed.error.flatten());
      }
      const summary = await runReconciliation(parsed.data.windowMinutes);
      res.status(201).json(summary);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/reconciliation — list recent runs.
reconciliationRouter.get(
  "/reconciliation",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ runs: await listReconRuns() });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/reconciliation/:runId — run summary + all findings.
reconciliationRouter.get(
  "/reconciliation/:runId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const runId = Number(req.params.runId);
      if (!Number.isInteger(runId)) throw badRequest("BAD_ID", "runId must be an integer");
      const result = await getReconRun(runId);
      if (!result) throw notFound(`No reconciliation run ${runId}`);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);
