import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { OtpChallenge } from "../models/OtpChallenge.js";
import { authMiddleware, signToken } from "../middleware/auth.js";
import { serializeUserMe } from "../serialize.js";
import { normalizePhoneE164 } from "../lib/phone.js";

const r = Router();

const OTP_COOLDOWN_MS = 60_000;
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;

function devAuthEnabled() {
  return process.env.TNC_DEV_AUTH === "1";
}

function otpPepper() {
  return process.env.OTP_PEPPER || process.env.JWT_SECRET || "dev-only-change-me";
}

function hashOtpCode(phoneE164, code) {
  return crypto.createHmac("sha256", otpPepper()).update(`${phoneE164}:${code}`).digest("hex");
}

function randomFourDigitCode() {
  const n = crypto.randomInt(0, 10_000);
  return String(n).padStart(4, "0");
}

async function sendOtpSms(phoneE164, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    if (process.env.TNC_DEV_OTP_LOG === "1") {
      console.log("[tnc:otp] SMS not configured; code for", phoneE164, "=", code);
    }
    return { ok: false, skipped: true };
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const body = new URLSearchParams({
    To: phoneE164,
    From: from,
    Body: `Your TNC verification code: ${code}`,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("[tnc:otp] Twilio error", res.status, t);
    return { ok: false, error: "sms_send_failed" };
  }
  return { ok: true };
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

/**
 * POST /auth/otp/start { phone }
 * POST /auth/otp/verify { phone, code }
 */
r.post("/otp/start", async (req, res) => {
  const phoneE164 = normalizePhoneE164(req.body?.phone);
  if (!phoneE164) {
    res.status(400).json({ error: "Valid phone number required" });
    return;
  }
  const latest = await OtpChallenge.findOne({ phoneE164 }).sort({ createdAt: -1 }).exec();
  if (latest && !latest.consumedAt && Date.now() - latest.createdAt.getTime() < OTP_COOLDOWN_MS) {
    res.status(429).json({ error: "Please wait before requesting another code" });
    return;
  }
  const code = randomFourDigitCode();
  const codeHash = hashOtpCode(phoneE164, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await OtpChallenge.create({ phoneE164, codeHash, expiresAt, attempts: 0 });
  const sms = await sendOtpSms(phoneE164, code);
  if (!sms.ok && !sms.skipped) {
    res.status(502).json({ error: "Could not send SMS" });
    return;
  }
  res.status(201).json({ ok: true });
});

r.post("/otp/verify", async (req, res) => {
  const phoneE164 = normalizePhoneE164(req.body?.phone);
  const codeRaw = req.body?.code != null ? String(req.body.code).trim() : "";
  if (!phoneE164 || !/^\d{4}$/.test(codeRaw)) {
    res.status(400).json({ error: "phone and 4-digit code required" });
    return;
  }
  const challenge = await OtpChallenge.findOne({ phoneE164 }).sort({ createdAt: -1 }).exec();
  if (!challenge || challenge.consumedAt) {
    res.status(400).json({ error: "No active code" });
    return;
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    res.status(400).json({ error: "Code expired" });
    return;
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    res.status(400).json({ error: "Too many attempts" });
    return;
  }
  const expected = challenge.codeHash;
  const actual = hashOtpCode(phoneE164, codeRaw);
  if (expected.length !== actual.length) {
    challenge.attempts += 1;
    await challenge.save();
    res.status(401).json({ error: "Invalid code" });
    return;
  }
  const ok = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
  if (!ok) {
    challenge.attempts += 1;
    await challenge.save();
    res.status(401).json({ error: "Invalid code" });
    return;
  }
  challenge.consumedAt = new Date();
  await challenge.save();

  const firstNameIn =
    typeof req.body?.firstName === "string" ? req.body.firstName.trim().slice(0, 80) : "";
  const lastNameIn = typeof req.body?.lastName === "string" ? req.body.lastName.trim().slice(0, 80) : "";

  let user = await User.findOne({ phoneE164 }).exec();
  if (!user) {
    const displayName =
      [firstNameIn, lastNameIn].filter(Boolean).join(" ").trim() || "Rider";
    user = await User.create({
      phoneE164,
      firstName: firstNameIn,
      lastName: lastNameIn,
      name: displayName,
      role: "rider",
      roles: ["rider"],
      phoneVerifiedAt: new Date(),
      phone: phoneE164,
    });
  } else {
    user.phoneVerifiedAt = new Date();
    if (!user.phone) user.phone = phoneE164;
    await user.save();
  }
  const token = signToken(String(user._id), user);
  const fresh = await User.findById(user._id).select("-passwordHash").exec();
  res.json({ token, user: serializeUserMe(fresh) });
});

r.post("/register", async (req, res) => {
  const {
    email,
    password,
    name,
    role,
    firstName,
    lastName,
    avatarUrl: avatarIn,
    vehicle: vehicleRaw,
    phone: phoneIn,
  } = req.body || {};
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
    roles: [role],
  };
  if (role === "rider" && phoneIn != null && String(phoneIn).trim()) {
    doc.phone = String(phoneIn).trim().slice(0, 32);
  }
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
  if (role === "driver") {
    await DriverProfile.create({
      userId: user._id,
      driverStatus: "pending",
      vehicle: {
        make: doc.vehicle?.make || "",
        model: doc.vehicle?.model || "",
        color: doc.vehicle?.color || "",
        licensePlate: doc.vehicle?.licensePlate || "",
      },
      avatarUrl: typeof doc.avatarUrl === "string" ? doc.avatarUrl : "",
    }).catch((e) => console.error("[tnc] DriverProfile create", e));
  }
  const token = signToken(String(user._id), user);
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
  if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const token = signToken(String(user._id), user);
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
  const drivers = await User.find({
    $or: [{ role: "driver" }, { roles: { $in: ["driver"] } }],
  })
    .select("email name firstName lastName vehicle isAdmin")
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
      const label = [first, lastI].filter(Boolean).join(" ");
      return {
        id: String(d._id),
        label: d.isAdmin ? `${label} · admin` : label,
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
  const isDriver = user && (user.role === "driver" || (Array.isArray(user.roles) && user.roles.includes("driver")));
  if (!user || !isDriver) {
    res.status(404).json({ error: "Driver not found" });
    return;
  }
  const token = signToken(String(user._id), user);
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
  const { name, firstName, lastName, avatarUrl: avatarIn, vehicle: vehicleRaw, phone: phoneIn } = req.body || {};
  if (name != null) {
    const t = String(name).trim();
    if (!t) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    user.name = t;
  }
  if (user.role === "driver" || (Array.isArray(user.roles) && user.roles.includes("driver"))) {
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
  if (user.role === "rider" && phoneIn !== undefined) {
    user.phone = String(phoneIn).trim().slice(0, 32);
  }
  await user.save();
  const fresh = await User.findById(user._id).select("-passwordHash").exec();
  res.json({ user: serializeUserMe(fresh) });
});

export const authRouter = r;
