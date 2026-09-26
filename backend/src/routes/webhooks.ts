import express, { Router } from "express";
import { config } from "../config.js";
import { verifyWebhook } from "../webhookSignature.js";
import { emitChainEvent, fromDelivery, isOurs, saveEvent, type WebhookDelivery } from "../chainEvents.js";
import { treasuryAddress } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";

/// POST /webhooks/multibaas — MultiBaas pushes every event of the linked
/// contracts here as it's mined (scripts/multibaas-setup.ts registers it).
/// The signature covers the exact bytes sent, so this route reads the raw
/// body and must be mounted before express.json() (index.ts).
export const webhooksRouter = Router();

webhooksRouter.post(
  "/webhooks/multibaas",
  express.raw({ type: "*/*", limit: "2mb" }),
  asyncHandler(async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const check = verifyWebhook({
      secret: config.multibaas.webhookSecret,
      rawBody,
      signature: req.header("X-MultiBaas-Signature"),
      timestamp: req.header("X-MultiBaas-Timestamp"),
    });
    if (!check.ok) {
      res.status(401).json({ error: check.reason });
      return;
    }

    let deliveries: WebhookDelivery[];
    try {
      const parsed = JSON.parse(rawBody.toString("utf8"));
      deliveries = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      res.status(400).json({ error: "body is not JSON" });
      return;
    }

    let stored = 0;
    for (const d of deliveries) {
      if (d.event !== "event.emitted") continue; // transaction.included isn't subscribed
      const event = fromDelivery(d);
      if (!(await isOurs(event, treasuryAddress))) continue;
      if (await saveEvent(event)) {
        stored++;
        await emitChainEvent(event);
      }
    }
    res.json({ ok: true, stored });
  }),
);
