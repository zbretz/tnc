import { getDrivingDurationToDestination, getDrivingDurationsOneToMany } from "./googleDistance.js";
import { distanceMatrixApiKey } from "./lib/mapsKeys.js";
import { getFareQuoteModifiers } from "./models/AppSettings.js";
import { loadPricingAnchors } from "./pricingAnchors.js";

function fareLog(...args) {
  if (process.env.TNC_FARE_LOG === "0") return;
  console.log("[tnc:fare]", new Date().toISOString(), ...args);
}

function numEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Trip-time component: $15 at 10 min, $30 at 22 min; min fare floor; linear extrapolation beyond 22. */
export function tripTimeFareUsd(tripMinutes) {
  const minFare = numEnv("TNC_FARE_MIN_USD", 15);
  const t1 = numEnv("TNC_FARE_TRIP_ANCHOR_MIN_1", 10);
  const t2 = numEnv("TNC_FARE_TRIP_ANCHOR_MIN_2", 22);
  const f1 = numEnv("TNC_FARE_TRIP_USD_1", 15);
  const f2 = numEnv("TNC_FARE_TRIP_USD_2", 30);
  if (tripMinutes <= t1) return Math.max(minFare, f1);
  const slope = (f2 - f1) / (t2 - t1);
  const raw = f1 + (tripMinutes - t1) * slope;
  return Math.max(minFare, raw);
}

function anchorExcessUsd(excessMinutes) {
  const perMin = numEnv("TNC_FARE_ANCHOR_USD_PER_EXCESS_MIN", 1.25);
  return Math.max(0, excessMinutes) * perMin;
}

/**
 * @returns {Promise<{ ok: true, estimate: object } | { ok: false, error: string }>}
 */
