import mongoose from "mongoose";

const vehicleSchema = new mongoose.Schema(
  {
    make: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    color: { type: String, default: "", trim: true },
    licensePlate: { type: String, default: "", trim: true },
    /** Vehicle photo (MVP: HTTPS or data URL; move to object storage later). */
    photoUrl: { type: String, default: "" },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    /** Legacy display name; kept for riders and migration. */
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ["rider", "driver"], required: true },
    /** Driver-facing legal / account name split (rider sees last initial only). */
    firstName: { type: String, default: "", trim: true },
    lastName: { type: String, default: "", trim: true },
    /** Driver profile image (MVP: URL or small data URL). */
    avatarUrl: { type: String, default: "" },
    vehicle: { type: vehicleSchema, default: () => ({}) },
  },
  { timestamps: true }
);

export const User = mongoose.model("User", userSchema);
