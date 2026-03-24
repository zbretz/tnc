import { Router } from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { computeFareEstimate } from "../fareEstimate.js";

function parseLatLng(obj) {
  if (obj == null || typeof obj !== "object") return null;
  const lat = typeof obj.lat === "number" ? obj.lat : Number(obj.lat);
  const lng = typeof obj.lng === "number" ? obj.lng : Number(obj.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export const pricingRouter = Router();

/** Body: { pickup: { lat, lng }, dropoff: { lat, lng } } */
pricingRouter.post("/estimate", authMiddleware, requireRole("rider"), async (req, res) => {
  const pickup = parseLatLng(req.body?.pickup);
  const dropoff = parseLatLng(req.body?.dropoff);
  if (!pickup || !dropoff) {
    res.status(400).json({ error: "pickup and dropoff { lat, lng } required" });
    return;
  }
  try {
    const out = await computeFareEstimate(pickup, dropoff);
    if (!out.ok) {
      res.status(503).json({
        error: out.error || "estimate_unavailable",
        estimate: null,
      });
      return;
    }
    res.json({ estimate: out.estimate });
  } catch (e) {
    console.error("POST /pricing/estimate", e);
    res.status(500).json({ error: "Server error", estimate: null });
  }
});
