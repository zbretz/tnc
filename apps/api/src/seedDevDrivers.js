import bcrypt from "bcryptjs";
import { User } from "./models/User.js";
import { DriverProfile } from "./models/DriverProfile.js";

const SEEDS = [
  {
    email: "driver1@tnc.local",
    name: "Alex Rivera",
    firstName: "Alex",
    lastName: "Rivera",
    role: "driver",
    isAdmin: true,
    phone: "+1-555-0100",
    phoneE164: "+15550100100",
    vehicle: { make: "Toyota", model: "Camry", color: "Silver", licensePlate: "TNC-001", photoUrl: "" },
  },
  {
    email: "driver2@tnc.local",
    name: "Jordan Kim",
    firstName: "Jordan",
    lastName: "Kim",
    role: "driver",
    phoneE164: "+15550100200",
    vehicle: { make: "Honda", model: "Accord", color: "Blue", licensePlate: "TNC-002", photoUrl: "" },
  },
  {
    email: "driver3@tnc.local",
    name: "Sam Chen",
    firstName: "Sam",
    lastName: "Chen",
    role: "driver",
    phoneE164: "+15550100300",
    vehicle: { make: "Tesla", model: "Model 3", color: "White", licensePlate: "TNC-003", photoUrl: "" },
  },
];

/** Lowercase emails allowed for TNC_DEV_AUTH dev picker + dev login only (same as `SEEDS`). */
export const DEV_SEED_DRIVER_EMAILS = SEEDS.map((s) => s.email.toLowerCase());
export const DEV_SEED_DRIVER_EMAIL_SET = new Set(DEV_SEED_DRIVER_EMAILS);

/**
 * Ensures demo drivers exist when TNC_DEV_AUTH=1 (shared password TNC_DEV_PASSWORD or "dev").
 */
export async function seedDevDriversIfNeeded() {
  const password = process.env.TNC_DEV_PASSWORD || "dev";
  const passwordHash = await bcrypt.hash(password, 10);
  for (const s of SEEDS) {
    const email = s.email.toLowerCase();
    const existing = await User.findOne({ email }).exec();
    if (existing) continue;
    const created = await User.create({
      email,
      passwordHash,
      name: s.name,
      role: "driver",
      roles: ["driver"],
      firstName: s.firstName,
      lastName: s.lastName,
      avatarUrl: "",
      vehicle: s.vehicle,
      isAdmin: Boolean(s.isAdmin),
      phone: typeof s.phone === "string" ? s.phone : "",
    });
    await DriverProfile.create({
      userId: created._id,
      driverStatus: "active",
      vehicle: {
        make: s.vehicle.make || "",
        model: s.vehicle.model || "",
        color: s.vehicle.color || "",
        licensePlate: s.vehicle.licensePlate || "",
        photoUrl: s.vehicle.photoUrl || "",
      },
      license: { number: `SEED-${email}`, state: "UT", expiry: new Date("2030-12-31") },
      avatarUrl: "",
    }).catch((e) => console.error("[tnc] seed DriverProfile", e));
  }
  await User.updateOne(
    { email: "driver1@tnc.local" },
    { $set: { isAdmin: true, phone: "+1-555-0100", phoneE164: "+15550100100", phoneVerifiedAt: new Date() } }
  ).exec();

  for (const s of SEEDS) {
    const email = s.email.toLowerCase();
    if (s.phoneE164) {
      await User.updateOne(
        { email },
        { $set: { phoneE164: s.phoneE164, phoneVerifiedAt: new Date(), phone: s.phoneE164 } }
      ).exec();
    }
    const u = await User.findOne({ email }).exec();
    if (!u) continue;
    const has = await DriverProfile.findOne({ userId: u._id }).exec();
    if (has) continue;
    await DriverProfile.create({
      userId: u._id,
      driverStatus: "active",
      vehicle: {
        make: s.vehicle.make || "",
        model: s.vehicle.model || "",
        color: s.vehicle.color || "",
        licensePlate: s.vehicle.licensePlate || "",
        photoUrl: s.vehicle.photoUrl || "",
      },
      license: { number: `SEED-${email}`, state: "UT", expiry: new Date("2030-12-31") },
      avatarUrl: "",
    }).catch((e) => console.error("[tnc] seed DriverProfile backfill", e));
  }
}
