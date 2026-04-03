import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { getStripe, stripeEnabled } from "./stripe.js";
import { serializeTripPopulated } from "../serialize.js";
import { processRiderCancelFeePayout } from "./driverPayout.js";

const POPULATE_DRIVER = { path: "driver", select: "-passwordHash" };

async function loadSerialized(id) {
  const t = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
  return t ? await serializeTripPopulated(t) : null;
}

/**
 * Sync cancel-fee charge from Stripe after 3DS or delayed settlement.
 * @param {string} tripId
 * @param {string} riderUserId
 */
export async function reconcileRiderCancelChargeFromStripe(tripId, riderUserId) {
  const id = String(tripId);
  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, error: "invalid_id" };
  }
  const trip = await Trip.findById(id).exec();
  if (!trip) {
    return { ok: false, error: "not_found" };
  }
  if (String(trip.rider) !== String(riderUserId)) {
    return { ok: false, error: "forbidden" };
  }
  if (trip.status !== "cancelled") {
    return { ok: false, error: "not_cancelled" };
  }
  const piId =
    typeof trip.stripeCancelPaymentIntentId === "string" ? trip.stripeCancelPaymentIntentId.trim() : "";
  if (!piId) {
    return { ok: false, error: "no_payment_intent" };
  }
  if (!stripeEnabled()) {
    return { ok: false, error: "stripe_disabled" };
  }
  const stripe = getStripe();
  if (!stripe) {
    return { ok: false, error: "stripe_unconfigured" };
  }

  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(piId);
  } catch (e) {
    console.error("[tnc] reconcileRiderCancelCharge retrieve PI", e);
    return { ok: false, error: e?.raw?.message || e?.message || "stripe_error" };
  }

  const status = pi.status;
  if (status === "succeeded") {
    trip.riderCancelChargeStatus = "succeeded";
    trip.riderCancelChargeError = "";
    const amount = typeof pi.amount_received === "number" ? pi.amount_received : pi.amount;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      trip.riderCancelFeeCents = amount;
    }
    await trip.save();
    void processRiderCancelFeePayout(trip._id).catch((e) => console.error("[tnc] processRiderCancelFeePayout", e));
  } else if (status === "requires_action" || status === "requires_confirmation") {
    trip.riderCancelChargeStatus = "requires_action";
    trip.riderCancelChargeError = "";
    await trip.save();
  } else if (status === "canceled") {
    trip.riderCancelChargeStatus = "failed";
    trip.riderCancelChargeError = "Payment was canceled.";
    await trip.save();
  } else if (status === "processing") {
    const serialized = await loadSerialized(id);
    return { ok: true, processing: true, trip: serialized };
  } else {
    trip.riderCancelChargeStatus = "failed";
    trip.riderCancelChargeError = pi.last_payment_error?.message || `Payment status: ${status}`;
    await trip.save();
  }

  const serialized = await loadSerialized(id);
  return { ok: true, trip: serialized };
}
