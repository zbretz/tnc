import { computeFareEstimate } from "../fareEstimate.js";
import { getStripe, stripeEnabled } from "./stripe.js";

const USD_MIN_CHARGE_CENTS = 50;

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

/**
 * Attempts an off-session card charge for the trip fare. Mutates `trip` charge fields; does not save.
 * @param {import("mongoose").Document} trip
 * @param {import("mongoose").Document} rider
 */
export async function applyFareChargeToTrip(trip, rider) {
  const stripe = getStripe();
  if (!stripeEnabled() || !stripe) {
    trip.fareChargeStatus = "skipped_stripe_disabled";
    trip.fareChargeAmountCents = null;
    trip.fareChargeCurrency = "";
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = "";
    return;
  }

  const fare = await resolveTripFareUsd(trip);
  if (!fare.ok) {
    trip.fareChargeStatus = "skipped_no_estimate";
    trip.fareChargeAmountCents = null;
    trip.fareChargeCurrency = "";
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = fare.error || "";
    return;
  }

  const totalUsd = fare.totalUsd;
  const currency = (fare.currency || "USD").toLowerCase();
  if (totalUsd <= 0) {
    trip.fareChargeStatus = "waived";
    trip.fareChargeAmountCents = 0;
    trip.fareChargeCurrency = currency;
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = "";
    return;
  }

  const amountCents = Math.round(totalUsd * 100);
  if (currency === "usd" && amountCents > 0 && amountCents < USD_MIN_CHARGE_CENTS) {
    trip.fareChargeStatus = "skipped_below_minimum";
    trip.fareChargeAmountCents = amountCents;
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
    trip.fareChargeAmountCents = amountCents;
    trip.fareChargeCurrency = currency;
    trip.stripePaymentIntentId = "";
    trip.fareChargeError = "";
    return;
  }

  trip.fareChargeAmountCents = amountCents;
  trip.fareChargeCurrency = currency;

  const pi = await stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency,
      customer: customerId,
      payment_method: pmId,
      payment_method_types: ["card"],
      description: `TNC trip ${trip._id}`,
      metadata: { tncTripId: String(trip._id) },
    },
    { idempotencyKey: `tnc-trip-fare-${trip._id}` }
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
