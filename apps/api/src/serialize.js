import { DriverProfile } from "./models/DriverProfile.js";

function trimOrEmpty(s) {
  return typeof s === "string" ? s.trim() : "";
}

/** Normalize mongoose subdoc or plain object to trimmed string fields (+ optional year). */
function rawVehicleToPlain(v) {
  if (!v || typeof v !== "object") {
    return { make: "", model: "", color: "", licensePlate: "", photoUrl: "" };
  }
  const vy = v.year;
  const year =
    vy != null && Number.isFinite(Number(vy)) ? Math.round(Number(vy)) : undefined;
  return {
    make: trimOrEmpty(v.make),
    model: trimOrEmpty(v.model),
    color: trimOrEmpty(v.color),
    licensePlate: trimOrEmpty(v.licensePlate),
    photoUrl: trimOrEmpty(v.photoUrl),
    ...(year !== undefined ? { year } : {}),
  };
}

/**
 * Canonical driver vehicle for API output: DriverProfile.vehicle wins when set;
 * User.vehicle fills gaps (legacy / backfill).
 */
export function resolvedDriverVehicle(user, driverProfile) {
  const u = rawVehicleToPlain(user?.vehicle);
  const p = rawVehicleToPlain(driverProfile?.vehicle);
  const mergeStr = (key) => {
    const pv = p[key];
    if (typeof pv === "string" && pv.length > 0) return pv;
    const uv = u[key];
    return typeof uv === "string" ? uv : "";
  };
  const year =
    p.year !== undefined
      ? p.year
      : u.year !== undefined
        ? u.year
        : undefined;
  return {
    make: mergeStr("make"),
    model: mergeStr("model"),
    color: mergeStr("color"),
    licensePlate: mergeStr("licensePlate"),
    photoUrl: mergeStr("photoUrl"),
    ...(year !== undefined ? { year } : {}),
  };
}

function lastInitialFrom(lastName, fallbackName) {
  const last = trimOrEmpty(lastName);
  if (last.length > 0) return `${last[0].toUpperCase()}.`;
  const parts = trimOrEmpty(fallbackName).split(/\s+/).filter(Boolean);
  if (parts.length > 0) {
    const token = parts[parts.length - 1];
    if (token.length > 0) return `${token[0].toUpperCase()}.`;
  }
  return "";
}

function userIsDriver(user) {
  if (!user) return false;
  if (user.role === "driver") return true;
  return Array.isArray(user.roles) && user.roles.includes("driver");
}

/**
 * Rider-facing driver card (no private fields).
 * @param {object} [driverProfile] — lean or doc; vehicle merged via {@link resolvedDriverVehicle}.
 */
