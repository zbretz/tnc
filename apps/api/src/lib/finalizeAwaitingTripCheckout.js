import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { User } from "../models/User.js";
import { serializeTrip } from "../serialize.js";
import { clearPickupEtaThrottle } from "../pickupEta.js";
import { recordTripStatusEvent } from "./tripEvents.js";
import { applyFareChargeToTrip, maxTipCentsAllowed, resolveTripFareUsd } from "../lib/chargeTripFare.js";

const POPULATE_DRIVER = { path: "driver", select: "-passwordHash" };

/**
 * Complete checkout: charge fare + tip, mark trip completed. Idempotent with concurrent callers
 * (second call returns not_awaiting). Stripe uses idempotency per trip id.
 *
 * @param {string} tripId
 * @param {{ tipCents?: number, actorUserId?: string|null, actorRoles?: string[], eventPayload?: object }} opts
 *        If `tipCents` omitted, uses `trip.riderTipAmountCents` rounded or 0.
 */
export async function finalizeAwaitingTripCheckout(tripId, opts = {}) {
  const id = String(tripId);
  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, error: "invalid_id" };
  }
  const trip = await Trip.findById(id).exec();
  if (!trip) {
    return { ok: false, error: "not_found" };
  }
  if (trip.status !== "awaiting_rider_checkout") {
    return { ok: false, error: "not_awaiting" };
  }

  let tipCents;
  if (opts.tipCents !== undefined && opts.tipCents !== null) {
    const n = Number(opts.tipCents);
    if (!Number.isFinite(n) || n < 0 || Math.round(n) !== n) {
      return { ok: false, error: "tip_invalid" };
    }
    tipCents = n;
  } else {
    const raw = trip.riderTipAmountCents;
    tipCents =
      raw != null && Number.isFinite(Number(raw)) ? Math.max(0, Math.round(Number(raw))) : 0;
  }

  const fare = await resolveTripFareUsd(trip);
  if (!fare.ok) {
    return { ok: false, error: "fare_unavailable" };
  }
  const fareCents = fare.totalUsd > 0 ? Math.round(fare.totalUsd * 100) : 0;
  const maxTip = maxTipCentsAllowed(fareCents);
  if (tipCents > maxTip) {
    return { ok: false, error: "tip_too_large", maxTip };
  }

  trip.riderTipAmountCents = tipCents;

  const rider = await User.findById(trip.rider).exec();
  if (!rider) {
    return { ok: false, error: "rider_not_found" };
  }

  try {
    await applyFareChargeToTrip(trip, rider);
  } catch (e) {
    console.error("[tnc] fare charge on finalizeAwaitingTripCheckout", e);
    trip.fareChargeStatus = "failed";
    trip.fareChargeError = e?.raw?.message || e?.message || "charge_error";
  }

  trip.status = "completed";
  trip.awaitingRiderCheckoutDeadlineAt = null;
  trip.etaToPickup = null;
  trip.etaToDropoff = null;
  clearPickupEtaThrottle(id);
  await trip.save();

  const actorRoles = Array.isArray(opts.actorRoles) ? opts.actorRoles : [];
  await recordTripStatusEvent({
    tripId: trip._id,
    fromStatus: "awaiting_rider_checkout",
    toStatus: "completed",
    actorUserId: opts.actorUserId || undefined,
    actorRoles,
    payload:
      opts.eventPayload && typeof opts.eventPayload === "object" ? opts.eventPayload : undefined,
  }).catch((e) => console.error("[tnc] TripEvent finalize checkout", e));

  const fresh = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
  return { ok: true, trip: serializeTrip(fresh) };
}
