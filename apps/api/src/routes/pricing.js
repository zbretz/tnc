import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
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
/** Same auth surface as GET /routes/driving-preview: any signed-in user may preview a fare. */
pricingRouter.post("/estimate", authMiddleware, async (req, res) => {
  console.info("[tnc:pricing] POST /estimate");
  const pickup = parseLatLng(req.body?.pickup);
  const dropoff = parseLatLng(req.body?.dropoff);
  if (!pickup || !dropoff) {
    res.status(400).json({ error: "pickup and dropoff { lat, lng } required" });
    return;
  }
  try {
    const out = await computeFareEstimate(pickup, dropoff);
    if (!out.ok) {
      const err = out.error || "estimate_unavailable";
      console.warn("[tnc:pricing] POST /estimate failed", err);
      res.status(503).json({
        error: err,
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
