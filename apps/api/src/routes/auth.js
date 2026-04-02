import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { OtpChallenge } from "../models/OtpChallenge.js";
import {
  authMiddleware,
  signDriverOtpSignupToken,
  signRiderSignupToken,
  signToken,
  verifyDriverOtpSignupToken,
  verifyRiderSignupToken,
} from "../middleware/auth.js";
import { serializeUserMe } from "../serialize.js";
import { normalizePhoneE164 } from "../lib/phone.js";
import { DEV_SEED_DRIVER_EMAILS, DEV_SEED_DRIVER_EMAIL_SET } from "../seedDevDrivers.js";

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
  if (typeof raw !== "string") return "";
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
  let year;
  if (raw.year !== undefined && raw.year !== null && raw.year !== "") {
    const y = typeof raw.year === "number" ? raw.year : parseInt(String(raw.year).trim(), 10);
    const maxY = new Date().getFullYear() + 2;
    if (Number.isInteger(y) && y >= 1980 && y <= maxY) {
      year = y;
    }
  }
  return { make, model, color, licensePlate, photoUrl: photoUrlRaw, ...(year !== undefined ? { year } : {}) };
}

/** Driver's license (ID), not vehicle plate. */
function parseLicenseBody(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const number = clip(raw.number, 48);
  let expiry;
  if (raw.expiry != null && raw.expiry !== "") {
    const d = new Date(raw.expiry);
    if (!Number.isFinite(d.getTime())) return null;
    expiry = d;
  }
  return { number, expiry };
}

function userIsDriverDoc(user) {
  if (!user) return false;
  if (user.role === "driver") return true;
  return Array.isArray(user.roles) && user.roles.includes("driver");
}

async function serializeUserMeForAuth(userDoc) {
  if (!userDoc) return null;
  let prof = null;
  if (userIsDriverDoc(userDoc)) {
    prof = await DriverProfile.findOne({ userId: userDoc._id }).lean().exec();
  }
  return serializeUserMe(userDoc, prof);
}

/**
 * POST /auth/otp/start { phone }
 * POST /auth/otp/verify { phone, code, intent?: "rider"|"driver" }
 *   rider (default): { token, user } or { needsProfile, signupToken }
 *   driver: { token, user } only; 404 if no driver for phone; 403 if phone is not a driver
 * POST /auth/otp/complete-profile { signupToken, firstName, lastName }
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

  const intent = req.body?.intent === "driver" ? "driver" : "rider";
  const allowDriverSignup = req.body?.allowSignup === true;

  let user = await User.findOne({ phoneE164 }).exec();
  if (!user) {
    if (intent === "driver") {
      if (allowDriverSignup) {
        const signupToken = signDriverOtpSignupToken(phoneE164);
        res.json({ needsProfile: true, signupToken });
        return;
      }
      res.status(404).json({
        error: "No driver account for this number. Use Create account if you’re new, or check the number you registered with.",
      });
      return;
    }
    const signupToken = signRiderSignupToken(phoneE164);
    res.json({ needsProfile: true, signupToken });
    return;
  }
  if (intent === "driver" && !userIsDriverDoc(user)) {
    res.status(403).json({ error: "This phone is not registered as a driver account." });
    return;
  }
  user.phoneVerifiedAt = new Date();
  if (!user.phone) user.phone = phoneE164;
  await user.save();
  const token = signToken(String(user._id), user);
  const fresh = await User.findById(user._id).select("-passwordHash").exec();
  const payloadUser = userIsDriverDoc(fresh) ? await serializeUserMeForAuth(fresh) : serializeUserMe(fresh);
  res.json({ token, user: payloadUser });
});

/**
 * POST /auth/otp/complete-profile { signupToken, firstName, lastName }
 * Finishes rider signup after POST /auth/otp/verify returned needsProfile.
 */
