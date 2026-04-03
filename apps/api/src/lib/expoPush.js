import Expo from "expo-server-sdk";
import { PushDevice } from "../models/PushDevice.js";
import { DriverProfile } from "../models/DriverProfile.js";

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN?.trim() || undefined,
});

const ANDROID_CHANNEL_ID = "trips";

function isPushConfigured() {
  // expo-server-sdk sends without EXPO_ACCESS_TOKEN unless your Expo project requires it.
  return true;
}

/**
 * @param {string[]} tokens
 * @param {(to: string) => object} buildExtras - returns { title, body, data }
 */
async function sendToExpoTokens(tokens, buildExtras) {
  if (!isPushConfigured() || tokens.length === 0) return;
  const messages = [];
  for (const to of tokens) {
    if (!Expo.isExpoPushToken(to)) continue;
    const extra = buildExtras(to);
    messages.push({
      to,
      sound: "default",
      title: extra.title,
      body: extra.body,
      data: extra.data || {},
      channelId: ANDROID_CHANNEL_ID,
    });
  }
  if (messages.length === 0) return;
  const chunks = expo.chunkPushNotifications(messages);
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const to = chunk[i]?.to;
        if (ticket.status === "error" && to) {
          const err = ticket.details?.error;
          if (err === "DeviceNotRegistered") {
            await PushDevice.deleteMany({ expoPushToken: to }).catch(() => {});
          } else {
            console.warn("[tnc:push] ticket error", err, ticket.message);
          }
        }
      }
    } catch (e) {
      console.error("[tnc:push] sendPushNotificationsAsync", e?.message || e);
    }
  }
}

async function tokensForUserApp(userId, app) {
  if (userId == null) return [];
  const s = String(userId);
  if (!/^[a-f0-9]{24}$/i.test(s)) return [];
  const rows = await PushDevice.find({ userId: s, app }).lean().exec();
  return rows.map((r) => r.expoPushToken).filter(Boolean);
}

export async function registerPushDevice({ userId, app, platform, expoPushToken }) {
  if (!["rider", "driver"].includes(app)) {
    const e = new Error("app must be rider or driver");
    e.code = "INVALID_APP";
    throw e;
  }
  const plat = ["ios", "android", "web"].includes(platform) ? platform : "ios";
  if (!Expo.isExpoPushToken(expoPushToken)) {
    const e = new Error("Invalid Expo push token");
    e.code = "INVALID_TOKEN";
    throw e;
  }
  await PushDevice.findOneAndUpdate(
    { userId, app, expoPushToken },
    { $set: { platform: plat, updatedAt: new Date() } },
    { upsert: true, new: true }
  ).exec();
}

export async function removePushDevice(userId, expoPushToken) {
  await PushDevice.deleteMany({ userId, expoPushToken }).exec();
}

/** New `requested` trip — notify drivers who are available and registered on the driver app. */
export async function notifyDriversNewOpenRequest(trip) {
  try {
    const activeDriverIds = await DriverProfile.find({ availableForRequests: true }).distinct("userId").exec();
    if (!activeDriverIds?.length) return;
    const devices = await PushDevice.find({
      app: "driver",
      userId: { $in: activeDriverIds },
    })
      .lean()
      .exec();
    const tokens = [...new Set(devices.map((d) => d.expoPushToken).filter((t) => Expo.isExpoPushToken(t)))];
    const tripId = trip?._id != null ? String(trip._id) : "";
    await sendToExpoTokens(tokens, () => ({
      title: "New ride request",
      body: "Open the app to view details.",
      data: { type: "open_request", tripId },
    }));
  } catch (e) {
    console.error("[tnc:push] notifyDriversNewOpenRequest", e);
  }
}

export async function notifyRiderDriverAccepted(trip) {
  try {
    const riderId = trip?.riderId;
    if (!riderId) return;
    const tokens = await tokensForUserApp(riderId, "rider");
    const tripId = trip?._id != null ? String(trip._id) : "";
    let eta = trip?.etaToPickup?.durationText || null;
    if (!eta && trip?.etaToPickup?.summaryMinutes != null) {
      eta = `About ${trip.etaToPickup.summaryMinutes} min`;
    }
    if (!eta && trip?.deadheadRoute?.durationSec != null) {
      eta = `About ${Math.ceil(trip.deadheadRoute.durationSec / 60)} min`;
    }
    const body = eta ? `Your driver is on the way — ${eta}.` : "Your driver is on the way.";
    await sendToExpoTokens(tokens, () => ({
      title: "Driver accepted",
      body,
      data: { type: "driver_accepted", tripId },
    }));
  } catch (e) {
    console.error("[tnc:push] notifyRiderDriverAccepted", e);
  }
}

export async function notifyRiderDriverArrived(trip) {
  try {
    const riderId = trip?.riderId;
    if (!riderId) return;
    const tokens = await tokensForUserApp(riderId, "rider");
    const tripId = trip?._id != null ? String(trip._id) : "";
    await sendToExpoTokens(tokens, () => ({
      title: "Driver arrived",
      body: "Your driver is at the pickup location.",
      data: { type: "driver_arrived_pickup", tripId },
    }));
  } catch (e) {
    console.error("[tnc:push] notifyRiderDriverArrived", e);
  }
}

const ACTIVE_TRIP = ["accepted", "in_progress", "awaiting_rider_checkout"];

/**
 * @param {{ trip: object, previousStatus: string, actorUserId: string, isDriverAdmin?: boolean }} opts
 */
export async function notifyTripCancelled({ trip, previousStatus, actorUserId, isDriverAdmin }) {
  try {
    if (!ACTIVE_TRIP.includes(previousStatus)) return;
    const riderId = trip?.riderId;
    const driverId = trip?.driverId;
    const tripId = trip?._id != null ? String(trip._id) : "";
    const actor = String(actorUserId || "");

    if (isDriverAdmin) {
      if (driverId) {
        const tokens = await tokensForUserApp(driverId, "driver");
        await sendToExpoTokens(tokens, () => ({
          title: "Trip canceled",
          body: "This ride has been canceled.",
          data: { type: "trip_cancelled", tripId },
        }));
      }
      if (riderId) {
        const tokens = await tokensForUserApp(riderId, "rider");
        await sendToExpoTokens(tokens, () => ({
          title: "Trip canceled",
          body: "Your ride has been canceled.",
          data: { type: "trip_cancelled", tripId },
        }));
      }
      return;
    }

    if (riderId && driverId && actor === String(riderId)) {
      const tokens = await tokensForUserApp(driverId, "driver");
      await sendToExpoTokens(tokens, () => ({
        title: "Trip canceled",
        body: "The rider canceled this ride.",
        data: { type: "trip_cancelled", tripId },
      }));
      return;
    }

    if (riderId && driverId && actor === String(driverId)) {
      const tokens = await tokensForUserApp(riderId, "rider");
      await sendToExpoTokens(tokens, () => ({
        title: "Trip canceled",
        body: "Your driver canceled this ride.",
        data: { type: "trip_cancelled", tripId },
      }));
    }
  } catch (e) {
    console.error("[tnc:push] notifyTripCancelled", e);
  }
}
