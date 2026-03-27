import mongoose from "mongoose";

const tripEventSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "Trip", required: true, index: true },
    type: { type: String, default: "trip.status_changed", index: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorRoles: [{ type: String }],
    fromStatus: { type: String },
    toStatus: { type: String, index: true },
    payload: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

tripEventSchema.index({ tripId: 1, createdAt: 1 });

export const TripEvent = mongoose.model("TripEvent", tripEventSchema);
