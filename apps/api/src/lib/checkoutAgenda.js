import { Agenda } from "agenda";
import { MongoBackend } from "@agendajs/mongo-backend";

const JOB_NAME = "auto-finalize-rider-checkout";

/** @type {Agenda | null} */
let agenda = null;

export function riderCheckoutDeadlineMs() {
  const v = Number(process.env.RIDER_CHECKOUT_DEADLINE_MINUTES);
  const minutes = Number.isFinite(v) && v > 0 ? v : 15;
  return Math.round(minutes * 60 * 1000);
}

export function checkoutDeadlineAfterNow() {
  return new Date(Date.now() + riderCheckoutDeadlineMs());
}

/**
 * @param {import("mongoose").Connection} mongoConnection
 * @param {{ onTripUpdated: (trip: object) => void }} deps
 */
export async function initCheckoutAgenda(mongoConnection, deps) {
  if (agenda) {
    return agenda;
  }
  const db = mongoConnection.db;
  if (!db) {
    console.warn("[tnc] MongoDB db not ready; checkout agenda disabled");
    return null;
  }
  const backend = new MongoBackend({
    mongo: db,
    collection: "tnc_agenda_jobs",
  });
  const instance = new Agenda({
    backend,
    processEvery: "10 seconds",
  });

  instance.define(
    JOB_NAME,
    async (job) => {
      const tripId = job.attrs.data?.tripId;
      if (!tripId) return;
      const { finalizeAwaitingTripCheckout } = await import("./finalizeAwaitingTripCheckout.js");
      const result = await finalizeAwaitingTripCheckout(String(tripId), {
        actorUserId: null,
        actorRoles: ["system"],
        eventPayload: { source: "checkout_deadline" },
      });
      if (result.ok && result.trip) {
        await cancelRiderCheckoutDeadline(tripId);
        deps.onTripUpdated(result.trip);
      } else if (!result.ok && result.error !== "not_awaiting") {
        console.warn("[tnc] auto-finalize checkout", tripId, result.error);
      }
    },
    { concurrency: 4 }
  );

  await instance.start();
  agenda = instance;
  return agenda;
}

export async function scheduleRiderCheckoutDeadline(tripId, runAt) {
  if (!agenda) return;
  const id = String(tripId);
  await agenda.cancel({ name: JOB_NAME, data: { tripId: id } }).catch(() => {});
  await agenda.schedule(runAt, JOB_NAME, { tripId: id });
}

export async function cancelRiderCheckoutDeadline(tripId) {
  if (!agenda) return;
  await agenda.cancel({ name: JOB_NAME, data: { tripId: String(tripId) } }).catch(() => {});
}
