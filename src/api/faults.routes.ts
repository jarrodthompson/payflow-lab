import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { badRequest, notFound } from "../core/errors.js";
import {
  clearAllFaults,
  clearFault,
  getAllFaults,
  setFault,
} from "../core/faults.js";
import {
  getIncident,
  listIncidents,
  maskIncident,
  resolveIncident,
  startRandomIncident,
} from "../core/incidents.js";
import { requireAdmin } from "./auth.js";
import type { Provider } from "../core/types.js";

export const faultsRouter = Router();

const PROVIDERS = [
  "stripe",
  "paystack",
  "flutterwave",
  "payfast",
  "ozow",
  "peach",
  "airtel",
  "mpesa",
  "capitec",
] as const;

const faultSchema = z.object({
  provider: z.enum(PROVIDERS),
  authError: z.boolean().optional(),
  forceTimeout: z.boolean().optional(),
  successRate: z.number().min(0).max(1).optional(),
  webhooksDisabled: z.boolean().optional(),
  httpErrorRate: z.number().min(0).max(1).optional(),
  extraLatencyMs: z.number().int().min(0).max(60000).optional(),
});

// ---- Fault injection ----------------------------------------------------

faultsRouter.get("/faults", (_req: Request, res: Response) => {
  res.json({ faults: getAllFaults() });
});

faultsRouter.post("/faults", requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = faultSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("VALIDATION_ERROR", "Invalid fault config.", parsed.error.flatten());
    }
    const { provider, ...fault } = parsed.data;
    const merged = setFault(provider as Provider, fault);
    res.json({ provider, fault: merged });
  } catch (err) {
    next(err);
  }
});

faultsRouter.delete("/faults/:provider", requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = String(req.params.provider);
    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      throw badRequest("UNKNOWN_PROVIDER", `Unknown provider: ${provider}`);
    }
    clearFault(provider as Provider);
    res.json({ provider, cleared: true });
  } catch (err) {
    next(err);
  }
});

faultsRouter.post("/faults/clear", requireAdmin, (_req: Request, res: Response) => {
  clearAllFaults();
  res.json({ cleared: true });
});

// ---- Incident drills ----------------------------------------------------

faultsRouter.post("/incidents/start", requireAdmin, (_req: Request, res: Response) => {
  const inc = startRandomIncident();
  // Masked: you get the symptom, not the root cause — go investigate.
  res.status(201).json(maskIncident(inc, false));
});

faultsRouter.get("/incidents", (_req: Request, res: Response) => {
  res.json({ incidents: listIncidents().map((i) => maskIncident(i, !!i.resolvedAt)) });
});

faultsRouter.get("/incidents/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const inc = getIncident(String(req.params.id));
    if (!inc) throw notFound(`No incident ${req.params.id}`);
    const reveal = req.query.reveal === "true" || !!inc.resolvedAt;
    res.json(maskIncident(inc, reveal));
  } catch (err) {
    next(err);
  }
});

faultsRouter.post("/incidents/:id/resolve", requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const inc = resolveIncident(String(req.params.id));
    if (!inc) throw notFound(`No incident ${req.params.id}`);
    res.json(maskIncident(inc, true)); // reveal on resolve
  } catch (err) {
    next(err);
  }
});
