import { Router } from "express";
import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { User, rolesFromUserDoc } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { serializeTrip } from "../serialize.js";
import { clearPickupEtaThrottle, tryRefreshPickupEta } from "../pickupEta.js";
import { getRiderServiceConfig } from "../models/AppSettings.js";
import { computeFareEstimate } from "../fareEstimate.js";
import { fetchDrivingRouteSummary } from "../googleDirections.js";
import { directionsApiKey } from "../lib/mapsKeys.js";
import { recordTripStatusEvent } from "../lib/tripEvents.js";
import { maxTipCentsAllowed, resolveTripFareUsd } from "../lib/chargeTripFare.js";
import { finalizeAwaitingTripCheckout } from "../lib/finalizeAwaitingTripCheckout.js";
import {
  cancelRiderCheckoutDeadline,
  checkoutDeadlineAfterNow,
  scheduleRiderCheckoutDeadline,
} from "../lib/checkoutAgenda.js";
import { getStripe, stripeEnabled } from "../lib/stripe.js";
import { effectiveRequirePaymentMethodToBook } from "../lib/paymentPolicy.js";
import { reconcileTripFareChargeFromStripe } from "../lib/reconcileTripFareCharge.js";
import { riderRetryTripFareCharge } from "../lib/retryTripFareCharge.js";

const POPULATE_DRIVER = { path: "driver", select: "-passwordHash" };

async function loadTripSerialized(id) {
  const t = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
  return t ? serializeTrip(t) : null;
}

