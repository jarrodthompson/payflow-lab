import { Router, type Request, type Response, type NextFunction, raw } from "express";
import { badRequest } from "../core/errors.js";
import { getCodec } from "./codecs.js";
import { processWebhook } from "./processor.js";
import type { Provider } from "../core/types.js";

export const webhookRouter = Router();

const KNOWN: Provider[] = [
  "stripe",
  "paystack",
  "flutterwave",
  "payfast",
  "ozow",
  "peach",
  "airtel",
  "mpesa",
  "capitec",
];

// Webhook bodies must be read RAW (as bytes), because signature verification
// runs over the exact bytes the PSP signed. So this router uses express.raw and
// is mounted BEFORE the global express.json() parser.
webhookRouter.post(
  "/webhooks/:provider",
  raw({ type: "*/*" }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = String(req.params.provider) as Provider;
      if (!KNOWN.includes(provider)) {
        throw badRequest("UNKNOWN_PROVIDER", `Unknown provider: ${provider}`);
      }

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : "";
      const signatureHeader = req.header(getCodec(provider).signatureHeader);

      const result = await processWebhook(provider, rawBody, signatureHeader);
      res.status(result.httpStatus).json({
        received: true,
        outcome: result.outcome,
        ...result.detail,
      });
    } catch (err) {
      next(err);
    }
  },
);
