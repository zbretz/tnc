import mongoose from "mongoose";

const vehicleSchema = new mongoose.Schema(
  {
    make: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    year: { type: Number },
    color: { type: String, default: "", trim: true },
    licensePlate: { type: String, default: "", trim: true },
    /** Vehicle photo (MVP: HTTPS or data URL; move to object storage later). */
    photoUrl: { type: String, default: "" },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    /** Legacy email/password auth; optional when using phone OTP. */
    email: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    passwordHash: { type: String },
    /** Legacy display name; kept for riders and migration. */
    name: { type: String, trim: true, default: "" },
    /** Legacy single role; kept in sync with `roles` for JWT + old clients. */
    role: { type: String, enum: ["rider", "driver"] },
    roles: {
      type: [{ type: String, enum: ["rider", "driver", "admin"] }],
      default: undefined,
    },
    accountStatus: { type: String, enum: ["active", "suspended"], default: "active", index: true },

    /** E.164 normalized phone; unique for OTP login. */
    phoneE164: { type: String, trim: true, sparse: true, unique: true },
    phoneVerifiedAt: { type: Date },
    /** Legacy free-form phone string (admin display on trip cards). */
    phone: { type: String, default: "", trim: true },

    /** Driver-facing legal / account name split (rider sees last initial only). */
    firstName: { type: String, default: "", trim: true },
    lastName: { type: String, default: "", trim: true },
    /** Driver profile image (MVP: URL or small data URL). */
    avatarUrl: { type: String, default: "" },
    /** Legacy embedded vehicle; prefer DriverProfile.vehicle when present. */
    vehicle: { type: vehicleSchema, default: () => ({}) },
    /** Primary ops driver (seed: driver1@tnc.local). Can toggle rider availability and see rider phones on requests. */
    isAdmin: { type: Boolean, default: false },

    /** Stripe Customer for riders (saved cards). */
    stripeCustomerId: { type: String, trim: true, default: "", sparse: true },
    /** Default PaymentMethod id (pm_...) for charges. */
    stripeDefaultPaymentMethodId: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

userSchema.pre("validate", function syncRoles(next) {
  if (Array.isArray(this.roles) && this.roles.length > 0) {
    if (!this.role || !this.roles.includes(this.role)) {
      const first = this.roles.find((x) => x === "rider" || x === "driver");
      this.role = first || this.roles[0];
    }
  } else if (this.role) {
    this.roles = [this.role];
  }
  next();
});

export const User = mongoose.model("User", userSchema);

/** Normalize roles for JWT and checks (legacy docs may only have `role`). */
export function rolesFromUserDoc(user) {
  if (!user) return ["rider"];
  if (Array.isArray(user.roles) && user.roles.length > 0) return user.roles;
  if (user.role) return [user.role];
  return ["rider"];
}
