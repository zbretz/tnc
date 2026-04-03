import { getStripe, stripeEnabled } from "./stripe.js";

const USD_MIN_CHARGE_CENTS = 50;

/**
 * One PaymentIntent for rider cancellation fee (off-session). Mutates `trip` cancel-charge fields; does not save.
 * @param {import("mongoose").Document} trip
 * @param {import("mongoose").Document} rider
 * @param {{ feeCents: number, appTakeCents: number, driverShareCents: number }} quote from riderCancellationQuotePayload
 * @param {{ retry?: boolean }} [options] — retry uses a fresh idempotency key
 */
export async function applyRiderCancelCharge(trip, rider, quote, options = {}) {
  const isRetry = options.retry === true;
  const stripe = getStripe();

  const currency = (
    typeof trip.fareEstimate?.currency === "string" ? trip.fareEstimate.currency : "USD"
  ).toLowerCase();

  trip.riderCancelChargeComputedAt = new Date();

  if (quote && typeof quote === "object") {
    trip.riderCancelFeeCents = Math.max(0, Math.round(Number(quote.feeCents) || 0));
    trip.riderCancelAppTakeCents = Math.max(0, Math.round(Number(quote.appTakeCents) || 0));
    trip.riderCancelDriverShareCents = Math.max(0, Math.round(Number(quote.driverShareCents) || 0));
  }

  const feeCents =
    trip.riderCancelFeeCents != null && Number.isFinite(Number(trip.riderCancelFeeCents))
      ? Math.max(0, Math.round(Number(trip.riderCancelFeeCents)))
      : 0;

  trip.riderCancelChargeCurrency = currency;
  trip.riderCancelChargeError = "";

  if (!stripeEnabled() || !stripe) {
    trip.riderCancelChargeStatus = "skipped_stripe_disabled";
    trip.stripeCancelPaymentIntentId = "";
    return;
  }

  if (feeCents <= 0) {
    trip.riderCancelChargeStatus = "waived";
    trip.stripeCancelPaymentIntentId = "";
    return;
  }

  if (currency === "usd" && feeCents < USD_MIN_CHARGE_CENTS) {
    trip.riderCancelChargeStatus = "skipped_below_minimum";
    trip.stripeCancelPaymentIntentId = "";
    trip.riderCancelChargeError = `Below Stripe minimum (${USD_MIN_CHARGE_CENTS}¢)`;
    return;
  }

  const customerId = typeof rider.stripeCustomerId === "string" ? rider.stripeCustomerId.trim() : "";
  const pmId =
    typeof rider.stripeDefaultPaymentMethodId === "string" ? rider.stripeDefaultPaymentMethodId.trim() : "";
  if (!customerId || !pmId) {
    trip.riderCancelChargeStatus = "skipped_no_payment_method";
    trip.stripeCancelPaymentIntentId = "";
    return;
  }

  const idempotencyKey = isRetry
    ? `tnc-trip-cancel-retry-${trip._id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    : `tnc-trip-cancel-${trip._id}`;

  const pi = await stripe.paymentIntents.create(
    {
      amount: feeCents,
      currency,
      customer: customerId,
      payment_method: pmId,
      payment_method_types: ["card"],
      description: `TNC cancellation fee ${trip._id}`,
      metadata: {
        tncTripId: String(trip._id),
        tncKind: "rider_cancel",
        feeCents: String(feeCents),
        appTakeCents: String(trip.riderCancelAppTakeCents ?? 0),
        driverShareCents: String(trip.riderCancelDriverShareCents ?? 0),
        ...(isRetry ? { tncRetry: "1" } : {}),
      },
    },
    { idempotencyKey }
  );

  trip.stripeCancelPaymentIntentId = pi.id;

  try {
    const confirmed = await stripe.paymentIntents.confirm(pi.id, { off_session: true });
    if (confirmed.status === "succeeded") {
      trip.riderCancelChargeStatus = "succeeded";
      trip.riderCancelChargeError = "";
      return;
    }
    if (confirmed.status === "requires_action" || confirmed.status === "requires_confirmation") {
      trip.riderCancelChargeStatus = "requires_action";
      trip.riderCancelChargeError = "";
      return;
    }
    trip.riderCancelChargeStatus = "failed";
    trip.riderCancelChargeError = `Unexpected status: ${confirmed.status}`;
  } catch (err) {
    const raw = err?.raw || {};
    const embedded = err?.payment_intent || raw.payment_intent;
    if (embedded && typeof embedded === "object" && embedded.id) {
      trip.stripeCancelPaymentIntentId = embedded.id;
    }
    const status = embedded?.status;
    if (err?.code === "authentication_required" || status === "requires_action" || status === "requires_confirmation") {
      trip.riderCancelChargeStatus = "requires_action";
      trip.riderCancelChargeError = "";
      return;
    }
    trip.riderCancelChargeStatus = "failed";
    trip.riderCancelChargeError = raw.message || err?.message || "charge_failed";
  }
}
