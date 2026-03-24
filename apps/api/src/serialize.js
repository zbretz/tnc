/** Plain { lat, lng } for JSON (Mongoose subdocs / odd shapes safe). */
function pickLatLng(p) {
  if (p == null || typeof p !== "object") return undefined;
  const lat = typeof p.lat === "number" ? p.lat : Number(p.lat);
  const lng = typeof p.lng === "number" ? p.lng : Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
}

export function serializeTrip(t) {
  const pickup = pickLatLng(t.pickup);
  const dropoff = pickLatLng(t.dropoff);
  return {
    _id: String(t._id),
    riderId: String(t.rider),
    driverId: t.driver ? String(t.driver) : undefined,
    pickup: pickup ?? t.pickup,
    ...(t.pickupAddress ? { pickupAddress: t.pickupAddress } : {}),
    ...(dropoff ? { dropoff } : {}),
    ...(t.dropoffAddress ? { dropoffAddress: t.dropoffAddress } : {}),
    status: t.status,
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
