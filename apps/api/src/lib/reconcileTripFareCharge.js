import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { getStripe, stripeEnabled } from "./stripe.js";
import { serializeTripPopulated } from "../serialize.js";
import { processDriverPayoutForTrip } from "./driverPayout.js";

const POPULATE_DRIVER = { path: "driver", select: "-passwordHash" };

async function loadSerialized(id) {
  const t = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
  return t ? await serializeTripPopulated(t) : null;
}

/**
 * Sync fare charge fields from Stripe after the rider completes 3DS or the PI settles.
 * @param {string} tripId
 * @param {string} riderUserId
 */
export async function reconcileTripFareChargeFromStripe(tripId, riderUserId) {
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
  if (trip.status !== "completed") {
    return { ok: false, error: "not_completed" };
  }
  const piId = typeof trip.stripePaymentIntentId === "string" ? trip.stripePaymentIntentId.trim() : "";
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
    console.error("[tnc] reconcileTripFareCharge retrieve PI", e);
    return { ok: false, error: e?.raw?.message || e?.message || "stripe_error" };
  }

  const status = pi.status;
  if (status === "succeeded") {
    trip.fareChargeStatus = "succeeded";
    trip.fareChargeError = "";
    const amount = typeof pi.amount_received === "number" ? pi.amount_received : pi.amount;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      trip.fareChargeAmountCents = amount;
    }
    await trip.save();
    void processDriverPayoutForTrip(trip._id).catch((e) => console.error("[tnc] processDriverPayoutForTrip", e));
  } else if (status === "requires_action" || status === "requires_confirmation") {
    trip.fareChargeStatus = "requires_action";
    trip.fareChargeError = "";
    await trip.save();
  } else if (status === "canceled") {
    trip.fareChargeStatus = "failed";
    trip.fareChargeError = "Payment was canceled.";
    await trip.save();
  } else if (status === "processing") {
    const serialized = await loadSerialized(id);
    return { ok: true, processing: true, trip: serialized };
  } else {
    trip.fareChargeStatus = "failed";
    trip.fareChargeError = pi.last_payment_error?.message || `Payment status: ${status}`;
    await trip.save();
  }

  const serialized = await loadSerialized(id);
  return { ok: true, trip: serialized };
}
