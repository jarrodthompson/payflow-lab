import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { badRequest } from "../core/errors.js";
import { config } from "../config.js";
import {
  getCapabilities,
  getStrategy,
  setStrategy,
  type RoutingStrategy,
} from "../core/routing.js";
import { getAllHealth } from "../core/provider-health.js";
import { requireAdmin } from "./auth.js";

export const routingRouter = Router();

// GET /api/v1/routing — current strategy, weights, capabilities, live health.
routingRouter.get("/routing", (_req: Request, res: Response) => {
  res.json({
    strategy: getStrategy(),
    weights: config.routing.weights,
    maxAttempts: config.routing.maxAttempts,
    capabilities: getCapabilities(),
    providerHealth: getAllHealth(),
  });
});

const setSchema = z.object({
  strategy: z.enum(["rules", "weighted", "performance"]),
});

// POST /api/v1/routing — switch strategy at runtime (great for experiments).
routingRouter.post("/routing", requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        "VALIDATION_ERROR",
        "strategy must be one of: rules, weighted, performance",
        parsed.error.flatten(),
      );
    }
    setStrategy(parsed.data.strategy as RoutingStrategy);
    res.json({ strategy: getStrategy() });
  } catch (err) {
    next(err);
  }
});