export async function computeFareEstimate(pickup, dropoff) {
  const apiKey = distanceMatrixApiKey();
  const anchors = loadPricingAnchors();
  if (!pickup || !dropoff) {
    return { ok: false, error: "pickup and dropoff required" };
  }
  if (!apiKey) {
    fareLog("skip", {
      reason: "fare_matrix_key_missing",
      hint: "Set GOOGLE_DISTANCE_MATRIX_API_KEY or GOOGLE_MAPS_SERVER_API_KEY, or reuse GOOGLE_DIRECTIONS_API_KEY with Distance Matrix API enabled on that key.",
    });
    return { ok: false, error: "fare_matrix_key_missing" };
  }

  const tripLeg = await getDrivingDurationToDestination(pickup, dropoff, apiKey);
  if (!tripLeg.ok) {
    return { ok: false, error: tripLeg.error || "trip_route_failed" };
  }

  const tripMin = tripLeg.durationSeconds / 60;
  const tripFare = tripTimeFareUsd(tripMin);

  const anchorPoints = anchors.map((a) => ({ lat: a.lat, lng: a.lng }));
  const [pickRow, dropRow] = await Promise.all([
    getDrivingDurationsOneToMany(pickup, anchorPoints, apiKey),
    getDrivingDurationsOneToMany(dropoff, anchorPoints, apiKey),
  ]);

  if (!pickRow.ok || !dropRow.ok) {
    return { ok: false, error: "anchor_matrix_failed" };
  }

  let bestPickIdx = 0;
  let bestPickSec = Infinity;
  pickRow.results.forEach((r, i) => {
    if (r.ok && r.durationSeconds < bestPickSec) {
      bestPickSec = r.durationSeconds;
      bestPickIdx = i;
    }
  });

  let bestDropIdx = 0;
  let bestDropSec = Infinity;
  dropRow.results.forEach((r, i) => {
    if (r.ok && r.durationSeconds < bestDropSec) {
      bestDropSec = r.durationSeconds;
      bestDropIdx = i;
    }
  });

  if (!Number.isFinite(bestPickSec) || !Number.isFinite(bestDropSec)) {
    return { ok: false, error: "anchor_route_failed" };
  }

  const farMin = numEnv("TNC_FARE_ANCHOR_FAR_MINUTES", 5);
  const pickToNominalMin = bestPickSec / 60;
  const dropToNominalMin = bestDropSec / 60;
  const excessPick = Math.max(0, pickToNominalMin - farMin);
  const excessDrop = Math.max(0, dropToNominalMin - farMin);
  const adjPick = anchorExcessUsd(excessPick);
  const adjDrop = anchorExcessUsd(excessDrop);
  const subtotal = tripFare + adjPick + adjDrop;
  const minFare = numEnv("TNC_FARE_MIN_USD", 15);
  const baseTotalUsd = Math.max(minFare, subtotal);
  const baseRounded = Math.round(baseTotalUsd * 100) / 100;
  const { fareFreeEnabled, fareAdjustmentPercent } = await getFareQuoteModifiers();
  const multiplier = fareAdjustmentPercent / 100;
  const quotedBeforeWaiver = Math.round(baseRounded * multiplier * 100) / 100;
  const finalTotal = fareFreeEnabled ? 0 : quotedBeforeWaiver;
  const rounded = Math.round(finalTotal * 100) / 100;

  const nominalPickup = anchors[bestPickIdx];
  const nominalDropoff = anchors[bestDropIdx];

  const tripPortionRounded = Math.round(tripFare * 100) / 100;
  const floorApplied = subtotal < minFare;
  const adjustmentApplied = !fareFreeEnabled && fareAdjustmentPercent !== 100;
  fareLog("estimate", {
    inputs: {
      pickup: { lat: pickup.lat, lng: pickup.lng },
      dropoff: { lat: dropoff.lat, lng: dropoff.lng },
    },
    tripLeg: {
      durationText: tripLeg.durationText,
      durationMinutes: Math.round(tripMin * 100) / 100,
      portionUsd: tripPortionRounded,
      note: "from pickup→dropoff Matrix; $15 @ 10min → $30 @ 22min (linear), min fare floor on this portion via tripTimeFareUsd",
    },
    pickupAnchor: {
      nearestAnchor: { id: nominalPickup.id, name: nominalPickup.name },
      driveMinutesToNearest: Math.round(pickToNominalMin * 100) / 100,
      farThresholdMinutes: farMin,
      excessMinutes: Math.round(excessPick * 100) / 100,
      adjustmentUsd: Math.round(adjPick * 100) / 100,
      note: "excess = max(0, driveToNearestAnchor − threshold); × TNC_FARE_ANCHOR_USD_PER_EXCESS_MIN",
    },
    dropoffAnchor: {
      nearestAnchor: { id: nominalDropoff.id, name: nominalDropoff.name },
      driveMinutesToNearest: Math.round(dropToNominalMin * 100) / 100,
      farThresholdMinutes: farMin,
      excessMinutes: Math.round(excessDrop * 100) / 100,
      adjustmentUsd: Math.round(adjDrop * 100) / 100,
    },
    rollup: {
      tripPortionUsd: tripPortionRounded,
      pickupAdjustmentUsd: Math.round(adjPick * 100) / 100,
      dropoffAdjustmentUsd: Math.round(adjDrop * 100) / 100,
      subtotalUsd: Math.round(subtotal * 100) / 100,
      minimumFareUsd: minFare,
      minimumFareApplied: floorApplied,
      fareAdjustmentPercent,
      baseCalculatedUsd: baseRounded,
      adjustmentApplied,
      fareFree: fareFreeEnabled,
      waivedQuoteUsd: fareFreeEnabled ? quotedBeforeWaiver : undefined,
      totalUsd: rounded,
    },
  });

  return {
    ok: true,
    estimate: {
      currency: "USD",
      total: rounded,
      breakdown: {
        trip: {
          durationSeconds: tripLeg.durationSeconds,
          durationText: tripLeg.durationText,
          durationMinutes: Math.round(tripMin * 100) / 100,
          portionUsd: Math.round(tripFare * 100) / 100,
        },
        pickupAnchor: {
          nominalAnchorId: nominalPickup.id,
          nominalAnchorName: nominalPickup.name,
          minutesToClosestAnchor: Math.round(pickToNominalMin * 100) / 100,
          farThresholdMinutes: farMin,
          excessMinutes: Math.round(excessPick * 100) / 100,
          adjustmentUsd: Math.round(adjPick * 100) / 100,
        },
        dropoffAnchor: {
          nominalAnchorId: nominalDropoff.id,
          nominalAnchorName: nominalDropoff.name,
          minutesToClosestAnchor: Math.round(dropToNominalMin * 100) / 100,
          farThresholdMinutes: farMin,
          excessMinutes: Math.round(excessDrop * 100) / 100,
          adjustmentUsd: Math.round(adjDrop * 100) / 100,
        },
        minimumFareUsd: minFare,
        fareAdjustmentPercent,
        baseCalculatedUsd: baseRounded,
        fareFree: fareFreeEnabled,
        waivedQuoteUsd: fareFreeEnabled ? quotedBeforeWaiver : undefined,
      },
      computedAt: new Date().toISOString(),
    },
  };
}
