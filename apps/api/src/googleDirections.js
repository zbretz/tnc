/**
 * Driving route geometry via Google Directions API (overview polyline).
 * Reuses GOOGLE_DISTANCE_MATRIX_API_KEY / GOOGLE_MAPS_SERVER_API_KEY unless GOOGLE_DIRECTIONS_API_KEY is set.
 * Enable "Directions API" on the GCP project.
 */

function dirLog(...args) {
  if (process.env.TNC_DIRECTIONS_LOG === "0") return;
  console.log("[tnc:directions]", new Date().toISOString(), ...args);
}

/** Decode Google's encoded polyline string to [{ lat, lng }, ...]. */
export function decodeGooglePolyline(encoded) {
  if (typeof encoded !== "string" || !encoded.length) return [];
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    coords.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coords;
}

async function fetchDirectionsJson(origin, destination, apiKey) {
  if (!apiKey || typeof apiKey !== "string") {
    dirLog("skip: missing API key");
    return { ok: false, error: "missing_key" };
  }
  const oLat = Number(origin?.lat);
  const oLng = Number(origin?.lng);
  const dLat = Number(destination?.lat);
  const dLng = Number(destination?.lng);
  if (![oLat, oLng, dLat, dLng].every((n) => Number.isFinite(n))) {
    dirLog("skip: invalid coordinates");
    return { ok: false, error: "invalid_coordinates" };
  }

  const originQ = encodeURIComponent(`${oLat},${oLng}`);
  const destQ = encodeURIComponent(`${dLat},${dLng}`);
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originQ}&destination=${destQ}&mode=driving&key=${encodeURIComponent(apiKey)}`;

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    dirLog("network", String(e?.message || e));
    return { ok: false, error: "network" };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    dirLog("bad JSON", res.status);
    return { ok: false, error: "bad_response" };
  }

  if (data?.status !== "OK" || !Array.isArray(data.routes) || data.routes.length === 0) {
    dirLog("API", data?.status, data?.error_message || "", Date.now() - t0, "ms");
    return { ok: false, error: data?.error_message || data?.status || "no_route" };
  }

  return { ok: true, data, ms: Date.now() - t0 };
}

/**
 * @param {{ lat: number, lng: number }} origin
 * @param {{ lat: number, lng: number }} destination
 * @param {string} apiKey
 * @returns {Promise<{ ok: true, coordinates: { lat: number, lng: number }[] } | { ok: false, error: string }>}
 */
export async function getDrivingRouteCoordinates(origin, destination, apiKey) {
  const parsed = await fetchDirectionsJson(origin, destination, apiKey);
  if (!parsed.ok) return parsed;

  const encoded = parsed.data.routes[0]?.overview_polyline?.points;
  if (typeof encoded !== "string" || !encoded.length) {
    dirLog("no overview polyline");
    return { ok: false, error: "no_polyline" };
  }

  const coordinates = decodeGooglePolyline(encoded);
  if (coordinates.length < 2) {
    return { ok: false, error: "decode_short" };
  }

  dirLog("ok", coordinates.length, "points", parsed.ms, "ms");
  return { ok: true, coordinates };
}

/**
 * Distance/duration + overview polyline from Directions API (same request as coordinates).
 * @returns {Promise<{ ok: true, distanceM: number, durationSec: number, encodedPolyline: string } | { ok: false, error: string }>}
 */
export async function fetchDrivingRouteSummary(origin, destination, apiKey) {
  const parsed = await fetchDirectionsJson(origin, destination, apiKey);
  if (!parsed.ok) return parsed;

  const route = parsed.data.routes[0];
  const leg = route?.legs?.[0];
  const encoded = route?.overview_polyline?.points;
  if (typeof encoded !== "string" || !encoded.length) {
    dirLog("no overview polyline");
    return { ok: false, error: "no_polyline" };
  }
  const distanceM = typeof leg?.distance?.value === "number" ? leg.distance.value : undefined;
  const durationSec =
    typeof leg?.duration_in_traffic?.value === "number"
      ? leg.duration_in_traffic.value
      : typeof leg?.duration?.value === "number"
        ? leg.duration.value
        : undefined;
  if (!Number.isFinite(distanceM) || !Number.isFinite(durationSec)) {
    return { ok: false, error: "no_leg_metrics" };
  }

  dirLog("summary ok", distanceM, "m", durationSec, "s", parsed.ms, "ms");
  return { ok: true, distanceM, durationSec, encodedPolyline: encoded };
}
