/**
 * Driving duration from origin to destination via Google Distance Matrix API.
 * Uses departure_time=now so Google returns duration_in_traffic when available (live traffic).
 * Requires GOOGLE_DISTANCE_MATRIX_API_KEY (or GOOGLE_MAPS_SERVER_API_KEY), Distance Matrix API enabled,
 * and a billing-enabled project (traffic estimates require it per Google).
 */
function etaLog(...args) {
  if (process.env.TNC_ETA_LOG === "0") return;
  console.log("[tnc:eta:matrix]", new Date().toISOString(), ...args);
}

export async function getDrivingDurationToDestination(origin, destination, apiKey) {
  if (!apiKey || typeof apiKey !== "string") {
    etaLog("skip: missing API key");
    return { ok: false, error: "missing_key" };
  }
  const oLat = Number(origin?.lat);
  const oLng = Number(origin?.lng);
  const dLat = Number(destination?.lat);
  const dLng = Number(destination?.lng);
  if (![oLat, oLng, dLat, dLng].every((n) => Number.isFinite(n))) {
    etaLog("skip: invalid coordinates");
    return { ok: false, error: "invalid_coordinates" };
  }

  const origins = encodeURIComponent(`${oLat},${oLng}`);
  const dests = encodeURIComponent(`${dLat},${dLng}`);
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${dests}&mode=driving&units=metric&departure_time=now&key=${encodeURIComponent(apiKey)}`;

  etaLog("google fetch start", { origin: `${oLat},${oLng}`, dest: `${dLat},${dLng}` });
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    etaLog("google fetch failed (network)", Date.now() - t0, "ms", String(e?.message || e));
    return { ok: false, error: "network" };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    etaLog("google response not JSON", Date.now() - t0, "ms", "http", res.status);
    return { ok: false, error: "bad_response" };
  }

  const t1 = Date.now();
  if (data?.status !== "OK") {
    etaLog("google API status not OK", t1 - t0, "ms", data?.status, data?.error_message || "");
    return { ok: false, error: data?.error_message || data?.status || "matrix_failed" };
  }

  const el = data?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== "OK") {
    etaLog("element not OK", t1 - t0, "ms", el?.status || "no element");
    return { ok: false, error: el?.status || "no_route" };
  }

  const baseSec = el.duration?.value;
  const baseText = el.duration?.text;
  const trafficSec = el.duration_in_traffic?.value;
  const trafficText = el.duration_in_traffic?.text;

  const sec =
    typeof trafficSec === "number" && Number.isFinite(trafficSec) ? trafficSec : baseSec;
  const durationText =
    typeof trafficText === "string" && trafficText.trim().length > 0
      ? trafficText
      : typeof baseText === "string"
        ? baseText
        : null;

  const distanceMeters = el.distance?.value;
  const distanceText = el.distance?.text;

  if (typeof sec !== "number" || !Number.isFinite(sec)) {
    etaLog("no duration in element", t1 - t0, "ms");
    return { ok: false, error: "no_duration" };
  }

  etaLog("ok", t1 - t0, "ms", {
    durationText,
    usesTraffic: typeof trafficSec === "number" && Number.isFinite(trafficSec),
    distanceText,
  });

  return {
    ok: true,
    durationSeconds: sec,
    durationText,
    usesTraffic: typeof trafficSec === "number" && Number.isFinite(trafficSec),
    distanceMeters: typeof distanceMeters === "number" ? distanceMeters : null,
    distanceText: typeof distanceText === "string" ? distanceText : null,
  };
}
