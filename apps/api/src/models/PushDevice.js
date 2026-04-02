import mongoose from "mongoose";

const pushDeviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Which client binary registered this token (`rider` | `driver`). */
    app: { type: String, enum: ["rider", "driver"], required: true, index: true },
    expoPushToken: { type: String, required: true, trim: true },
    platform: { type: String, enum: ["ios", "android", "web"], default: "ios" },
  },
  { timestamps: true }
);

pushDeviceSchema.index({ userId: 1, app: 1, expoPushToken: 1 }, { unique: true });

export const PushDevice = mongoose.model("PushDevice", pushDeviceSchema);
