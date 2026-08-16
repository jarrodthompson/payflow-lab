import { Router, type Request, type Response, type NextFunction } from "express";
import { searchEvents } from "../core/txn-manager.js";

export const eventsRouter = Router();

// GET /api/v1/events — searchable transaction event log (the "log console").
// Filters: type, reference (partial), provider, sinceMinutes, limit.
eventsRouter.get("/events", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, reference, provider, sinceMinutes, limit } = req.query;
    const result = await searchEvents({
      type: type ? String(type) : undefined,
      reference: reference ? String(reference) : undefined,
      provider: provider ? String(provider) : undefined,
      sinceMinutes: sinceMinutes ? Number(sinceMinutes) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
