import { Router } from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { getStripe, stripeEnabled } from "../lib/stripe.js";
import { effectiveRequirePaymentMethodToBook } from "../lib/paymentPolicy.js";

export const paymentsRouter = Router();

function publishableKeyFromEnv() {
  const k = process.env.STRIPE_PUBLISHABLE_KEY;
  return typeof k === "string" ? k.trim() : "";
}

/** No auth — app shell before login if needed. */
paymentsRouter.get("/public-config", (_req, res) => {
  res.json({
    stripePublishableKey: publishableKeyFromEnv(),
    paymentsEnabled: stripeEnabled(),
    requirePaymentMethodToBook: effectiveRequirePaymentMethodToBook(),
  });
});

paymentsRouter.get("/config", authMiddleware, requireRole("rider"), async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("stripeDefaultPaymentMethodId").lean().exec();
    const hasDefaultPaymentMethod = Boolean(user?.stripeDefaultPaymentMethodId?.trim());
    res.json({
      stripePublishableKey: publishableKeyFromEnv(),
      paymentsEnabled: stripeEnabled(),
      requirePaymentMethodToBook: effectiveRequirePaymentMethodToBook(),
      hasDefaultPaymentMethod,
    });
  } catch (e) {
    console.error("GET /payments/config", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});

async function ensureStripeCustomer(user) {
  const stripe = getStripe();
  if (!stripe) return null;
  if (user.stripeCustomerId) return { stripe, user };
  const customer = await stripe.customers.create({
    metadata: { tncUserId: String(user._id) },
  });
  user.stripeCustomerId = customer.id;
  await user.save();
  return { stripe, user };
}

/** Rider: SetupIntent client secret for Payment Sheet (save card for off-session use later). */
paymentsRouter.post("/setup-intent", authMiddleware, requireRole("rider"), async (req, res) => {
  try {
    if (!stripeEnabled()) {
      res.status(503).json({ error: "Payments not configured (STRIPE_SECRET_KEY)" });
      return;
    }
    const user = await User.findById(req.userId).exec();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const ensured = await ensureStripeCustomer(user);
    if (!ensured) {
      res.status(503).json({ error: "Payments not configured" });
      return;
    }
    const { stripe, user: u } = ensured;
    const si = await stripe.setupIntents.create({
      customer: u.stripeCustomerId,
      usage: "off_session",
      payment_method_types: ["card"],
    });
    res.json({ clientSecret: si.client_secret, customerId: u.stripeCustomerId });
  } catch (e) {
    console.error("POST /payments/setup-intent", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});

/** Rider: set default payment method after Payment Sheet success. */
paymentsRouter.post("/default-payment-method", authMiddleware, requireRole("rider"), async (req, res) => {
  const pmId = typeof req.body?.paymentMethodId === "string" ? req.body.paymentMethodId.trim() : "";
  if (!pmId || !pmId.startsWith("pm_")) {
    res.status(400).json({ error: "paymentMethodId (pm_...) required" });
    return;
  }
  try {
    if (!stripeEnabled()) {
      res.status(503).json({ error: "Payments not configured (STRIPE_SECRET_KEY)" });
      return;
    }
    const user = await User.findById(req.userId).exec();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const ensured = await ensureStripeCustomer(user);
    if (!ensured) {
      res.status(503).json({ error: "Payments not configured" });
      return;
    }
    const { stripe, user: u } = ensured;
    const pm = await stripe.paymentMethods.retrieve(pmId);
    if (pm.customer && pm.customer !== u.stripeCustomerId) {
      res.status(400).json({ error: "Payment method belongs to another customer" });
      return;
    }
    if (!pm.customer) {
      await stripe.paymentMethods.attach(pmId, { customer: u.stripeCustomerId });
    }
    await stripe.customers.update(u.stripeCustomerId, {
      invoice_settings: { default_payment_method: pmId },
    });
    u.stripeDefaultPaymentMethodId = pmId;
    await u.save();
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /payments/default-payment-method", e);
    res.status(500).json({ error: e?.raw?.message || e?.message || "Server error" });
  }
});