r.post("/otp/complete-profile", async (req, res) => {
  const raw = req.body?.signupToken;
  if (typeof raw !== "string" || !raw.trim()) {
    res.status(400).json({ error: "signupToken required" });
    return;
  }
  let phoneE164;
  try {
    ({ phoneE164 } = verifyRiderSignupToken(raw.trim()));
  } catch {
    res.status(401).json({ error: "Invalid or expired signup token" });
    return;
  }
  const firstNameIn =
    typeof req.body?.firstName === "string" ? req.body.firstName.trim().slice(0, 80) : "";
  const lastNameIn = typeof req.body?.lastName === "string" ? req.body.lastName.trim().slice(0, 80) : "";
  if (!firstNameIn || !lastNameIn) {
    res.status(400).json({ error: "first and last name required" });
    return;
  }
  let user = await User.findOne({ phoneE164 }).exec();
  if (user) {
    const token = signToken(String(user._id), user);
    const fresh = await User.findById(user._id).select("-passwordHash").exec();
    res.json({ token, user: serializeUserMe(fresh) });
    return;
  }
  const displayName = [firstNameIn, lastNameIn].filter(Boolean).join(" ").trim();
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
  const token = signToken(String(user._id), user);
  const fresh = await User.findById(user._id).select("-passwordHash").exec();
  res.json({ token, user: serializeUserMe(fresh) });
});

/**
 * POST /auth/otp/complete-driver-profile — finish driver signup after verify with intent=driver & allowSignup.
 */
r.post("/otp/complete-driver-profile", async (req, res) => {
  const raw = req.body?.signupToken;
  if (typeof raw !== "string" || !raw.trim()) {
    res.status(400).json({ error: "signupToken required" });
    return;
  }
  let phoneE164;
  try {
    ({ phoneE164 } = verifyDriverOtpSignupToken(raw.trim()));
  } catch {
    res.status(401).json({ error: "Invalid or expired signup token" });
    return;
  }
  const firstNameIn =
    typeof req.body?.firstName === "string" ? req.body.firstName.trim().slice(0, 80) : "";
  const lastNameIn = typeof req.body?.lastName === "string" ? req.body.lastName.trim().slice(0, 80) : "";
  if (!firstNameIn || !lastNameIn) {
    res.status(400).json({ error: "firstName and lastName required" });
    return;
  }
  const av = parseMediaUrl(req.body?.avatarUrl);
  if (av === null) {
    res.status(400).json({ error: "avatarUrl too large" });
    return;
  }
  const veh = parseVehicleBody(req.body?.vehicle);
  if (veh === null) {
    res.status(400).json({ error: "vehicle photoUrl exceeds maximum length" });
    return;
  }
  if (!veh.make || !veh.model || !veh.licensePlate) {
    res.status(400).json({ error: "vehicle make, model, and licensePlate required" });
    return;
  }
  const lic = parseLicenseBody(req.body?.license);
  if (lic === null) {
    res.status(400).json({ error: "invalid license payload" });
    return;
  }
  if (!lic.number || !lic.expiry) {
    res.status(400).json({ error: "license number and expiry required" });
    return;
  }

  let user = await User.findOne({ phoneE164 }).exec();
  if (user) {
    if (!userIsDriverDoc(user)) {
      res.status(409).json({ error: "This phone is already registered to a non-driver account." });
      return;
    }
    const token = signToken(String(user._id), user);
    const fresh = await User.findById(user._id).select("-passwordHash").exec();
    res.json({ token, user: await serializeUserMeForAuth(fresh) });
    return;
  }

  const displayName = [firstNameIn, lastNameIn].filter(Boolean).join(" ").trim();
  user = await User.create({
    phoneE164,
    firstName: firstNameIn,
    lastName: lastNameIn,
    name: displayName,
    role: "driver",
    roles: ["driver"],
    phoneVerifiedAt: new Date(),
    phone: phoneE164,
    avatarUrl: av,
    vehicle: veh,
  });
  const v = veh;
  await DriverProfile.create({
    userId: user._id,
    driverStatus: "pending",
    vehicle: {
      make: v.make || "",
      model: v.model || "",
      ...(v.year !== undefined ? { year: v.year } : {}),
      color: v.color || "",
      licensePlate: v.licensePlate || "",
      photoUrl: v.photoUrl || "",
    },
    license: {
      number: lic.number,
      expiry: lic.expiry,
    },
    avatarUrl: av,
  }).catch((e) => console.error("[tnc] DriverProfile create (otp signup)", e));
  const token = signToken(String(user._id), user);
  const fresh = await User.findById(user._id).select("-passwordHash").exec();
  res.status(201).json({ token, user: await serializeUserMeForAuth(fresh) });
});

