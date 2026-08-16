import { Router, type Request, type Response, type NextFunction } from "express";
import { getOverview } from "../core/stats.js";

export const statsRouter = Router();

// GET /stats — aggregate overview (the raw data behind the future dashboard)
statsRouter.get("/stats", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getOverview());
  } catch (err) {
    next(err);
  }
});
