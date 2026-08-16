import { Router, type Request, type Response, type NextFunction } from "express";
import { badRequest } from "../core/errors.js";
import {
  createPayment,
  getPaymentByReference,
  getPaymentTimeline,
  listPayments,
} from "../core/txn-manager.js";
import { createPaymentSchema } from "./validation.js";
import type { Transaction } from "../core/types.js";

export const paymentsRouter = Router();

// Public JSON shape returned to merchants. We deliberately don't leak the
// internal numeric id — the aggregator reference is the public handle.
function toPublic(txn: Transaction) {
  return {
    paymentId: txn.aggregatorReference,
    status: txn.status,
    amount: txn.amount,
    currency: txn.currency,
    provider: txn.provider,
    paymentMethod: txn.paymentMethod,
    merchantReference: txn.merchantReference,
    failureCode: txn.failureCode,
    createdAt: txn.createdAt,
    updatedAt: txn.updatedAt,
  };
}

// POST /api/v1/payments
paymentsRouter.post(
  "/payments",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          "VALIDATION_ERROR",
          "Request body failed validation.",
          parsed.error.flatten(),
        );
      }
      const body = parsed.data;

      // Idempotency-Key is an HTTP header, per the spec's design.
      const idempotencyKey = req.header("Idempotency-Key")?.trim() || undefined;

      const { transaction, idempotentReplay } = await createPayment({
        merchantId: body.merchantId,
        merchantReference: body.merchantReference,
        amount: body.amount,
        currency: body.currency,
        paymentMethod: body.paymentMethod,
        customerEmail: body.customer?.email,
        idempotencyKey,
      });

      // A replay returns 200 (nothing new created); a fresh payment returns 201.
      res
        .status(idempotentReplay ? 200 : 201)
        .setHeader("Idempotent-Replay", String(idempotentReplay))
        .json(toPublic(transaction));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/payments — filterable, paginated list for the dashboard.
paymentsRouter.get(
  "/payments",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, provider, currency, merchantId, limit, offset } = req.query;
      const { items, total } = await listPayments({
        status: status ? String(status) : undefined,
        provider: provider ? String(provider) : undefined,
        currency: currency ? String(currency) : undefined,
        merchantId: merchantId ? String(merchantId) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json({ items: items.map(toPublic), total });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/payments/:reference
paymentsRouter.get(
  "/payments/:reference",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const txn = await getPaymentByReference(String(req.params.reference));
      res.json(toPublic(txn));
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/payments/:reference/timeline  (transaction inspector)
paymentsRouter.get(
  "/payments/:reference/timeline",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reference = String(req.params.reference);
      const events = await getPaymentTimeline(reference);
      res.json({ paymentId: reference, events });
    } catch (err) {
      next(err);
    }
  },
);
