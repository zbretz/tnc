import mongoose from "mongoose";

const latLngSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false }
);

const drivingEtaLegSchema = new mongoose.Schema(
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

/** Google Directions snapshot: driver → pickup (at accept) or pickup → dropoff (at in_progress). */
const routedSegmentSchema = new mongoose.Schema(
  {
    computedAt: { type: Date },
    provider: { type: String, default: "google_directions" },
    origin: {
      lat: Number,
      lng: Number,
      accuracyM: Number,
      recordedAt: Date,
    },
    destination: {
      lat: Number,
      lng: Number,
    },
    distanceM: Number,
    durationSec: Number,
    encodedPolyline: String,
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
      enum: ["requested", "accepted", "in_progress", "awaiting_rider_checkout", "completed", "cancelled"],
      default: "requested",
    },
    driverLocation: {
      lat: Number,
      lng: Number,
      updatedAt: Date,
    },
    /** Server-computed driving ETA driver → pickup while accepted */
    etaToPickup: { type: drivingEtaLegSchema, default: null },
    /** Server-computed driving ETA driver → dropoff while in_progress */
    etaToDropoff: { type: drivingEtaLegSchema, default: null },
    /** Snapshot from computeFareEstimate at trip creation when dropoff is set */
    fareEstimate: { type: fareEstimateSchema, default: null },

    /** Routed driving path: driver at accept → pickup pin (snapshot). */
    deadheadRoute: { type: routedSegmentSchema, default: null },
    /** Routed driving path: pickup pin → dropoff pin (snapshot at in_progress). */
    rideRoute: { type: routedSegmentSchema, default: null },

    /** Rider-set tip in cents (integer >= 0). Applied in one PaymentIntent with fare at driver complete. */
    riderTipAmountCents: { type: Number, default: null },

    /** Set when the driver completes the trip (Stripe off-session charge when configured). */
    fareChargeStatus: {
      type: String,
      enum: [
        "none",
        "waived",
        "succeeded",
        "failed",
        "requires_action",
        "skipped_stripe_disabled",
        "skipped_no_estimate",
        "skipped_no_payment_method",
        "skipped_below_minimum",
      ],
      default: "none",
    },
    fareChargeAmountCents: { type: Number, default: null },
    /** Fare portion of the charge (cents), before tip. */
    fareChargeFareCents: { type: Number, default: null },
    /** Tip portion included in fareChargeAmountCents. */
    fareChargeTipCents: { type: Number, default: null },
    fareChargeCurrency: { type: String, default: "" },
    stripePaymentIntentId: { type: String, default: "" },
    fareChargeError: { type: String, default: "" },
  },
  { timestamps: true }
);

export const Trip = mongoose.model("Trip", tripSchema);
