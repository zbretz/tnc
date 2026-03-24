import mongoose from "mongoose";

const latLngSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false }
);

const etaToPickupSchema = new mongoose.Schema(
  {
    durationSeconds: Number,
    durationText: String,
    distanceMeters: Number,
    distanceText: String,
    summaryMinutes: Number,
    usesTraffic: Boolean,
    computedAt: Date,
  },
  { _id: false }
);

const fareEstimateSchema = new mongoose.Schema(
  {
    currency: { type: String, default: "USD" },
    total: Number,
    breakdown: mongoose.Schema.Types.Mixed,
    computedAt: Date,
  },
  { _id: false }
);

const tripSchema = new mongoose.Schema(
  {
    rider: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    pickup: { type: latLngSchema, required: true },
    pickupAddress: { type: String, default: null },
    dropoff: { type: latLngSchema, default: null },
    dropoffAddress: { type: String, default: null },
    preferredPickupAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["requested", "accepted", "in_progress", "completed", "cancelled"],
      default: "requested",
    },
    driverLocation: {
      lat: Number,
      lng: Number,
      updatedAt: Date,
    },
    /** Server-computed driving ETA to pickup (Distance Matrix); pushed via trip:updated */
    etaToPickup: { type: etaToPickupSchema, default: null },
    /** Snapshot from computeFareEstimate at trip creation when dropoff is set */
    fareEstimate: { type: fareEstimateSchema, default: null },
  },
  { timestamps: true }
);

export const Trip = mongoose.model("Trip", tripSchema);
