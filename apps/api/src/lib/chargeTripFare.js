import { computeFareEstimate } from "../fareEstimate.js";
import { getStripe, stripeEnabled } from "./stripe.js";

const USD_MIN_CHARGE_CENTS = 50;

function numEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Max tip in cents: min(TNC_MAX_TIP_USD * 100, 200% of fare when fare > 0; else absolute cap only).
 */
export function maxTipCentsAllowed(fareCents) {
  const absMax = Math.round(numEnv("TNC_MAX_TIP_USD", 500) * 100);
  if (!fareCents || fareCents <= 0) return absMax;
  return Math.min(absMax, Math.round(fareCents * 2));
}

/**
 * @param {import("mongoose").Document} trip
 * @returns {Promise<{ ok: true, totalUsd: number, currency: string } | { ok: false, error: string }>}
 */
export async function resolveTripFareUsd(trip) {
  const t = trip?.fareEstimate?.total;
  if (t != null && Number.isFinite(Number(t))) {
    return {
      ok: true,
      totalUsd: Number(t),
      currency: typeof trip.fareEstimate.currency === "string" ? trip.fareEstimate.currency : "USD",
    };
  }
  const pickup = trip?.pickup;
  const dropoff = trip?.dropoff;
  if (!pickup || dropoff == null || typeof dropoff !== "object") {
    return { ok: false, error: "no_estimate" };
  }
  const out = await computeFareEstimate(pickup, dropoff);
  if (!out.ok) {
    return { ok: false, error: out.error || "estimate_failed" };
  }
  return {
    ok: true,
    totalUsd: out.estimate.total,
    currency: out.estimate.currency || "USD",
  };
}

function resetChargeFields(trip) {
  trip.fareChargeAmountCents = null;
  trip.fareChargeFareCents = null;
  trip.fareChargeTipCents = null;
  trip.fareChargeCurrency = "";
  trip.stripePaymentIntentId = "";
  trip.fareChargeError = "";
}

/**
 * One PaymentIntent for fare + rider tip (off-session). Mutates `trip` charge fields; does not save.
 * @param {import("mongoose").Document} trip
 * @param {import("mongoose").Document} rider
 * @param {{ retry?: boolean }} [options] — `retry: true` uses a fresh idempotency key (after a failed / no-PM attempt).
 */
export async function applyFareChargeToTrip(trip, rider, options = {}) {
  const isRetry = options.retry === true;
  const stripe = getStripe();

  const rawTip = trip.riderTipAmountCents;
  let tipCents =
    rawTip != null && Number.isFinite(Number(rawTip)) ? Math.max(0, Math.round(Number(rawTip))) : 0;

  if (!stripeEnabled() || !stripe) {
    trip.fareChargeStatus = "skipped_stripe_disabled";
    resetChargeFields(trip);
    return;
  }

  const fare = await resolveTripFareUsd(trip);
  if (!fare.ok) {
    trip.fareChargeStatus = "skipped_no_estimate";
    resetChargeFields(trip);
    trip.fareChargeError = tipCents > 0 ? "Fare estimate required before tipping or completing ride." : fare.error || "";
    return;
  }

  const currency = (fare.currency || "USD").toLowerCase();
  const totalUsd = fare.totalUsd;
  const fareCents = totalUsd > 0 ? Math.round(totalUsd * 100) : 0;
  tipCents = Math.min(tipCents, maxTipCentsAllowed(fareCents));

  const totalChargeCents = fareCents + tipCents;

  trip.fareChargeFareCents = fareCents;
  trip.fareChargeTipCents = tipCents;

  if (totalUsd <= 0 && tipCents <= 0) {
    trip.fareChargeStatus = "waived";
    trip.fareChargeAmountCents = 0;
    trip.fareChargeCurrency = currency;
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = "";
    return;
  }

  if (totalChargeCents <= 0) {
    trip.fareChargeStatus = "waived";
    trip.fareChargeAmountCents = 0;
    trip.fareChargeCurrency = currency;
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = "";
    return;
  }

  if (currency === "usd" && totalChargeCents > 0 && totalChargeCents < USD_MIN_CHARGE_CENTS) {
    trip.fareChargeStatus = "skipped_below_minimum";
    trip.fareChargeAmountCents = totalChargeCents;
    trip.fareChargeCurrency = currency;
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = `Below Stripe minimum (${USD_MIN_CHARGE_CENTS}¢)`;
    return;
  }

  const customerId = typeof rider.stripeCustomerId === "string" ? rider.stripeCustomerId.trim() : "";
  const pmId =
    typeof rider.stripeDefaultPaymentMethodId === "string" ? rider.stripeDefaultPaymentMethodId.trim() : "";
  if (!customerId || !pmId) {
    trip.fareChargeStatus = "skipped_no_payment_method";
    trip.fareChargeAmountCents = totalChargeCents;
    trip.fareChargeCurrency = currency;
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = "";
    return;
  }

  trip.fareChargeAmountCents = totalChargeCents;
  trip.fareChargeCurrency = currency;

  const idempotencyKey = isRetry
    ? `tnc-trip-fare-retry-${trip._id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    : `tnc-trip-fare-${trip._id}`;

  const pi = await stripe.paymentIntents.create(
    {
      amount: totalChargeCents,
      currency,
      customer: customerId,
      payment_method: pmId,
      payment_method_types: ["card"],
      description: `TNC trip ${trip._id}`,
      metadata: {
        tncTripId: String(trip._id),
        fareCents: String(fareCents),
        tipCents: String(tipCents),
        ...(isRetry ? { tncRetry: "1" } : {}),
      },
    },
    { idempotencyKey }
  );

  trip.stripePaymentIntentId = pi.id;

  try {
    const confirmed = await stripe.paymentIntents.confirm(pi.id, { off_session: true });
    if (confirmed.status === "succeeded") {
      trip.fareChargeStatus = "succeeded";
      trip.fareChargeError = "";
      return;
    }
    if (confirmed.status === "requires_action" || confirmed.status === "requires_confirmation") {
      trip.fareChargeStatus = "requires_action";
      trip.fareChargeError = "";
      return;
    }
    trip.fareChargeStatus = "failed";
    trip.fareChargeError = `Unexpected status: ${confirmed.status}`;
  } catch (err) {
    const raw = err?.raw || {};
    const embedded = err?.payment_intent || raw.payment_intent;
    if (embedded && typeof embedded === "object" && embedded.id) {
      trip.stripePaymentIntentId = embedded.id;
    }
    const status = embedded?.status;
    if (err?.code === "authentication_required" || status === "requires_action" || status === "requires_confirmation") {
      trip.fareChargeStatus = "requires_action";
      trip.fareChargeError = "";
      return;
    }
    trip.fareChargeStatus = "failed";
    trip.fareChargeError = raw.message || err?.message || "charge_failed";
  }
}
