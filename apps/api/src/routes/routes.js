import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { getDrivingRouteCoordinates } from "../googleDirections.js";
import { directionsApiKey } from "../lib/mapsKeys.js";

const r = Router();

/**
 * Authenticated driving route for map preview (decoded overview path).
 * Query: fromLat, fromLng, toLat, toLng
 */
r.get("/driving-preview", authMiddleware, async (req, res) => {
  const parse = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const fromLat = parse(req.query.fromLat);
  const fromLng = parse(req.query.fromLng);
  const toLat = parse(req.query.toLat);
  const toLng = parse(req.query.toLng);
  if (fromLat == null || fromLng == null || toLat == null || toLng == null) {
    res.status(400).json({ error: "fromLat, fromLng, toLat, toLng required as numbers", coordinates: null });
    return;
  }

  const apiKey = directionsApiKey();
  if (!apiKey) {
    res.json({ coordinates: null, error: "missing_key" });
    return;
  }

  const result = await getDrivingRouteCoordinates(
    { lat: fromLat, lng: fromLng },
    { lat: toLat, lng: toLng },
    apiKey
  );

  if (!result.ok) {
    res.json({ coordinates: null, error: result.error });
    return;
  }
  res.json({ coordinates: result.coordinates });
});

export const routesRouter = r;
