import { Router } from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { getStripe, stripeEnabled } from "../lib/stripe.js";
import { effectiveRequirePaymentMethodToBook } from "../lib/paymentPolicy.js";
import {
  processPendingDriverPayoutsForDriverUserId,
  refreshDriverConnectStatus,
} from "../lib/driverPayout.js";

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
    let defaultPaymentMethodSummary = null;
    const pmId = user?.stripeDefaultPaymentMethodId?.trim();
    if (pmId && stripeEnabled()) {
      try {
        const stripe = getStripe();
        if (stripe) {
          const pm = await stripe.paymentMethods.retrieve(pmId);
          if (pm.type === "card" && pm.card) {
            const rawBrand = pm.card.display_brand || pm.card.brand || "card";
            defaultPaymentMethodSummary = {
              brand: typeof rawBrand === "string" ? rawBrand : "card",
              last4: typeof pm.card.last4 === "string" ? pm.card.last4 : "",
            };
          }
        }
      } catch (err) {
        console.error("GET /payments/config card summary", err);
      }
    }
    res.json({
      stripePublishableKey: publishableKeyFromEnv(),
      paymentsEnabled: stripeEnabled(),
      requirePaymentMethodToBook: effectiveRequirePaymentMethodToBook(),
      hasDefaultPaymentMethod,
      defaultPaymentMethodSummary,
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

function connectReturnUrls() {
  const refresh =
    typeof process.env.STRIPE_CONNECT_REFRESH_URL === "string" && process.env.STRIPE_CONNECT_REFRESH_URL.trim()
      ? process.env.STRIPE_CONNECT_REFRESH_URL.trim()
      : "http://localhost:8081/";
  const ret =
    typeof process.env.STRIPE_CONNECT_RETURN_URL === "string" && process.env.STRIPE_CONNECT_RETURN_URL.trim()
      ? process.env.STRIPE_CONNECT_RETURN_URL.trim()
      : "http://localhost:8081/";
  return { refresh, return: ret };
}

/** Driver: ensure Stripe Connect Express account exists (creates acct_ if missing). */
paymentsRouter.post("/connect/ensure-account", authMiddleware, requireRole("driver"), async (req, res) => {
  try {
    if (!stripeEnabled()) {
      res.status(503).json({ error: "Payments not configured" });
      return;
    }
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({ error: "Payments not configured" });
      return;
    }
    const prof = await DriverProfile.findOne({ userId: req.userId }).exec();
    if (!prof) {
      res.status(404).json({ error: "Driver profile not found" });
      return;
    }
    let acctId = typeof prof.stripeConnectAccountId === "string" ? prof.stripeConnectAccountId.trim() : "";
    if (!acctId.startsWith("acct_")) {
      const user = await User.findById(req.userId).select("email").lean().exec();
      const acct = await stripe.accounts.create({
        type: "express",
        country: "US",
        email: typeof user?.email === "string" && user.email.includes("@") ? user.email : undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { tncUserId: String(req.userId) },
      });
      acctId = acct.id;
      prof.stripeConnectAccountId = acctId;
      prof.stripeConnectPayoutsEnabled = Boolean(acct.payouts_enabled);
      prof.stripeConnectDetailsSubmitted = Boolean(acct.details_submitted);
      await prof.save();
    }
    res.json({
      ok: true,
      accountId: acctId,
      payoutsEnabled: Boolean(prof.stripeConnectPayoutsEnabled),
      detailsSubmitted: Boolean(prof.stripeConnectDetailsSubmitted),
    });
  } catch (e) {
    console.error("POST /payments/connect/ensure-account", e);
    res.status(500).json({ error: e?.raw?.message || e?.message || "Server error" });
  }
});

/** Driver: Stripe-hosted onboarding / update link. */
paymentsRouter.post("/connect/account-link", authMiddleware, requireRole("driver"), async (req, res) => {
  try {
    if (!stripeEnabled()) {
      res.status(503).json({ error: "Payments not configured" });
      return;
    }
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({ error: "Payments not configured" });
      return;
    }
    const prof = await DriverProfile.findOne({ userId: req.userId }).exec();
    if (!prof) {
      res.status(404).json({ error: "Driver profile not found" });
      return;
    }
    let acctId = typeof prof.stripeConnectAccountId === "string" ? prof.stripeConnectAccountId.trim() : "";
    if (!acctId.startsWith("acct_")) {
      res.status(400).json({ error: "Call POST /payments/connect/ensure-account first" });
      return;
    }
    const { refresh, return: returnUrl } = connectReturnUrls();
    const link = await stripe.accountLinks.create({
      account: acctId,
      refresh_url: refresh,
      return_url: returnUrl,
      type: "account_onboarding",
    });
    res.json({ url: link.url, expiresAt: link.expires_at });
  } catch (e) {
    console.error("POST /payments/connect/account-link", e);
    res.status(500).json({ error: e?.raw?.message || e?.message || "Server error" });
  }
});

/** Driver: pull Connect flags from Stripe and retry any pending_connect trip payouts. */
paymentsRouter.post("/connect/sync", authMiddleware, requireRole("driver"), async (req, res) => {
  try {
    const refreshed = await refreshDriverConnectStatus(req.userId);
    if (!refreshed.ok && refreshed.error === "no_connect_account") {
      res.json({
        ok: true,
        payoutsEnabled: false,
        detailsSubmitted: false,
        retriedTrips: [],
        message: "Create a Connect account first (POST /payments/connect/ensure-account).",
      });
      return;
    }
    if (!refreshed.ok) {
      res.status(400).json({ error: refreshed.error || "sync_failed" });
      return;
    }
    const payouts = await processPendingDriverPayoutsForDriverUserId(req.userId);
    res.json({
      ok: true,
      payoutsEnabled: refreshed.payoutsEnabled,
      detailsSubmitted: refreshed.detailsSubmitted,
      retriedTrips: payouts,
    });
  } catch (e) {
    console.error("POST /payments/connect/sync", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});
