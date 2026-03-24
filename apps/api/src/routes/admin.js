import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { requireDriverAdmin } from "../middleware/admin.js";
import { AppSettings, ensureAppSettings, getRiderServiceConfig } from "../models/AppSettings.js";

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
      const { driversAvailable, closedMessage } = req.body || {};
      const update = {};
      if (typeof driversAvailable === "boolean") {
        update.riderDriversAvailable = driversAvailable;
      }
      if (typeof closedMessage === "string") {
        update.riderClosedMessage = closedMessage.trim().slice(0, 500);
      }
      if (Object.keys(update).length === 0) {
        const cfg = await getRiderServiceConfig();
        res.json(cfg);
        return;
      }
      await AppSettings.updateOne({ key: SINGLETON_KEY }, { $set: update }).exec();
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
