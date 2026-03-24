import { getDrivingDurationToDestination } from "./googleDistance.js";

const MIN_INTERVAL_MS = Number(process.env.TNC_ETA_MIN_INTERVAL_MS) || 28000;
const MIN_MOVE_METERS = Number(process.env.TNC_ETA_MIN_MOVE_METERS) || 250;

/** tripId -> { lastMs, lastLat, lastLng } */
const throttle = new Map();

function etaLog(...args) {
  if (process.env.TNC_ETA_LOG === "0") return;
  console.log("[tnc:eta:server]", new Date().toISOString(), ...args);
}

function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function shouldCallGoogle(tripId, lat, lng) {
  const now = Date.now();
  const prev = throttle.get(tripId);
  if (!prev) {
    return { ok: true, reason: "first" };
  }
  const moved = distMeters(prev.lastLat, prev.lastLng, lat, lng);
  const elapsed = now - prev.lastMs;
  if (elapsed < MIN_INTERVAL_MS && moved < MIN_MOVE_METERS) {
    return { ok: false, reason: "throttle", elapsed, moved };
  }
  return { ok: true, reason: elapsed >= MIN_INTERVAL_MS ? "interval" : "moved" };
}

function recordSuccessfulEtaFetch(tripId, lat, lng) {
  throttle.set(String(tripId), { lastMs: Date.now(), lastLat: lat, lastLng: lng });
}

export function clearPickupEtaThrottle(tripId) {
  throttle.delete(String(tripId));
}

export function buildEtaPayloadFromMatrix(result) {
  if (!result.ok) return null;
  const minutes = Math.max(1, Math.round(result.durationSeconds / 60));
  return {
    durationSeconds: result.durationSeconds,
    durationText: result.durationText,
    distanceMeters: result.distanceMeters,
    distanceText: result.distanceText,
    summaryMinutes: minutes,
    usesTraffic: Boolean(result.usesTraffic),
  };
}

/**
 * After driver location is saved on `trip` (mongoose doc), optionally refresh Distance Matrix ETA and save.
 * Throttled to limit Google calls. Mutates `trip` and saves when ETA is refreshed.
 * @returns {{ refreshed: boolean, skipped?: string }}
 */
export async function tryRefreshPickupEta(trip, driverLat, driverLng) {
  const tripId = String(trip._id);
  if (trip.status !== "accepted") {
    return { refreshed: false, skipped: "status" };
  }
  const pickup = trip.pickup;
  if (!pickup || !Number.isFinite(Number(pickup.lat)) || !Number.isFinite(Number(pickup.lng))) {
    return { refreshed: false, skipped: "pickup" };
  }
  if (!Number.isFinite(Number(driverLat)) || !Number.isFinite(Number(driverLng))) {
    return { refreshed: false, skipped: "driver_coords" };
  }

  const gate = shouldCallGoogle(tripId, driverLat, driverLng);
  if (!gate.ok) {
    etaLog("skip throttle", tripId, gate.reason, gate);
    return { refreshed: false, skipped: `throttle:${gate.reason}` };
  }

  const apiKey =
    process.env.GOOGLE_DISTANCE_MATRIX_API_KEY || process.env.GOOGLE_MAPS_SERVER_API_KEY || "";
  const t0 = Date.now();
  const result = await getDrivingDurationToDestination(
    { lat: Number(driverLat), lng: Number(driverLng) },
    { lat: Number(pickup.lat), lng: Number(pickup.lng) },
    apiKey
  );
  etaLog("matrix done", tripId, Date.now() - t0, "ms", gate.reason, result.ok ? "ok" : result.error);

  if (!result.ok) {
    return { refreshed: false, skipped: String(result.error) };
  }

  const payload = buildEtaPayloadFromMatrix(result);
  if (!payload) return { refreshed: false, skipped: "no_payload" };

  trip.etaToPickup = {
    ...payload,
    computedAt: new Date(),
  };
  await trip.save();
  recordSuccessfulEtaFetch(tripId, driverLat, driverLng);
  return { refreshed: true };
}
