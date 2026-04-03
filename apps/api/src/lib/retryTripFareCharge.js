import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { User } from "../models/User.js";
import { serializeTripPopulated } from "../serialize.js";
import { stripeEnabled } from "./stripe.js";
import { applyFareChargeToTrip } from "./chargeTripFare.js";

const POPULATE_DRIVER = { path: "driver", select: "-passwordHash" };

/** Fare states where a new PaymentIntent + off-session confirm may fix the outcome. */
const RETRYABLE_FARE_STATUSES = new Set(["failed", "skipped_no_payment_method", "skipped_no_estimate"]);

/**
 * Rider retries charging a completed trip (new card, transient failure, or estimate now available).
 * @param {string} tripId
 * @param {string} riderUserId
 */
export async function riderRetryTripFareCharge(tripId, riderUserId) {
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
  if (trip.status !== "completed") {
    return { ok: false, error: "not_completed" };
  }
  const st = trip.fareChargeStatus;
  if (!RETRYABLE_FARE_STATUSES.has(st)) {
    return { ok: false, error: "not_retryable" };
  }

  const rider = await User.findById(trip.rider).exec();
  if (!rider) {
    return { ok: false, error: "rider_not_found" };
  }

  try {
    await applyFareChargeToTrip(trip, rider, { retry: true });
  } catch (e) {
    console.error("[tnc] riderRetryTripFareCharge", e);
    trip.fareChargeStatus = "failed";
    trip.fareChargeError = e?.raw?.message || e?.message || "charge_error";
  }

  await trip.save();
  const fresh = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
  return { ok: true, trip: await serializeTripPopulated(fresh) };
}