export function serializeDriverPublic(user, driverProfile) {
  if (!userIsDriver(user)) return undefined;
  const firstFromName = trimOrEmpty(user.name).split(/\s+/)[0] || "";
  const firstName = trimOrEmpty(user.firstName) || firstFromName || "Driver";
  const lastInitial = lastInitialFrom(user.lastName, user.name);
  const merged = resolvedDriverVehicle(user, driverProfile);
  const vy = merged.year;
  const year = vy != null && Number.isFinite(Number(vy)) ? Math.round(Number(vy)) : undefined;
  const vehicle = {
    ...(trimOrEmpty(merged.make) ? { make: trimOrEmpty(merged.make) } : {}),
    ...(trimOrEmpty(merged.model) ? { model: trimOrEmpty(merged.model) } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(trimOrEmpty(merged.color) ? { color: trimOrEmpty(merged.color) } : {}),
    ...(trimOrEmpty(merged.licensePlate) ? { licensePlate: trimOrEmpty(merged.licensePlate) } : {}),
    ...(trimOrEmpty(merged.photoUrl) ? { photoUrl: trimOrEmpty(merged.photoUrl) } : {}),
  };
  return {
    firstName,
    lastInitial,
    ...(trimOrEmpty(user.avatarUrl) ? { avatarUrl: trimOrEmpty(user.avatarUrl) } : {}),
    ...(Object.keys(vehicle).length > 0 ? { vehicle } : {}),
  };
}

/** Current user for GET /auth/me (no password hash). */
export function serializeUserMe(user, driverProfile) {
  if (!user) return null;
  const roles =
    Array.isArray(user.roles) && user.roles.length > 0
      ? user.roles
      : user.role
        ? [user.role]
        : ["rider"];
  const vMe = userIsDriver(user) ? resolvedDriverVehicle(user, driverProfile) : rawVehicleToPlain(user?.vehicle);
  const vy = vMe.year;
  const year =
    vy != null && Number.isFinite(Number(vy)) ? Math.round(Number(vy)) : undefined;
  const base = {
    _id: String(user._id),
    email: user.email ?? "",
    name: user.name,
    role: user.role || roles[0] || "rider",
    roles,
    isAdmin: Boolean(user.isAdmin),
    phoneE164: trimOrEmpty(user.phoneE164),
    phone: trimOrEmpty(user.phone),
    firstName: trimOrEmpty(user.firstName),
    lastName: trimOrEmpty(user.lastName),
    avatarUrl: trimOrEmpty(user.avatarUrl),
    vehicle: {
      make: trimOrEmpty(vMe.make),
      model: trimOrEmpty(vMe.model),
      ...(year !== undefined ? { year } : {}),
      color: trimOrEmpty(vMe.color),
      licensePlate: trimOrEmpty(vMe.licensePlate),
      photoUrl: trimOrEmpty(vMe.photoUrl),
    },
    createdAt: user.createdAt?.toISOString?.(),
    updatedAt: user.updatedAt?.toISOString?.(),
  };
  if (userIsDriver(user)) {
    base.driverPublic = serializeDriverPublic(user, driverProfile);
    if (driverProfile && typeof driverProfile === "object") {
      base.availableForRequests = Boolean(driverProfile.availableForRequests);
      base.driverStatus = driverProfile.driverStatus || "pending";
      const lic = driverProfile.license;
      if (lic && typeof lic === "object") {
        const exp = lic.expiry;
        const expIso =
          exp && typeof exp.toISOString === "function"
            ? exp.toISOString()
            : typeof exp === "string"
              ? exp
              : "";
        const licNum = trimOrEmpty(lic.number);
        const licStateRaw = trimOrEmpty(lic.state);
        const licState = licStateRaw
          ? licStateRaw.toUpperCase()
          : licNum || expIso
            ? "UT"
            : "";
        if (licNum || expIso || licState) {
          base.license = {
            ...(licNum ? { number: licNum } : {}),
            ...(licState ? { state: licState } : {}),
            ...(expIso ? { expiry: expIso } : {}),
          };
        }
      }
      if (typeof driverProfile.appTakePercent === "number" && Number.isFinite(driverProfile.appTakePercent)) {
        base.appTakePercent = Math.min(100, Math.max(0, Math.round(driverProfile.appTakePercent)));
      }
      base.stripeConnect = {
        payoutsEnabled: Boolean(driverProfile.stripeConnectPayoutsEnabled),
        detailsSubmitted: Boolean(driverProfile.stripeConnectDetailsSubmitted),
        needsOnboarding: !Boolean(driverProfile.stripeConnectPayoutsEnabled),
      };
    }
  }
  return base;
}

function driverIdFromTrip(t) {
  if (!t?.driver) return undefined;
  return String(t.driver._id ?? t.driver);
}

function riderIdFromTripDoc(t) {
  const r = t?.rider;
  if (r == null) return "";
  if (typeof r === "object" && r._id != null) return String(r._id);
  return String(r);
}

function isPopulatedDriver(driver) {
  return driver != null && typeof driver === "object" && driver._id != null && userIsDriver(driver);
}

/** Plain { lat, lng } for JSON (Mongoose subdocs / odd shapes safe). */
function pickLatLng(p) {
  if (p == null || typeof p !== "object") return undefined;
  const lat = typeof p.lat === "number" ? p.lat : Number(p.lat);
  const lng = typeof p.lng === "number" ? p.lng : Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

export function serializeTrip(t, options = {}) {
  const pickup = pickLatLng(t.pickup);
  const dropoff = pickLatLng(t.dropoff);
  const driverProfilePayload = isPopulatedDriver(t.driver)
    ? serializeDriverPublic(t.driver, options.driverProfile)
    : undefined;
  const riderPhoneRaw = options.riderPhone;
  const riderPhone =
    typeof riderPhoneRaw === "string" && riderPhoneRaw.trim() ? riderPhoneRaw.trim() : undefined;
  return {
    _id: String(t._id),
    riderId: riderIdFromTripDoc(t),
    driverId: driverIdFromTrip(t),
    ...(driverProfilePayload ? { driverProfile: driverProfilePayload } : {}),
    pickup: pickup ?? t.pickup,
    ...(t.pickupAddress ? { pickupAddress: t.pickupAddress } : {}),
    ...(dropoff ? { dropoff } : {}),
    ...(t.dropoffAddress ? { dropoffAddress: t.dropoffAddress } : {}),
    ...(t.preferredPickupAt ? { preferredPickupAt: t.preferredPickupAt.toISOString() } : {}),
    status: t.status,
    ...(t.driverArrivedAtPickupAt
      ? { driverArrivedAtPickupAt: t.driverArrivedAtPickupAt.toISOString() }
      : {}),
    ...(t.awaitingRiderCheckoutDeadlineAt
      ? { awaitingRiderCheckoutDeadlineAt: t.awaitingRiderCheckoutDeadlineAt.toISOString() }
      : {}),
    ...(riderPhone ? { riderPhone } : {}),
    driverLocation: t.driverLocation?.updatedAt
      ? {
          lat: t.driverLocation.lat,
          lng: t.driverLocation.lng,
          updatedAt: t.driverLocation.updatedAt.toISOString(),
        }
      : undefined,
    ...(t.etaToPickup?.computedAt
      ? {
          etaToPickup: {
            durationSeconds: t.etaToPickup.durationSeconds,
            durationText: t.etaToPickup.durationText,
            distanceMeters: t.etaToPickup.distanceMeters,
            distanceText: t.etaToPickup.distanceText,
            summaryMinutes: t.etaToPickup.summaryMinutes,
            usesTraffic: Boolean(t.etaToPickup.usesTraffic),
            computedAt: t.etaToPickup.computedAt.toISOString(),
          },
        }
      : {}),
    ...(t.etaToDropoff?.computedAt
      ? {
          etaToDropoff: {
            durationSeconds: t.etaToDropoff.durationSeconds,
            durationText: t.etaToDropoff.durationText,
            distanceMeters: t.etaToDropoff.distanceMeters,
            distanceText: t.etaToDropoff.distanceText,
            summaryMinutes: t.etaToDropoff.summaryMinutes,
            usesTraffic: Boolean(t.etaToDropoff.usesTraffic),
            computedAt: t.etaToDropoff.computedAt.toISOString(),
          },
        }
      : {}),
    ...(t.fareEstimate?.computedAt && typeof t.fareEstimate.total === "number"
      ? {
          fareEstimate: {
            currency: t.fareEstimate.currency || "USD",
            total: t.fareEstimate.total,
            breakdown: t.fareEstimate.breakdown,
            computedAt: t.fareEstimate.computedAt.toISOString(),
          },
        }
      : {}),
    ...(t.deadheadRoute?.computedAt
      ? {
          deadheadRoute: {
            computedAt: t.deadheadRoute.computedAt.toISOString(),
            provider: t.deadheadRoute.provider || "google_directions",
            origin: t.deadheadRoute.origin,
            destination: t.deadheadRoute.destination,
            distanceM: t.deadheadRoute.distanceM,
            durationSec: t.deadheadRoute.durationSec,
            encodedPolyline: t.deadheadRoute.encodedPolyline,
          },
        }
      : {}),
    ...(t.riderTipAmountCents != null && Number.isFinite(Number(t.riderTipAmountCents))
      ? { riderTipAmountCents: Math.round(Number(t.riderTipAmountCents)) }
      : {}),
    ...(t.rideRoute?.computedAt
      ? {
          rideRoute: {
            computedAt: t.rideRoute.computedAt.toISOString(),
            provider: t.rideRoute.provider || "google_directions",
            origin: t.rideRoute.origin,
            destination: t.rideRoute.destination,
            distanceM: t.rideRoute.distanceM,
            durationSec: t.rideRoute.durationSec,
            encodedPolyline: t.rideRoute.encodedPolyline,
          },
        }
      : {}),
    ...(t.fareChargeStatus && t.fareChargeStatus !== "none"
      ? {
          fareCharge: {
            status: t.fareChargeStatus,
            ...(t.fareChargeAmountCents != null ? { amountCents: t.fareChargeAmountCents } : {}),
            ...(t.fareChargeFareCents != null ? { farePortionCents: t.fareChargeFareCents } : {}),
            ...(t.fareChargeTipCents != null ? { tipPortionCents: t.fareChargeTipCents } : {}),
            ...(t.fareChargeCurrency ? { currency: t.fareChargeCurrency } : {}),
            ...(t.fareChargeError ? { error: t.fareChargeError } : {}),
            ...(t.fareChargeStatus === "requires_action" ? { requiresAction: true } : {}),
          },
        }
      : {}),
    ...(t.driverPayoutStatus && t.driverPayoutStatus !== "none"
      ? {
          driverPayout: {
            status: t.driverPayoutStatus,
            ...(t.driverPayoutAppTakeCents != null ? { appTakeCents: t.driverPayoutAppTakeCents } : {}),
            ...(t.driverPayoutStripeFeeCents != null ? { stripeFeeCents: t.driverPayoutStripeFeeCents } : {}),
            ...(t.driverPayoutNetCents != null ? { netCents: t.driverPayoutNetCents } : {}),
            ...(t.driverPayoutTransferId ? { transferId: t.driverPayoutTransferId } : {}),
            ...(t.driverPayoutError ? { error: t.driverPayoutError } : {}),
            ...(t.driverPayoutComputedAt ? { computedAt: t.driverPayoutComputedAt.toISOString() } : {}),
          },
        }
      : {}),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * Same as {@link serializeTrip} but loads {@link DriverProfile} when `driver` is populated
 * so `driverProfile.vehicle` reflects canonical profile data.
 */
export async function serializeTripPopulated(trip, options = {}) {
  if (!trip) return null;
  let dp = options.driverProfile;
  if (dp === undefined && isPopulatedDriver(trip.driver)) {
    dp = await DriverProfile.findOne({ userId: trip.driver._id }).lean().exec();
  }
  return serializeTrip(trip, { ...options, driverProfile: dp });
}
