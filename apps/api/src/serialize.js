function trimOrEmpty(s) {
  return typeof s === "string" ? s.trim() : "";
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

/** Rider-facing driver card (no private fields). */
export function serializeDriverPublic(user) {
  if (!userIsDriver(user)) return undefined;
  const firstFromName = trimOrEmpty(user.name).split(/\s+/)[0] || "";
  const firstName = trimOrEmpty(user.firstName) || firstFromName || "Driver";
  const lastInitial = lastInitialFrom(user.lastName, user.name);
  const v = user.vehicle && typeof user.vehicle === "object" ? user.vehicle : {};
  const vy = v.year;
  const year = vy != null && Number.isFinite(Number(vy)) ? Math.round(Number(vy)) : undefined;
  const vehicle = {
    ...(trimOrEmpty(v.make) ? { make: trimOrEmpty(v.make) } : {}),
    ...(trimOrEmpty(v.model) ? { model: trimOrEmpty(v.model) } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(trimOrEmpty(v.color) ? { color: trimOrEmpty(v.color) } : {}),
    ...(trimOrEmpty(v.licensePlate) ? { licensePlate: trimOrEmpty(v.licensePlate) } : {}),
    ...(trimOrEmpty(v.photoUrl) ? { photoUrl: trimOrEmpty(v.photoUrl) } : {}),
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
  const vy = user.vehicle?.year;
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
    vehicle:
      user.vehicle && typeof user.vehicle === "object"
        ? {
            make: trimOrEmpty(user.vehicle.make),
            model: trimOrEmpty(user.vehicle.model),
            ...(year !== undefined ? { year } : {}),
            color: trimOrEmpty(user.vehicle.color),
            licensePlate: trimOrEmpty(user.vehicle.licensePlate),
            photoUrl: trimOrEmpty(user.vehicle.photoUrl),
          }
        : {},
    createdAt: user.createdAt?.toISOString?.(),
    updatedAt: user.updatedAt?.toISOString?.(),
  };
  if (userIsDriver(user)) {
    base.driverPublic = serializeDriverPublic(user);
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
  const driverProfile = isPopulatedDriver(t.driver) ? serializeDriverPublic(t.driver) : undefined;
  const riderPhoneRaw = options.riderPhone;
  const riderPhone =
    typeof riderPhoneRaw === "string" && riderPhoneRaw.trim() ? riderPhoneRaw.trim() : undefined;
  return {
    _id: String(t._id),
    riderId: riderIdFromTripDoc(t),
    driverId: driverIdFromTrip(t),
    ...(driverProfile ? { driverProfile } : {}),
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
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