/** Coerce JSON numbers that may arrive as strings; return null if invalid. */
function parseLatLng(obj) {
  if (obj == null || typeof obj !== "object") return null;
  const lat = typeof obj.lat === "number" ? obj.lat : Number(obj.lat);
  const lng = typeof obj.lng === "number" ? obj.lng : Number(obj.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function parseAddress(value) {
  if (typeof value !== "string") return null;
  const out = value.trim();
  if (!out) return null;
  return out.slice(0, 240);
}

function parsePickupOffsetMinutes(value) {
  if (value == null || value === "" || value === "asap") return 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (![0, 20, 40, 60].includes(n)) return null;
  return n;
}

function parsePreferredPickupAt(value) {
  if (value == null || value === "" || value === "asap") return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return undefined;
  return d;
}

function tripDriverIdString(trip) {
  if (!trip?.driver) return "";
  return String(trip.driver._id ?? trip.driver);
}

export function createTripsRouter(deps) {
  const r = Router();

  async function performCancel(req, res, id) {
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const trip = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
    if (!trip) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const uid = String(req.userId || "");
    const actor = await User.findById(uid).select("isAdmin role roles").lean().exec();
    const actorRoles = rolesFromUserDoc(actor);
    const isDriverAdmin = actorRoles.includes("driver") && actor?.isAdmin === true;
    const isRider = String(trip.rider) === uid;
    const isDriver = trip.driver != null && tripDriverIdString(trip) === uid;
    if (["completed", "cancelled"].includes(trip.status)) {
      if (!isRider && !isDriver && !isDriverAdmin) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.json({ trip: serializeTrip(trip) });
      return;
    }
    if (trip.status === "requested") {
      if (!isRider && !isDriverAdmin) {
        res.status(403).json({ error: "Only the rider or an admin driver can cancel a pending request" });
        return;
      }
    } else if (["accepted", "in_progress", "awaiting_rider_checkout"].includes(trip.status)) {
      if (!isRider && !isDriver && !isDriverAdmin) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    } else {
      res.status(400).json({ error: "Cannot cancel" });
      return;
    }
    const prev = trip.status;
    trip.status = "cancelled";
    trip.etaToPickup = null;
    trip.etaToDropoff = null;
    trip.awaitingRiderCheckoutDeadlineAt = null;
    clearPickupEtaThrottle(id);
    await trip.save();
    await cancelRiderCheckoutDeadline(id);
    await recordTripStatusEvent({
      tripId: trip._id,
      fromStatus: prev,
      toStatus: "cancelled",
      actorUserId: uid,
      actorRoles,
      payload: {},
    }).catch((e) => console.error("[tnc] TripEvent cancel", e));
    const out = await loadTripSerialized(id);
    deps.onTripUpdated(out);
    res.json({ trip: out });
  }

  r.post("/", authMiddleware, requireRole("rider"), async (req, res) => {
    const cfg = await getRiderServiceConfig();
    if (!cfg.driversAvailable) {
      res.status(503).json({
        error: cfg.closedMessage,
        code: "riders_closed",
      });
      return;
    }
    if (effectiveRequirePaymentMethodToBook()) {
      const riderPay = await User.findById(req.userId).select("stripeDefaultPaymentMethodId").lean().exec();
      if (!riderPay?.stripeDefaultPaymentMethodId?.trim()) {
        res.status(400).json({
          error: "Add a payment method before booking.",
          code: "payment_method_required",
        });
        return;
      }
    }
    const { pickup, dropoff, pickupAddress, dropoffAddress, pickupOffsetMinutes, preferredPickupAt } = req.body || {};
    const pickupLL = parseLatLng(pickup);
    if (!pickupLL) {
      res.status(400).json({ error: "pickup: { lat, lng } required" });
      return;
    }
    const dropoffLL = parseLatLng(dropoff);
    const pickupAddr = parseAddress(pickupAddress);
    const dropoffAddr = parseAddress(dropoffAddress);
    const preferredAtParsed = parsePreferredPickupAt(preferredPickupAt);
    if (preferredAtParsed === undefined) {
      res.status(400).json({ error: "preferredPickupAt must be an ISO date-time or null/asap" });
      return;
    }
    const offsetMinutes = parsePickupOffsetMinutes(pickupOffsetMinutes);
    if (offsetMinutes == null) {
      res.status(400).json({ error: "pickupOffsetMinutes must be one of: 0, 20, 40, 60" });
      return;
    }
    const preferredAtFromOffset = offsetMinutes > 0 ? new Date(Date.now() + offsetMinutes * 60 * 1000) : null;
    const resolvedPreferredPickupAt = preferredAtParsed ?? preferredAtFromOffset;
    const trip = await Trip.create({
      rider: req.userId,
      pickup: pickupLL,
      pickupAddress: pickupAddr,
      dropoff: dropoffLL,
      dropoffAddress: dropoffAddr,
      preferredPickupAt: resolvedPreferredPickupAt,
      status: "requested",
    });
    if (dropoffLL) {
      try {
        const fare = await computeFareEstimate(pickupLL, dropoffLL);
        if (fare.ok) {
          trip.fareEstimate = {
            currency: fare.estimate.currency,
            total: fare.estimate.total,
            breakdown: fare.estimate.breakdown,
            computedAt: new Date(fare.estimate.computedAt),
          };
          await trip.save();
        }
      } catch (e) {
        console.error("[tnc] fare estimate on trip create", e);
      }
    }
    const out = await loadTripSerialized(trip._id);
    deps.onTripCreated(out);
    res.status(201).json({ trip: out });
  });

  r.get("/available", authMiddleware, requireRole("driver"), async (req, res) => {
    const me = await User.findById(req.userId).select("isAdmin").lean().exec();
    const filter = { status: "requested" };
    const trips = me?.isAdmin
      ? await Trip.find(filter).sort({ createdAt: -1 }).limit(50).populate({ path: "rider", select: "phone" }).exec()
      : await Trip.find(filter).sort({ createdAt: -1 }).limit(50).exec();
    res.json({
      trips: trips.map((t) => {
        const phone =
          me?.isAdmin && t.rider && typeof t.rider === "object" && t.rider.phone
            ? String(t.rider.phone).trim()
            : undefined;
        return serializeTrip(t, phone ? { riderPhone: phone } : {});
      }),
    });
  });

  /** Body: { tripId } — avoids path quirks on some mobile HTTP stacks. */
  r.post("/cancel", authMiddleware, async (req, res) => {
    const raw = req.body?.tripId;
    const tripId = raw != null && raw !== "" ? String(raw).trim() : "";
    if (!tripId) {
      res.status(400).json({ error: "tripId required" });
      return;
    }
    try {
      await performCancel(req, res, tripId);
    } catch (err) {
      console.error("POST /trips/cancel", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Server error" });
      }
    }
  });

  r.post("/:id/accept", authMiddleware, requireRole("driver"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const trip = await Trip.findOne({ _id: id, status: "requested" }).exec();
    if (!trip) {
      res.status(409).json({ error: "Trip not available" });
      return;
    }
    const body = req.body || {};
    let oLat = typeof body.driverLat === "number" ? body.driverLat : Number(body.driverLat);
    let oLng = typeof body.driverLng === "number" ? body.driverLng : Number(body.driverLng);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLng)) {
      const prof = await DriverProfile.findOne({ userId: req.userId }).lean().exec();
      const coords = prof?.currentLocation?.coordinates;
      if (Array.isArray(coords) && coords.length >= 2) {
        oLng = Number(coords[0]);
        oLat = Number(coords[1]);
      }
    }
    const now = new Date();
    const set = {
      driver: req.userId,
      status: "accepted",
    };
    const key = directionsApiKey();
    if (key && Number.isFinite(oLat) && Number.isFinite(oLng)) {
      const summary = await fetchDrivingRouteSummary(
        { lat: oLat, lng: oLng },
        { lat: trip.pickup.lat, lng: trip.pickup.lng },
        key
      );
      if (summary.ok) {
        set.deadheadRoute = {
          computedAt: now,
          provider: "google_directions",
          origin: {
            lat: oLat,
            lng: oLng,
            accuracyM: typeof body.accuracyM === "number" ? body.accuracyM : undefined,
            recordedAt: now,
          },
          destination: { lat: trip.pickup.lat, lng: trip.pickup.lng },
          distanceM: summary.distanceM,
          durationSec: summary.durationSec,
          encodedPolyline: summary.encodedPolyline,
        };
      }
    }
    const updated = await Trip.findOneAndUpdate({ _id: id, status: "requested" }, { $set: set }, { new: true }).exec();
    if (!updated) {
      res.status(409).json({ error: "Trip not available" });
      return;
    }
    const actor = await User.findById(req.userId).select("role roles").lean().exec();
    await recordTripStatusEvent({
      tripId: updated._id,
      fromStatus: "requested",
      toStatus: "accepted",
      actorUserId: req.userId,
      actorRoles: rolesFromUserDoc(actor),
      payload: set.deadheadRoute
        ? {
            deadhead: {
              distanceM: set.deadheadRoute.distanceM,
              durationSec: set.deadheadRoute.durationSec,
            },
          }
        : {},
    }).catch((e) => console.error("[tnc] TripEvent accept", e));
    const populated = await Trip.findById(updated._id).populate(POPULATE_DRIVER).exec();
    const out = serializeTrip(populated);
    deps.onTripUpdated(out);
    res.json({ trip: out });
  });

  r.post("/:id/cancel", authMiddleware, async (req, res) => {
    try {
      await performCancel(req, res, req.params.id);
    } catch (err) {
      console.error("POST /trips/:id/cancel", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Server error" });
      }
    }
  });

  r.post("/:id/start-ride", authMiddleware, requireRole("driver"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const trip = await Trip.findById(id).exec();
    if (!trip || tripDriverIdString(trip) !== req.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (trip.status !== "accepted") {
      res.status(400).json({ error: "Trip must be accepted" });
      return;
    }
    const drop = trip.dropoff;
    if (!drop || !Number.isFinite(drop.lat) || !Number.isFinite(drop.lng)) {
      res.status(400).json({ error: "Trip missing dropoff" });
      return;
    }
    const key = directionsApiKey();
    const now = new Date();
    if (key) {
      const summary = await fetchDrivingRouteSummary(
        { lat: trip.pickup.lat, lng: trip.pickup.lng },
        { lat: drop.lat, lng: drop.lng },
        key
      );
      if (summary.ok) {
        trip.rideRoute = {
          computedAt: now,
          provider: "google_directions",
          origin: { lat: trip.pickup.lat, lng: trip.pickup.lng, recordedAt: now },
          destination: { lat: drop.lat, lng: drop.lng },
          distanceM: summary.distanceM,
          durationSec: summary.durationSec,
          encodedPolyline: summary.encodedPolyline,
        };
      }
    }
    trip.status = "in_progress";
    trip.etaToPickup = null;
    trip.etaToDropoff = null;
    clearPickupEtaThrottle(id);
    await trip.save();
    const actor = await User.findById(req.userId).select("role roles").lean().exec();
    await recordTripStatusEvent({
      tripId: trip._id,
      fromStatus: "accepted",
      toStatus: "in_progress",
      actorUserId: req.userId,
      actorRoles: rolesFromUserDoc(actor),
      payload: trip.rideRoute
        ? {
            ride: {
              distanceM: trip.rideRoute.distanceM,
              durationSec: trip.rideRoute.durationSec,
            },
          }
        : {},
    }).catch((e) => console.error("[tnc] TripEvent start", e));
    const out = await loadTripSerialized(id);
    deps.onTripUpdated(out);
    res.json({ trip: out });
  });

  /** Rider: tip in cents (integer >= 0), bundled with fare in one PaymentIntent when the driver completes. */
  r.post("/:id/rider-tip", authMiddleware, requireRole("rider"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const raw = req.body?.tipAmountCents;
    if (raw === undefined || raw === null || raw === "") {
      res.status(400).json({ error: "tipAmountCents required (integer cents >= 0)" });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "tipAmountCents must be a non-negative number" });
      return;
    }
    const tipCents = Math.round(n);
    if (tipCents !== n) {
      res.status(400).json({ error: "tipAmountCents must be a whole number of cents" });
      return;
    }
    try {
      const trip = await Trip.findById(id).exec();
      if (!trip || String(trip.rider) !== String(req.userId)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (!["accepted", "in_progress", "awaiting_rider_checkout"].includes(trip.status)) {
        res.status(400).json({ error: "Tip can only be set on an active trip" });
        return;
      }
      const fare = await resolveTripFareUsd(trip);
      if (!fare.ok) {
        res.status(400).json({ error: "Fare estimate unavailable; try again in a moment." });
        return;
      }
      const fareCents = fare.totalUsd > 0 ? Math.round(fare.totalUsd * 100) : 0;
      const maxTip = maxTipCentsAllowed(fareCents);
      if (tipCents > maxTip) {
        res.status(400).json({ error: `tipAmountCents cannot exceed ${maxTip}` });
        return;
      }
      trip.riderTipAmountCents = tipCents;
      await trip.save();
      const out = await loadTripSerialized(id);
      deps.onTripUpdated(out);
      res.json({ trip: out });
    } catch (e) {
      console.error("POST /trips/:id/rider-tip", e);
      res.status(500).json({ error: e?.message || "Server error" });
    }
  });

  /** Rider: after driver ends ride — set final tip (cents), charge fare+tip once, mark completed. */
  r.post("/:id/finalize-checkout", authMiddleware, requireRole("rider"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    try {
      const trip = await Trip.findById(id).exec();
      if (!trip || String(trip.rider) !== String(req.userId)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (trip.status !== "awaiting_rider_checkout") {
        res.status(400).json({ error: "Trip is not waiting for checkout" });
        return;
      }
      const raw = req.body?.tipAmountCents;
      if (raw === undefined || raw === null || raw === "") {
        res.status(400).json({ error: "tipAmountCents required (integer cents >= 0)" });
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        res.status(400).json({ error: "tipAmountCents must be a non-negative number" });
        return;
      }
      const tipCents = Math.round(n);
      if (tipCents !== n) {
        res.status(400).json({ error: "tipAmountCents must be a whole number of cents" });
        return;
      }

      const actor = await User.findById(req.userId).select("role roles").lean().exec();
      const result = await finalizeAwaitingTripCheckout(id, {
        tipCents,
        actorUserId: req.userId,
        actorRoles: rolesFromUserDoc(actor),
        eventPayload: {},
      });

      if (!result.ok) {
        if (result.error === "not_awaiting") {
          res.status(400).json({ error: "Trip is not waiting for checkout" });
          return;
        }
        if (result.error === "tip_too_large") {
          res.status(400).json({ error: `tipAmountCents cannot exceed ${result.maxTip}` });
          return;
        }
        if (result.error === "fare_unavailable") {
          res.status(400).json({ error: "Fare estimate unavailable; try again in a moment." });
          return;
        }
        if (result.error === "tip_invalid") {
          res.status(400).json({ error: "tipAmountCents must be a whole number of cents" });
          return;
        }
        if (result.error === "rider_not_found") {
          res.status(500).json({ error: "Rider not found" });
          return;
        }
        res.status(400).json({ error: result.error || "Cannot finalize checkout" });
        return;
      }

      await cancelRiderCheckoutDeadline(id);
      deps.onTripUpdated(result.trip);
      res.json({ trip: result.trip });
    } catch (e) {
      console.error("POST /trips/:id/finalize-checkout", e);
      res.status(500).json({ error: e?.message || "Server error" });
    }
  });

  /** Driver: end driving — rider must finalize checkout (tip + single charge) before trip is completed. */
  r.post("/:id/complete", authMiddleware, requireRole("driver"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const trip = await Trip.findById(id).exec();
    if (!trip || tripDriverIdString(trip) !== req.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!["accepted", "in_progress"].includes(trip.status)) {
      res.status(400).json({ error: "Trip not active" });
      return;
    }
    const prev = trip.status;
    trip.status = "awaiting_rider_checkout";
    trip.awaitingRiderCheckoutDeadlineAt = checkoutDeadlineAfterNow();
    trip.etaToPickup = null;
    trip.etaToDropoff = null;
    clearPickupEtaThrottle(id);
    await trip.save();
    await scheduleRiderCheckoutDeadline(trip._id, trip.awaitingRiderCheckoutDeadlineAt);
    const actor = await User.findById(req.userId).select("role roles").lean().exec();
    await recordTripStatusEvent({
      tripId: trip._id,
      fromStatus: prev,
      toStatus: "awaiting_rider_checkout",
      actorUserId: req.userId,
      actorRoles: rolesFromUserDoc(actor),
      payload: {},
    }).catch((e) => console.error("[tnc] TripEvent request checkout", e));
    const out = await loadTripSerialized(id);
    deps.onTripUpdated(out);
    res.json({ trip: out });
  });

  /** Rider: client secret to complete 3DS when off-session charge returned `requires_action`. */
  r.get("/:id/payment-client-secret", authMiddleware, requireRole("rider"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const trip = await Trip.findById(id).select("rider status fareChargeStatus stripePaymentIntentId").exec();
    if (!trip || String(trip.rider) !== String(req.userId)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (trip.status !== "completed" || trip.fareChargeStatus !== "requires_action" || !trip.stripePaymentIntentId) {
      res.status(400).json({ error: "No pending payment confirmation for this trip" });
      return;
    }
    if (!stripeEnabled()) {
      res.status(503).json({ error: "Payments not configured" });
      return;
    }
    try {
      const stripe = getStripe();
      const pi = await stripe.paymentIntents.retrieve(trip.stripePaymentIntentId);
      if (pi.status !== "requires_action" && pi.status !== "requires_confirmation") {
        res.status(400).json({ error: "Payment no longer requires action" });
        return;
      }
      res.json({ clientSecret: pi.client_secret });
    } catch (e) {
      console.error("GET /trips/:id/payment-client-secret", e);
      res.status(500).json({ error: e?.raw?.message || e?.message || "Server error" });
    }
  });

  /** Rider: refresh trip charge state from Stripe after 3DS / delayed settlement. */
  r.post("/:id/reconcile-fare-charge", authMiddleware, requireRole("rider"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await reconcileTripFareChargeFromStripe(id, req.userId);
    if (!result.ok) {
      const err = result.error;
      if (err === "forbidden") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (err === "not_found") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (err === "stripe_disabled" || err === "stripe_unconfigured") {
        res.status(503).json({ error: "Payments not configured" });
        return;
      }
      if (err === "not_completed" || err === "no_payment_intent") {
        res.status(400).json({ error: err });
        return;
      }
      res.status(400).json({ error: err || "reconcile_failed" });
      return;
    }
    res.json({ trip: result.trip });
  });

  /** Rider: new charge attempt after failure, no card, or missing estimate (completed trip only). */
  r.post("/:id/retry-fare-charge", authMiddleware, requireRole("rider"), async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await riderRetryTripFareCharge(id, req.userId);
    if (!result.ok) {
      const err = result.error;
      if (err === "forbidden") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (err === "not_found") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (err === "stripe_disabled") {
        res.status(503).json({ error: "Payments not configured" });
        return;
      }
      if (err === "not_completed" || err === "not_retryable") {
        res.status(400).json({ error: err });
        return;
      }
      res.status(400).json({ error: err || "retry_failed" });
      return;
    }
    res.json({ trip: result.trip });
  });

  r.patch("/:id/driver-location", authMiddleware, requireRole("driver"), async (req, res) => {
    const id = req.params.id;
    const { lat, lng } = req.body || {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(400).json({ error: "lat and lng required" });
      return;
    }
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const trip = await Trip.findById(id).exec();
    if (!trip || tripDriverIdString(trip) !== req.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!["accepted", "in_progress"].includes(trip.status)) {
      res.status(400).json({ error: "Trip not active" });
      return;
    }
    const now = new Date();
    trip.driverLocation = { lat, lng, updatedAt: now };
    await trip.save();
    await DriverProfile.updateOne(
      { userId: req.userId },
      {
        $set: {
          currentLocation: { type: "Point", coordinates: [lng, lat] },
          locationUpdatedAt: now,
        },
      }
    ).exec();
    await tryRefreshPickupEta(trip, lat, lng);
    const out = await loadTripSerialized(id);
    deps.onDriverLocation?.(id, {
      lat,
      lng,
      updatedAt: now.toISOString(),
    });
    deps.onTripUpdated(out);
    res.json({ trip: out });
  });

  r.get("/:id", authMiddleware, async (req, res) => {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const trip = await Trip.findById(id).populate(POPULATE_DRIVER).exec();
    if (!trip) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const riderOk = String(trip.rider) === req.userId;
    const driverOk = trip.driver && tripDriverIdString(trip) === req.userId;
    if (!riderOk && !driverOk) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json({ trip: serializeTrip(trip) });
  });

  return r;
}
