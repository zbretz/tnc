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
    /** Set when status becomes cancelled (for client messaging). */
    cancelledBy: { type: String, enum: ["rider", "driver", "admin"] },
    /** When driver ends ride; auto-finalize job runs at this time if rider has not confirmed. */
    awaitingRiderCheckoutDeadlineAt: { type: Date, default: null },
    driverLocation: {
      lat: Number,
      lng: Number,
      updatedAt: Date,
    },
    /**
     * When the assigned driver is considered en route to pickup (not tied to accept time).
     * Set by POST /trips/:id/driver-en-route or first PATCH driver-location while accepted.
     */
    driverEnRouteToPickupAt: { type: Date, default: null },
    /** Set when the assigned driver signals they are at the pickup pin (accepted leg only). Cleared when the ride starts. */
    driverArrivedAtPickupAt: { type: Date, default: null },
    /** When status became in_progress (ride started). Used for rider cancel fee policy. */
    rideInProgressAt: { type: Date, default: null },
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

    /** Rider cancel fee charge (off-session PI). Cancel always completes even if charge fails. */
    riderCancelChargeStatus: {
      type: String,
      enum: [
        "none",
        "waived",
        "succeeded",
        "failed",
        "requires_action",
        "skipped_stripe_disabled",
        "skipped_no_payment_method",
        "skipped_below_minimum",
      ],
      default: "none",
    },
    /** Policy fee (cents) and split snapshot at cancel time. */
    riderCancelFeeCents: { type: Number, default: null },
    riderCancelAppTakeCents: { type: Number, default: null },
    riderCancelDriverShareCents: { type: Number, default: null },
    riderCancelChargeCurrency: { type: String, default: "" },
    stripeCancelPaymentIntentId: { type: String, default: "" },
    riderCancelChargeError: { type: String, default: "" },
    riderCancelChargeComputedAt: { type: Date, default: null },

    /** Driver share of successful cancel fee (Connect transfer after rider charge succeeds). */
    riderCancelPayoutStatus: {
      type: String,
      enum: [
        "none",
        "waived",
        "skipped_no_driver",
        "skipped_no_charge",
        "pending_connect",
        "paid",
        "failed",
      ],
      default: "none",
    },
    riderCancelPayoutStripeFeeCents: { type: Number, default: null },
    riderCancelPayoutNetCents: { type: Number, default: null },
    riderCancelPayoutTransferId: { type: String, default: "" },
    riderCancelPayoutError: { type: String, default: "" },
    riderCancelPayoutComputedAt: { type: Date, default: null },

    /** Driver payout ledger (after successful rider charge). Tip 100% to driver; app take on fare only; full Stripe fee from driver side. */
    driverPayoutStatus: {
      type: String,
      enum: [
        "none",
        "waived",
        "skipped_no_driver",
        "skipped_no_charge",
        "pending_connect",
        "paid",
        "failed",
      ],
      default: "none",
    },
    driverPayoutAppTakeCents: { type: Number, default: null },
    driverPayoutStripeFeeCents: { type: Number, default: null },
    /** (fare − app take) + tip − stripe fee, floored at 0; amount sent via Connect transfer. */
    driverPayoutNetCents: { type: Number, default: null },
    driverPayoutTransferId: { type: String, default: "" },
    driverPayoutError: { type: String, default: "" },
    driverPayoutComputedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Trip = mongoose.model("Trip", tripSchema);