r.post("/register", async (req, res) => {
  const { email, password, name, role, phone: phoneIn } = req.body || {};
  if (!role || !["rider", "driver"].includes(role)) {
    res.status(400).json({ error: "role (rider|driver) required" });
    return;
  }
  if (role === "driver") {
    res.status(400).json({
      error: "Driver signup uses phone verification only. Use the driver app: Create account → SMS code → profile.",
    });
    return;
  }
  if (!email || !password || !name) {
    res.status(400).json({ error: "email, password, and name required" });
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
  const user = await User.create(doc);
  const token = signToken(String(user._id), user);
  res.status(201).json({
    token,
    user: serializeUserMe(user),
  });
});

r.post("/login", async (req, res) => {
  const { email, password, roleHint } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (roleHint === "driver" && !userIsDriverDoc(user)) {
    res.status(403).json({ error: "This email is not a driver account." });
    return;
  }
  const token = signToken(String(user._id), user);
  res.json({
    token,
    user: await serializeUserMeForAuth(user),
  });
});

r.get("/dev/drivers", async (req, res) => {
  if (!devAuthEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const drivers = await User.find({
    $or: [{ role: "driver" }, { roles: { $in: ["driver"] } }],
    email: { $in: DEV_SEED_DRIVER_EMAILS },
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
  const emailKey = String(user.email || "").toLowerCase();
  if (!DEV_SEED_DRIVER_EMAIL_SET.has(emailKey)) {
    res.status(403).json({ error: "Dev sign-in is only for seed demo drivers" });
    return;
  }
  const token = signToken(String(user._id), user);
  res.json({ token, user: await serializeUserMeForAuth(user) });
});

r.get("/me", authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select("-passwordHash").exec();
  if (!user) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ user: await serializeUserMeForAuth(user) });
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
  const isDriver = user.role === "driver" || (Array.isArray(user.roles) && user.roles.includes("driver"));
  if (isDriver) {
    if (firstName != null) user.firstName = String(firstName).trim().slice(0, 80);
    if (lastName != null) user.lastName = String(lastName).trim().slice(0, 80);
    if (firstName != null || lastName != null) {
      const fn = String(user.firstName || "").trim();
      const ln = String(user.lastName || "").trim();
      if (fn && ln) user.name = [fn, ln].join(" ");
    }
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
        res.status(400).json({ error: "vehicle photoUrl exceeds maximum length" });
        return;
      }
      const prev = user.vehicle?.toObject?.() ?? user.vehicle ?? {};
      user.vehicle = { ...prev, ...veh };
    }
  }
  if (user.role === "rider" && phoneIn !== undefined) {
    user.phone = String(phoneIn).trim().slice(0, 32);
  }
  if (isDriver && phoneIn !== undefined) {
    const p = normalizePhoneE164(phoneIn);
    if (!p) {
      res.status(400).json({ error: "Invalid phone number" });
      return;
    }
    const taken = await User.findOne({ phoneE164: p, _id: { $ne: user._id } }).lean().exec();
    if (taken) {
      res.status(409).json({ error: "Phone number already in use" });
      return;
    }
    user.phoneE164 = p;
    user.phone = p;
  }
  await user.save();
  if (isDriver && (vehicleRaw !== undefined || avatarIn !== undefined)) {
    const prof = await DriverProfile.findOne({ userId: user._id }).exec();
    if (prof) {
      const uv = user.vehicle?.toObject?.() ?? user.vehicle ?? {};
      prof.vehicle = {
        make: uv.make || "",
        model: uv.model || "",
        ...(uv.year != null && Number.isFinite(Number(uv.year)) ? { year: Math.round(Number(uv.year)) } : {}),
        color: uv.color || "",
        licensePlate: uv.licensePlate || "",
        photoUrl: uv.photoUrl || "",
      };
      if (avatarIn !== undefined) prof.avatarUrl = user.avatarUrl || "";
      await prof.save().catch((e) => console.error("[tnc] DriverProfile sync from PATCH /me", e));
    }
  }
  const fresh = await User.findById(user._id).select("-passwordHash").exec();
  res.json({ user: await serializeUserMeForAuth(fresh) });
});

export const authRouter = r;
