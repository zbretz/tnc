import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import { Trip } from "./models/Trip.js";
import { authRouter } from "./routes/auth.js";
import { createTripsRouter } from "./routes/trips.js";
import { verifyToken } from "./middleware/auth.js";
import { serializeTrip } from "./serialize.js";
import { tryRefreshPickupEta } from "./pickupEta.js";
import { seedDevDriversIfNeeded } from "./seedDevDrivers.js";
import {
  ensureAppSettings,
  getRiderServiceConfig,
  riderFacingRiderServicePayload,
} from "./models/AppSettings.js";
import { createAdminRouter } from "./routes/admin.js";
import { routesRouter } from "./routes/routes.js";
import { pricingRouter } from "./routes/pricing.js";

const PORT = Number(process.env.PORT) || 3000;
// const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/tnc";
const MONGODB_URI = `mongodb+srv://zach:zach@tnc.uulxsfp.mongodb.net/`; 

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});

function emitTripRoom(tripId, event, payload) {
  io.to(`trip:${tripId}`).emit(event, payload);
}

const tripsRouter = createTripsRouter({
  onTripCreated(trip) {
    io.to("drivers").emit("trip:available", { trip });
  },
  onTripUpdated(trip) {
    emitTripRoom(trip._id, "trip:updated", { trip });
    io.to("drivers").emit("trips:refresh");
  },
  onDriverLocation(tripId, payload) {
    emitTripRoom(tripId, "driver:location", payload);
  },
});

const adminRouter = createAdminRouter({
  onRiderServiceUpdated(cfg) {
    io.to("riders").emit("riderService:updated", cfg);
  },
});

app.use("/auth", authRouter);
app.use("/trips", tripsRouter);
app.use("/admin", adminRouter);
app.use("/routes", routesRouter);
app.use("/pricing", pricingRouter);

app.get("/config/rider", async (_req, res) => {
  try {
    const cfg = await getRiderServiceConfig();
    res.json(riderFacingRiderServicePayload(cfg));
  } catch (e) {
    console.error("GET /config/rider", e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    (typeof socket.handshake.query.token === "string" ? socket.handshake.query.token : undefined);
  if (!token) {
    next(new Error("Unauthorized"));
    return;
  }
  try {
    const payload = verifyToken(token);
    socket.data.userId = payload.sub;
    socket.data.role = payload.role;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const { userId, role } = socket.data;
  if (role === "driver") {
    socket.join("drivers");
  }
  if (role === "rider") {
    socket.join("riders");
    getRiderServiceConfig()
      .then((cfg) => socket.emit("riderService:updated", riderFacingRiderServicePayload(cfg)))
      .catch(() => {});
  }

  socket.on("trip:subscribe", async (raw) => {
    const tripId = raw?.tripId;
    if (!tripId || !mongoose.isValidObjectId(tripId)) return;
    const trip = await Trip.findById(tripId).exec();
    if (!trip) return;
    const ok =
      String(trip.rider) === userId || (trip.driver != null && String(trip.driver) === userId);
    if (!ok) return;
    socket.join(`trip:${tripId}`);
  });

  socket.on("trip:unsubscribe", (raw) => {
    const tripId = raw?.tripId;
    if (!tripId) return;
    socket.leave(`trip:${tripId}`);
  });

  socket.on("driver:location", async (raw) => {
    const { tripId, lat, lng } = raw || {};
    if (!tripId || typeof lat !== "number" || typeof lng !== "number") return;
    if (!mongoose.isValidObjectId(tripId)) return;
    const trip = await Trip.findById(tripId).exec();
    if (!trip || String(trip.driver) !== userId) return;
    if (!["accepted", "in_progress"].includes(trip.status)) return;
    socket.join(`trip:${tripId}`);
    const now = new Date();
    trip.driverLocation = { lat, lng, updatedAt: now };
    await trip.save();
    await tryRefreshPickupEta(trip, lat, lng);
    const fresh = await Trip.findById(tripId)
      .populate({ path: "driver", select: "-passwordHash" })
      .exec();
    const serialized = fresh ? serializeTrip(fresh) : serializeTrip(trip);
    emitTripRoom(tripId, "driver:location", {
      lat,
      lng,
      updatedAt: now.toISOString(),
    });
    emitTripRoom(tripId, "trip:updated", { trip: serialized });
  });
});

mongoose.connect(MONGODB_URI).then(async () => {
  await ensureAppSettings().catch((e) => console.error("[tnc] ensureAppSettings", e));
  if (process.env.TNC_DEV_AUTH === "1") {
    await seedDevDriversIfNeeded().catch((e) => console.error("[tnc] seedDevDriversIfNeeded", e));
  }
  httpServer.listen(PORT, () => {
    console.log(`API + Socket.io http://10.0.0.135:${PORT}`);
  });
});
