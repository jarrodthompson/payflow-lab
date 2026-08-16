import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { badRequest, notFound } from "../core/errors.js";
import { getRun, listRuns, startRun } from "../simulation/runner.js";
import { requireAdmin } from "./auth.js";

export const simulationRouter = Router();

const startSchema = z.object({
  transactions: z.number().int().positive().max(100000),
  transactionsPerSecond: z.number().int().positive().max(1000).default(20),
});

// POST /simulation/start  { transactions, transactionsPerSecond }
simulationRouter.post(
  "/simulation/start",
  requireAdmin,
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = startSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          "VALIDATION_ERROR",
          "Invalid simulation parameters.",
          parsed.error.flatten(),
        );
      }
      const { transactions, transactionsPerSecond } = parsed.data;
      const state = startRun(transactions, transactionsPerSecond);
      res.status(202).json(state);
    } catch (err) {
      next(err);
    }
  },
);

// GET /simulation/:runId — progress + live outcome breakdown
simulationRouter.get(
  "/simulation/:runId",
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = getRun(String(req.params.runId));
      if (!state) throw notFound(`No simulation run ${req.params.runId}`);
      res.json(state);
    } catch (err) {
      next(err);
    }
  },
);

// GET /simulation — list runs
simulationRouter.get("/simulation", (_req: Request, res: Response) => {
  res.json({ runs: listRuns() });
});
