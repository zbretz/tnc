import { Router } from "express";
import Stripe from "stripe";
import { DriverProfile } from "../models/DriverProfile.js";
import { stripeEnabled } from "../lib/stripe.js";
import { processPendingDriverPayoutsForDriverUserId } from "../lib/driverPayout.js";

export const stripeWebhookRouter = Router();

/**
 * Raw body required. Mount with: app.use("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookRouter)
 */
stripeWebhookRouter.post("/", async (req, res) => {
  const whSecret = typeof process.env.STRIPE_WEBHOOK_SECRET === "string" ? process.env.STRIPE_WEBHOOK_SECRET.trim() : "";
  if (!whSecret) {
    res.status(503).json({ error: "STRIPE_WEBHOOK_SECRET not configured" });
    return;
  }
  if (!stripeEnabled()) {
    res.status(503).json({ error: "Stripe not configured" });
    return;
  }
  const sig = req.headers["stripe-signature"];
  if (typeof sig !== "string") {
    res.status(400).json({ error: "Missing stripe-signature" });
    return;
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (e) {
    console.error("[tnc] stripe webhook signature", e?.message || e);
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  try {
    if (event.type === "account.updated") {
      const acct = event.data.object;
      const id = typeof acct.id === "string" ? acct.id : "";
      if (id.startsWith("acct_")) {
        await DriverProfile.updateOne(
          { stripeConnectAccountId: id },
          {
            $set: {
              stripeConnectPayoutsEnabled: Boolean(acct.payouts_enabled),
              stripeConnectDetailsSubmitted: Boolean(acct.details_submitted),
            },
          }
        ).exec();
        const prof = await DriverProfile.findOne({ stripeConnectAccountId: id }).select("userId").lean().exec();
        if (prof?.userId) {
          void processPendingDriverPayoutsForDriverUserId(prof.userId).catch((e) =>
            console.error("[tnc] webhook processPendingDriverPayouts", e)
          );
        }
      }
    }
  } catch (e) {
    console.error("[tnc] stripe webhook handler", e);
    res.status(500).json({ error: "handler_error" });
    return;
  }

  res.json({ received: true });
});
