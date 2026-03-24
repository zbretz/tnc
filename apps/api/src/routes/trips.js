import { Router } from "express";
import mongoose from "mongoose";
import { Trip } from "../models/Trip.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { serializeTrip } from "../serialize.js";
import { clearPickupEtaThrottle, tryRefreshPickupEta } from "../pickupEta.js";

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
    const isRider = String(trip.rider) === uid;
    const isDriver = trip.driver != null && tripDriverIdString(trip) === uid;
    if (["completed", "cancelled"].includes(trip.status)) {
      if (!isRider && !isDriver) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.json({ trip: serializeTrip(trip) });
      return;
    }
    if (trip.status === "requested") {
      if (!isRider) {
        res.status(403).json({ error: "Only the rider can cancel a pending request" });
        return;
      }
    } else if (["accepted", "in_progress"].includes(trip.status)) {
      if (!isRider && !isDriver) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    } else {
      res.status(400).json({ error: "Cannot cancel" });
      return;
    }
    trip.status = "cancelled";
    trip.etaToPickup = null;
    clearPickupEtaThrottle(id);
    await trip.save();
    const out = await loadTripSerialized(id);
    deps.onTripUpdated(out);
    res.json({ trip: out });
  }

  r.post("/", authMiddleware, requireRole("rider"), async (req, res) => {
    const { pickup, dropoff, pickupAddress, dropoffAddress } = req.body || {};
    const pickupLL = parseLatLng(pickup);
    if (!pickupLL) {
      res.status(400).json({ error: "pickup: { lat, lng } required" });
      return;
    }
    const dropoffLL = parseLatLng(dropoff);
    const pickupAddr = parseAddress(pickupAddress);
    const dropoffAddr = parseAddress(dropoffAddress);
    const trip = await Trip.create({
      rider: req.userId,
      pickup: pickupLL,
      pickupAddress: pickupAddr,
      dropoff: dropoffLL,
      dropoffAddress: dropoffAddr,
      status: "requested",
    });
    const out = serializeTrip(trip);
    deps.onTripCreated(out);
    res.status(201).json({ trip: out });
  });

  r.get("/available", authMiddleware, requireRole("driver"), async (_req, res) => {
    const trips = await Trip.find({ status: "requested" }).sort({ createdAt: -1 }).limit(50).exec();
    res.json({ trips: trips.map(serializeTrip) });
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
    const updated = await Trip.findOneAndUpdate(
      { _id: id, status: "requested" },
      { $set: { driver: req.userId, status: "accepted" } },
      { new: true }
    ).exec();
    if (!updated) {
      res.status(409).json({ error: "Trip not available" });
      return;
    }
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
    trip.status = "in_progress";
    trip.etaToPickup = null;
    clearPickupEtaThrottle(id);
    await trip.save();
    const out = await loadTripSerialized(id);
    deps.onTripUpdated(out);
    res.json({ trip: out });
  });

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
    trip.status = "completed";
    trip.etaToPickup = null;
    clearPickupEtaThrottle(id);
    await trip.save();
    const out = await loadTripSerialized(id);
    deps.onTripUpdated(out);
    res.json({ trip: out });
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
