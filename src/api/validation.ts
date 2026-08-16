import { z } from "zod";

// ISO-4217-ish: exactly 3 letters. We don't validate the full code list here.
const currency = z
  .string()
  .trim()
  .length(3, "currency must be a 3-letter code")
  .regex(/^[A-Za-z]{3}$/, "currency must be letters only");

export const createPaymentSchema = z.object({
  merchantId: z.string().trim().min(1),
  merchantReference: z.string().trim().min(1).optional(),
  // amount is in MINOR units (e.g. cents) and must be a positive integer.
  amount: z.number().int("amount must be an integer in minor units").positive(),
  currency,
  paymentMethod: z.enum(["card", "bank_transfer", "mobile_money", "wallet"]),
  customer: z
    .object({
      email: z.string().email().optional(),
    })
    .optional(),
});

export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;
