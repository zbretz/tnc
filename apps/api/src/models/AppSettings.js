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
    /**
     * 50–150: percentage of the calculated fare to quote (100 = baseline).
     * Applied after the usual minimum-fare rollup; final quote is not re-floored.
     */
    fareAdjustmentPercent: { type: Number, default: 100, min: 50, max: 150 },
    /** @deprecated Use fareAdjustmentPercent (100 − oldDiscount). Kept for DB migration reads. */
    fareDiscountPercent: { type: Number },
    /** When true, quoted fares are $0 (multiplier ignored). */
    fareFreeEnabled: { type: Boolean, default: false },
    /** Shown in rider app “Why?” modal; empty string uses default copy. */
    fareFreeRiderExplanation: { type: String, default: "" },
  },
  { timestamps: true }
);

export const DEFAULT_FARE_FREE_RIDER_EXPLANATION =
  "We're not charging fares while we test our new app and operations with local neighbors. Riding free helps us learn before we launch fully — thank you for being part of it.";

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
        fareAdjustmentPercent: 100,
        fareFreeEnabled: false,
        fareFreeRiderExplanation: "",
      },
    },
    { upsert: true }
  ).exec();
}

function storedFareFreeExplanation(doc) {
  const t = typeof doc?.fareFreeRiderExplanation === "string" ? doc.fareFreeRiderExplanation.trim() : "";
  return t.slice(0, 800);
}

export function fareFreeExplanationResolved(doc) {
  const s = storedFareFreeExplanation(doc);
  return s.length > 0 ? s : DEFAULT_FARE_FREE_RIDER_EXPLANATION;
}

/** Legacy 0–100 = % off. */
export function normalizeFareDiscountPercent(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** 50–150 = % of calculated fare (100 = no change). */
export function normalizeFareAdjustmentPercent(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.min(150, Math.max(50, Math.round(n)));
}

export function resolveFareAdjustmentPercentFromDoc(doc) {
  if (doc == null) return 100;
  const adjRaw = doc.fareAdjustmentPercent;
  if (adjRaw != null && Number.isFinite(Number(adjRaw))) {
    return normalizeFareAdjustmentPercent(adjRaw);
  }
  const legacyOff = doc.fareDiscountPercent;
  if (legacyOff != null && Number.isFinite(Number(legacyOff))) {
    const off = normalizeFareDiscountPercent(legacyOff);
    return normalizeFareAdjustmentPercent(100 - off);
  }
  return 100;
}

export async function getFareQuoteModifiers() {
  await ensureAppSettings();
  const doc = await AppSettings.findOne({ key: SINGLETON_KEY })
    .select("fareFreeEnabled fareAdjustmentPercent fareDiscountPercent")
    .lean()
    .exec();
  return {
    fareFreeEnabled: doc?.fareFreeEnabled === true,
    fareAdjustmentPercent: resolveFareAdjustmentPercentFromDoc(doc),
  };
}

export async function getFareAdjustmentPercent() {
  const m = await getFareQuoteModifiers();
  return m.fareAdjustmentPercent;
}

export async function getRiderServiceConfig() {
  await ensureAppSettings();
  const doc = await AppSettings.findOne({ key: SINGLETON_KEY }).lean().exec();
  const storedFree = storedFareFreeExplanation(doc);
  return {
    driversAvailable: doc?.riderDriversAvailable !== false,
    closedMessage:
      typeof doc?.riderClosedMessage === "string" && doc.riderClosedMessage.trim()
        ? doc.riderClosedMessage.trim()
        : "No drivers are available right now. Please check back soon.",
    fareAdjustmentPercent: resolveFareAdjustmentPercentFromDoc(doc),
    fareFreeEnabled: doc?.fareFreeEnabled === true,
    fareFreeRiderExplanation: fareFreeExplanationResolved(doc),
    fareFreeRiderExplanationStored: storedFree,
  };
}

/** Subset safe for riders (public HTTP + Socket.io); omits admin-only fields. */
export function riderFacingRiderServicePayload(cfg) {
  if (!cfg || typeof cfg !== "object") {
    return {
      driversAvailable: true,
      closedMessage: "",
      fareFreeEnabled: false,
      fareFreeRiderExplanation: "",
    };
  }
  return {
    driversAvailable: cfg.driversAvailable !== false,
    closedMessage: typeof cfg.closedMessage === "string" ? cfg.closedMessage : "",
    fareFreeEnabled: cfg.fareFreeEnabled === true,
    fareFreeRiderExplanation:
      typeof cfg.fareFreeRiderExplanation === "string" ? cfg.fareFreeRiderExplanation : "",
  };
}
