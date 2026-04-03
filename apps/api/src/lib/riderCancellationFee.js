/**
 * Rider-initiated cancellation fee policy (quoted pre-cancel; charged via Stripe on POST cancel when fee > 0).
 *
 * - Before a driver is en route to pickup: $0 (assignment alone does not start the clock).
 * - Within 2 minutes after en route: $0.
 * - After that until pickup arrival: fee ramps as if linear from $0 → at-pickup tier, never below $5.
 * - At pickup (driver arrived, not yet in progress): max($5, 75% of quoted fare).
 * - In progress: same as at-pickup tier for the first 5 minutes, then full quoted fare.
 * - Awaiting checkout: full quoted fare.
 *
 * Cancel-fee split (when charging): same as fare — appTakePercent of the cancel fee to platform;
 * remainder to driver pool (Stripe fee on transfer handled at payout like trip fare).
 */

import { computeAppTakeCents } from "./driverPayout.js";

const MS_2M = 2 * 60 * 1000;
const MS_5M = 5 * 60 * 1000;
const MIN_CANCEL_FEE_CENTS = 500;
const RAMP_FALLBACK_MS = 15 * 60 * 1000;

function quotedFareCentsFromTrip(trip) {
  const t = trip?.fareEstimate?.total;
  if (t == null || !Number.isFinite(Number(t))) return null;
  return Math.max(0, Math.round(Number(t) * 100));
}

/** Once driver is at pickup (pre-ride) or early in-ride: at least $5, or 75% of fare if higher. */
export function arrivalTierFeeCents(fareCents) {
  if (fareCents == null || !Number.isFinite(fareCents)) return MIN_CANCEL_FEE_CENTS;
  const p75 = Math.round(fareCents * 0.75);
  return Math.max(MIN_CANCEL_FEE_CENTS, p75);
}

function fullQuotedFareCents(fareCents) {
  if (fareCents == null || !Number.isFinite(fareCents)) return MIN_CANCEL_FEE_CENTS;
  return fareCents;
}

/**
 * Split cancel fee like trip fare: platform app take on the fee, rest to driver (before Stripe fee on payout).
 */
export function computeCancelFeeSplitCents(feeCents, appTakePercent) {
  const fee = Math.max(0, Math.round(Number(feeCents) || 0));
  if (fee <= 0) {
    return { appTakeCents: 0, driverShareCents: 0 };
  }
  const pct =
    typeof appTakePercent === "number" && Number.isFinite(appTakePercent) ? appTakePercent : 20;
  const take = computeAppTakeCents(fee, pct);
  return { appTakeCents: take, driverShareCents: Math.max(0, fee - take) };
}

function estimatedPickupArrivalMs(trip, enRouteAtMs) {
  const deadSec = trip?.deadheadRoute?.durationSec;
  const etaMin = trip?.etaToPickup?.summaryMinutes;
  let durationMs = RAMP_FALLBACK_MS;
  if (typeof deadSec === "number" && Number.isFinite(deadSec) && deadSec > 0) {
    durationMs = Math.max(durationMs, deadSec * 1000);
  } else if (typeof etaMin === "number" && Number.isFinite(etaMin) && etaMin > 0) {
    durationMs = Math.max(durationMs, etaMin * 60 * 1000);
  }
  return enRouteAtMs + durationMs;
}

/**
 * @param {import("mongoose").Document | object} trip
 * @param {Date} [now]
 * @returns {{ feeCents: number, tier: string, explanation: string }}
 */
export function computeRiderCancellationFeeCents(trip, now = new Date()) {
  const status = trip?.status;
  const nowMs = now.getTime();

  if (!trip || status === "cancelled" || status === "completed") {
    return { feeCents: 0, tier: "none", explanation: "" };
  }

  const fareCents = quotedFareCentsFromTrip(trip);

  if (status === "requested") {
    return { feeCents: 0, tier: "before_match", explanation: "No fee before a driver is assigned." };
  }

  if (status === "awaiting_rider_checkout") {
    return {
      feeCents: fullQuotedFareCents(fareCents),
      tier: "after_ride",
      explanation: "Full quoted fare once the ride has finished and checkout is pending.",
    };
  }

  const rideStartRaw = trip.rideInProgressAt;
  if (status === "in_progress") {
    if (rideStartRaw) {
      const rideStartMs = new Date(rideStartRaw).getTime();
      if (Number.isFinite(rideStartMs) && nowMs - rideStartMs > MS_5M) {
        return {
          feeCents: fullQuotedFareCents(fareCents),
          tier: "in_progress_late",
          explanation: "Full quoted fare after 5+ minutes with the ride in progress.",
        };
      }
    }
    return {
      feeCents: arrivalTierFeeCents(fareCents),
      tier: "in_progress_early",
      explanation: "Cancel fee applies while the ride is in progress.",
    };
  }

  if (status !== "accepted") {
    return { feeCents: 0, tier: "unknown", explanation: "" };
  }

  const enRouteAtRaw = trip.driverEnRouteToPickupAt;
  const enRouteAtMs = enRouteAtRaw ? new Date(enRouteAtRaw).getTime() : NaN;
  if (!Number.isFinite(enRouteAtMs)) {
    return {
      feeCents: 0,
      tier: "accepted_not_en_route",
      explanation: "No fee until your driver is on the way to pickup.",
    };
  }

  const arrivedRaw = trip.driverArrivedAtPickupAt;
  const arrivedAtMs = arrivedRaw ? new Date(arrivedRaw).getTime() : NaN;
  const rampStartMs = enRouteAtMs + MS_2M;

  if (Number.isFinite(arrivedAtMs) && nowMs >= arrivedAtMs) {
    return {
      feeCents: arrivalTierFeeCents(fareCents),
      tier: "at_pickup",
      explanation: "Driver has arrived at pickup.",
    };
  }

  if (nowMs < rampStartMs) {
    return {
      feeCents: 0,
      tier: "en_route_free",
      explanation: "Within 2 minutes of the driver heading to pickup.",
    };
  }

  const feeHigh = arrivalTierFeeCents(fareCents);

  let windowEndMs = Number.isFinite(arrivedAtMs) ? arrivedAtMs : estimatedPickupArrivalMs(trip, enRouteAtMs);
  if (windowEndMs <= rampStartMs) {
    return {
      feeCents: feeHigh,
      tier: "en_route_ramp_collapsed",
      explanation: "Approaching pickup.",
    };
  }

  const span = windowEndMs - rampStartMs;
  const pos = Math.min(1, Math.max(0, (nowMs - rampStartMs) / span));
  /** Linear 0 → feeHigh over the window, floor at $5, cap at pickup tier. */
  const rawFromZero = pos * feeHigh;
  const fee = Math.min(feeHigh, Math.max(MIN_CANCEL_FEE_CENTS, Math.round(rawFromZero)));

  return {
    feeCents: fee,
    tier: "en_route_ramp",
    explanation: "Cancel fee increases while the driver is en route to pickup.",
  };
}
