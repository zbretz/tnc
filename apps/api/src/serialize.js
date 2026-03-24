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

/** Rider-facing driver card (no private fields). */
export function serializeDriverPublic(user) {
  if (!user || user.role !== "driver") return undefined;
  const firstFromName = trimOrEmpty(user.name).split(/\s+/)[0] || "";
  const firstName = trimOrEmpty(user.firstName) || firstFromName || "Driver";
  const lastInitial = lastInitialFrom(user.lastName, user.name);
  const v = user.vehicle && typeof user.vehicle === "object" ? user.vehicle : {};
  const vehicle = {
    ...(trimOrEmpty(v.make) ? { make: trimOrEmpty(v.make) } : {}),
    ...(trimOrEmpty(v.model) ? { model: trimOrEmpty(v.model) } : {}),
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
export function serializeUserMe(user) {
  if (!user) return null;
  const base = {
    _id: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    isAdmin: Boolean(user.isAdmin),
    phone: trimOrEmpty(user.phone),
    firstName: trimOrEmpty(user.firstName),
    lastName: trimOrEmpty(user.lastName),
    avatarUrl: trimOrEmpty(user.avatarUrl),
    vehicle:
      user.vehicle && typeof user.vehicle === "object"
        ? {
            make: trimOrEmpty(user.vehicle.make),
            model: trimOrEmpty(user.vehicle.model),
            color: trimOrEmpty(user.vehicle.color),
            licensePlate: trimOrEmpty(user.vehicle.licensePlate),
            photoUrl: trimOrEmpty(user.vehicle.photoUrl),
          }
        : {},
    createdAt: user.createdAt?.toISOString?.(),
    updatedAt: user.updatedAt?.toISOString?.(),
  };
  if (user.role === "driver") {
    base.driverPublic = serializeDriverPublic(user);
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
  return driver != null && typeof driver === "object" && driver._id != null && driver.role === "driver";
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
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
