import mongoose from "mongoose";

const vehicleSchema = new mongoose.Schema(
  {
    make: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    year: { type: Number },
    color: { type: String, default: "", trim: true },
    licensePlate: { type: String, default: "", trim: true },
    photoUrl: { type: String, default: "" },
  },
  { _id: false }
);

const licenseSchema = new mongoose.Schema(
  {
    number: { type: String, default: "", trim: true },
    /** US state / territory issuing the license (2-letter, e.g. UT). */
    state: { type: String, default: "UT", trim: true, uppercase: true },
    expiry: { type: Date },
  },
  { _id: false }
);

const driverProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    driverStatus: {
      type: String,
      enum: ["pending", "active", "suspended", "banned"],
      default: "pending",
      index: true,
    },
    vehicle: { type: vehicleSchema, default: () => ({}) },
    license: { type: licenseSchema, default: () => ({}) },
    avatarUrl: { type: String, default: "" },
    /**
     * GeoJSON Point — only set when coordinates exist ([lng, lat]).
     * Do not default `type: "Point"` without coordinates (breaks 2dsphere index).
     */
    currentLocation: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] },
    },
    locationUpdatedAt: { type: Date },
    /**
     * When true, driver receives push for new open ride requests (and is "on duty" for notifications).
     * Does not affect trip-in-progress alerts.
     */
    availableForRequests: { type: Boolean, default: false },
  },
  { timestamps: true }
);

driverProfileSchema.pre("validate", function stripInvalidPoint(next) {
  const cl = this.currentLocation;
  if (!cl || typeof cl !== "object") return next();
  if (!Array.isArray(cl.coordinates) || cl.coordinates.length !== 2 || cl.type !== "Point") {
    this.set("currentLocation", undefined);
    this.set("locationUpdatedAt", undefined);
  }
  next();
});

driverProfileSchema.index({ currentLocation: "2dsphere" });

export const DriverProfile = mongoose.model("DriverProfile", driverProfileSchema);
