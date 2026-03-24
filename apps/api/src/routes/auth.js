import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { authMiddleware, signToken } from "../middleware/auth.js";
import { serializeUserMe } from "../serialize.js";

const r = Router();

function devAuthEnabled() {
  return process.env.TNC_DEV_AUTH === "1";
}

/** MVP: allow HTTPS or data URLs; cap size before moving uploads to object storage. */
const MAX_MEDIA_URL_CHARS = 450_000;

function clip(s, max) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, max);
}

function parseMediaUrl(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length > MAX_MEDIA_URL_CHARS) return null;
  return t;
}

function parseVehicleBody(raw) {
  if (raw == null || typeof raw !== "object") return {};
  const make = clip(raw.make, 80);
  const model = clip(raw.model, 80);
  const color = clip(raw.color, 40);
  const licensePlate = clip(raw.licensePlate, 20);
  const photoUrlRaw = parseMediaUrl(raw.photoUrl);
  if (photoUrlRaw === null) return null;
  return { make, model, color, licensePlate, photoUrl: photoUrlRaw };
}

function splitNameForDriver(name, firstNameIn, lastNameIn) {
  const nameT = typeof name === "string" ? name.trim() : "";
  const parts = nameT.split(/\s+/).filter(Boolean);
  let first = typeof firstNameIn === "string" ? firstNameIn.trim() : "";
  let last = typeof lastNameIn === "string" ? lastNameIn.trim() : "";
  if (!first && parts.length) first = parts[0];
  if (!last && parts.length > 1) last = parts[parts.length - 1];
  return { first, last };
}

r.post("/register", async (req, res) => {
  const { email, password, name, role, firstName, lastName, avatarUrl: avatarIn, vehicle: vehicleRaw } =
    req.body || {};
  if (!email || !password || !name || !role || !["rider", "driver"].includes(role)) {
    res.status(400).json({ error: "email, password, name, and role (rider|driver) required" });
    return;
  }
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const doc = {
    email: email.toLowerCase(),
    passwordHash,
    name: String(name).trim(),
    role,
  };
  if (role === "driver") {
    const { first, last } = splitNameForDriver(name, firstName, lastName);
    doc.firstName = first;
    doc.lastName = last;
    const av = parseMediaUrl(avatarIn);
    if (av === null) {
      res.status(400).json({ error: "avatarUrl too large" });
      return;
    }
    doc.avatarUrl = av;
    const veh = parseVehicleBody(vehicleRaw);
    if (veh === null) {
      res.status(400).json({ error: "vehicle.photoUrl too large" });
      return;
    }
    doc.vehicle = veh;
  }
  const user = await User.create(doc);
  const token = signToken(String(user._id), user.role);
  res.status(201).json({
    token,
    user: serializeUserMe(user),
  });
});

r.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = signToken(String(user._id), user.role);
  res.json({
    token,
    user: serializeUserMe(user),
  });
});

r.get("/dev/drivers", async (req, res) => {
  if (!devAuthEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const drivers = await User.find({ role: "driver" })
    .select("email name firstName lastName vehicle")
    .sort({ email: 1 })
    .lean()
    .exec();
  res.json({
    drivers: drivers.map((d) => {
      const nameT = typeof d.name === "string" ? d.name.trim() : "";
      const firstFromName = nameT.split(/\s+/).filter(Boolean)[0] || "";
      const first = (typeof d.firstName === "string" ? d.firstName.trim() : "") || firstFromName || "Driver";
      const lastRaw = typeof d.lastName === "string" ? d.lastName.trim() : "";
      const lastI = lastRaw[0] ? `${lastRaw[0].toUpperCase()}.` : "";
      const v = d.vehicle && typeof d.vehicle === "object" ? d.vehicle : {};
      const vehLabel = [v.color, v.make, v.model].filter((x) => typeof x === "string" && x.trim()).join(" ");
      return {
        id: String(d._id),
        label: [first, lastI].filter(Boolean).join(" "),
        email: d.email,
        vehicleSummary: vehLabel,
      };
    }),
  });
});

r.post("/dev/login", async (req, res) => {
  if (!devAuthEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const driverId = req.body?.driverId;
  if (!driverId || !mongoose.isValidObjectId(String(driverId))) {
    res.status(400).json({ error: "driverId required" });
    return;
  }
  const user = await User.findById(driverId).exec();
  if (!user || user.role !== "driver") {
    res.status(404).json({ error: "Driver not found" });
    return;
  }
  const token = signToken(String(user._id), user.role);
  res.json({ token, user: serializeUserMe(user) });
});

r.get("/me", authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select("-passwordHash").exec();
  if (!user) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ user: serializeUserMe(user) });
});

r.patch("/me", authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).exec();
  if (!user) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, firstName, lastName, avatarUrl: avatarIn, vehicle: vehicleRaw } = req.body || {};
  if (name != null) {
    const t = String(name).trim();
    if (!t) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    user.name = t;
  }
  if (user.role === "driver") {
    if (firstName != null) user.firstName = String(firstName).trim().slice(0, 80);
    if (lastName != null) user.lastName = String(lastName).trim().slice(0, 80);
    if (avatarIn !== undefined) {
      const av = parseMediaUrl(avatarIn);
      if (av === null) {
        res.status(400).json({ error: "avatarUrl too large" });
        return;
      }
      user.avatarUrl = av;
    }
    if (vehicleRaw !== undefined) {
      const veh = parseVehicleBody(vehicleRaw);
      if (veh === null) {
        res.status(400).json({ error: "vehicle.photoUrl too large" });
        return;
      }
      const prev = user.vehicle?.toObject?.() ?? user.vehicle ?? {};
      user.vehicle = { ...prev, ...veh };
    }
  }
  await user.save();
  const fresh = await User.findById(user._id).select("-passwordHash").exec();
  res.json({ user: serializeUserMe(fresh) });
});

export const authRouter = r;
