import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../core/errors.js";
import { IllegalTransitionError } from "../core/state-machine.js";
import { logger } from "../logger.js";

// Central error handler: turns thrown errors into a consistent JSON envelope
// { error: { code, message, details? } } and the right HTTP status.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }

  if (err instanceof IllegalTransitionError) {
    res.status(409).json({
      error: { code: "ILLEGAL_TRANSITION", message: err.message },
    });
    return;
  }

  logger.error({ err }, "Unhandled error");
  res
    .status(500)
    .json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
}
