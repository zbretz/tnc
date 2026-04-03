import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { User } from "../models/User.js";
import { serializeTripPopulated } from "../serialize.js";
import { stripeEnabled } from "./stripe.js";
import { applyRiderCancelCharge } from "./chargeRiderCancellation.js";
import { processRiderCancelFeePayout } from "./driverPayout.js";

const POPULATE_DRIVER = { path: "driver", select: "-passwordHash" };

const RETRYABLE = new Set(["failed", "skipped_no_payment_method", "skipped_stripe_disabled"]);

/**
 * New cancel-fee charge attempt (cancelled trip only).
 * @param {string} tripId
 * @param {string} riderUserId
 */
export async function riderRetryCancelCharge(tripId, riderUserId) {
  const id = String(tripId);
  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, error: "invalid_id" };
  }
  if (!stripeEnabled()) {
    return { ok: false, error: "stripe_disabled" };
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
  if (!RETRYABLE.has(trip.riderCancelChargeStatus)) {
    return { ok: false, error: "not_retryable" };
  }

  const rider = await User.findById(trip.rider).exec();
  if (!rider) {
    return { ok: false, error: "rider_not_found" };
  }

  try {
    await applyRiderCancelCharge(trip, rider, null, { retry: true });
  } catch (e) {
    console.error("[tnc] riderRetryCancelCharge", e);
    trip.riderCancelChargeStatus = "failed";
    trip.riderCancelChargeError = e?.raw?.message || e?.message || "charge_error";
  }

  await trip.save();
  if (trip.riderCancelChargeStatus === "succeeded") {
    void processRiderCancelFeePayout(trip._id).catch((e) => console.error("[tnc] processRiderCancelFeePayout", e));
  }
  const fresh = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
  return { ok: true, trip: await serializeTripPopulated(fresh) };
}
