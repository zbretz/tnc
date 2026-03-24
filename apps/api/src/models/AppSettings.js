import mongoose from "mongoose";

const appSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    /** When false, riders cannot create new trips (active trips are unaffected). */
    riderDriversAvailable: { type: Boolean, default: true },
    riderClosedMessage: {
      type: String,
      default: "No drivers are available right now. Please check back soon.",
    },
  },
  { timestamps: true }
);

export const AppSettings = mongoose.model("AppSettings", appSettingsSchema);

const SINGLETON_KEY = "singleton";

export async function ensureAppSettings() {
  await AppSettings.findOneAndUpdate(
    { key: SINGLETON_KEY },
    {
      $setOnInsert: {
        key: SINGLETON_KEY,
        riderDriversAvailable: true,
        riderClosedMessage: "No drivers are available right now. Please check back soon.",
      },
    },
    { upsert: true }
  ).exec();
}

export async function getRiderServiceConfig() {
  await ensureAppSettings();
  const doc = await AppSettings.findOne({ key: SINGLETON_KEY }).lean().exec();
  return {
    driversAvailable: doc?.riderDriversAvailable !== false,
    closedMessage:
      typeof doc?.riderClosedMessage === "string" && doc.riderClosedMessage.trim()
        ? doc.riderClosedMessage.trim()
        : "No drivers are available right now. Please check back soon.",
  };
}
