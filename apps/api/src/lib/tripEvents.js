import { TripEvent } from "../models/TripEvent.js";

export async function recordTripStatusEvent({
  tripId,
  fromStatus,
  toStatus,
  actorUserId,
  actorRoles,
  payload,
}) {
  await TripEvent.create({
    tripId,
    type: "trip.status_changed",
    fromStatus,
    toStatus,
    actorUserId: actorUserId || undefined,
    actorRoles: Array.isArray(actorRoles) ? actorRoles : [],
    payload: payload && typeof payload === "object" ? payload : undefined,
  });
}
