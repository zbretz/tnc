import bcrypt from "bcryptjs";
import { User } from "./models/User.js";

const SEEDS = [
  {
    email: "driver1@tnc.local",
    name: "Alex Rivera",
    firstName: "Alex",
    lastName: "Rivera",
    role: "driver",
    vehicle: { make: "Toyota", model: "Camry", color: "Silver", licensePlate: "TNC-001", photoUrl: "" },
  },
  {
    email: "driver2@tnc.local",
    name: "Jordan Kim",
    firstName: "Jordan",
    lastName: "Kim",
    role: "driver",
    vehicle: { make: "Honda", model: "Accord", color: "Blue", licensePlate: "TNC-002", photoUrl: "" },
  },
  {
    email: "driver3@tnc.local",
    name: "Sam Chen",
    firstName: "Sam",
    lastName: "Chen",
    role: "driver",
    vehicle: { make: "Tesla", model: "Model 3", color: "White", licensePlate: "TNC-003", photoUrl: "" },
  },
];

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
    await User.create({
      email,
      passwordHash,
      name: s.name,
      role: "driver",
      firstName: s.firstName,
      lastName: s.lastName,
      avatarUrl: "",
      vehicle: s.vehicle,
    });
  }
}
