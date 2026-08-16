import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { badRequest, ApiError } from "../core/errors.js";
import { createCheckout, verifyCheckout } from "../core/checkout.js";
import { isPaystackConfigured } from "../providers/real/paystack.js";

export const checkoutRouter = Router();

const checkoutSchema = z.object({
  merchantId: z.string().trim().min(1),
  merchantReference: z.string().trim().min(1).optional(),
  amount: z.number().int().positive(), // minor units
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  customer: z.object({ email: z.string().email() }),
});

// POST /api/v1/checkout — start a REAL Paystack sandbox transaction.
checkoutRouter.post(
  "/checkout",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isPaystackConfigured()) {
        throw new ApiError(
          503,
          "PAYSTACK_NOT_CONFIGURED",
          "Live checkout is disabled. Add PAYSTACK_SECRET_KEY (sk_test_...) to .env and restart.",
        );
      }
      const parsed = checkoutSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest("VALIDATION_ERROR", "Invalid checkout body.", parsed.error.flatten());
      }
      const body = parsed.data;
      const { transaction, authorizationUrl } = await createCheckout({
        merchantId: body.merchantId,
        merchantReference: body.merchantReference,
        amount: body.amount,
        currency: body.currency,
        email: body.customer.email,
      });
      res.status(201).json({
        paymentId: transaction.aggregatorReference,
        status: transaction.status,
        provider: "paystack",
        amount: transaction.amount,
        currency: transaction.currency,
        authorizationUrl, // open this to complete payment with a test card
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/checkout/:reference/verify — poll Paystack now and apply outcome.
checkoutRouter.post(
  "/checkout/:reference/verify",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const txn = await verifyCheckout(String(req.params.reference));
      res.json({
        paymentId: txn.aggregatorReference,
        status: txn.status,
        provider: txn.provider,
        failureCode: txn.failureCode,
        failureMessage: txn.failureMessage,
      });
    } catch (err) {
      next(err);
    }
  },
);
