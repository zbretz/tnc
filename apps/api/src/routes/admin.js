import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { requireDriverAdmin } from "../middleware/admin.js";
import {
  AppSettings,
  ensureAppSettings,
  getRiderServiceConfig,
  normalizeFareAdjustmentPercent,
  normalizeFareDiscountPercent,
} from "../models/AppSettings.js";

const SINGLETON_KEY = "singleton";

export function createAdminRouter(deps = {}) {
  const r = Router();

  r.get("/rider-service", authMiddleware, requireDriverAdmin, async (_req, res) => {
    try {
      const cfg = await getRiderServiceConfig();
      res.json(cfg);
    } catch (e) {
      console.error("GET /admin/rider-service", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  r.patch("/rider-service", authMiddleware, requireDriverAdmin, async (req, res) => {
    try {
      await ensureAppSettings();
      const {
        driversAvailable,
        closedMessage,
        fareAdjustmentPercent,
        fareDiscountPercent,
        fareFreeEnabled,
        fareFreeRiderExplanation,
      } = req.body || {};
      const set = {};
      const unset = {};
      if (typeof driversAvailable === "boolean") {
        set.riderDriversAvailable = driversAvailable;
      }
      if (typeof closedMessage === "string") {
        set.riderClosedMessage = closedMessage.trim().slice(0, 500);
      }
      if (typeof fareFreeEnabled === "boolean") {
        set.fareFreeEnabled = fareFreeEnabled;
      }
      if (typeof fareFreeRiderExplanation === "string") {
        set.fareFreeRiderExplanation = fareFreeRiderExplanation.trim().slice(0, 800);
      }
      if (fareAdjustmentPercent != null && fareAdjustmentPercent !== "") {
        set.fareAdjustmentPercent = normalizeFareAdjustmentPercent(fareAdjustmentPercent);
        unset.fareDiscountPercent = "";
      } else if (fareDiscountPercent != null && fareDiscountPercent !== "") {
        const off = normalizeFareDiscountPercent(fareDiscountPercent);
        set.fareAdjustmentPercent = normalizeFareAdjustmentPercent(100 - off);
        unset.fareDiscountPercent = "";
      }
      if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
        const cfg = await getRiderServiceConfig();
        res.json(cfg);
        return;
      }
      const mongoUpdate = {};
      if (Object.keys(set).length > 0) mongoUpdate.$set = set;
      if (Object.keys(unset).length > 0) mongoUpdate.$unset = unset;
      await AppSettings.updateOne({ key: SINGLETON_KEY }, mongoUpdate).exec();
      const cfg = await getRiderServiceConfig();
      deps.onRiderServiceUpdated?.(cfg);
      res.json(cfg);
    } catch (e) {
      console.error("PATCH /admin/rider-service", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  return r;
}
