/**
 * Service-area anchor points for “far from hub” fare adjustments.
 * Override with env TNC_PRICING_ANCHORS as JSON:
 * [{"id":"kimball","name":"Kimball","lat":40.72,"lng":-111.54},...]
 */
export const DEFAULT_PRICING_ANCHORS = [
  { id: "kimball", name: "Kimball", lat: 40.724493, lng: -111.544709 },
  { id: "white_barn", name: "White Barn", lat: 40.678531, lng: -111.52671 },
  { id: "old_town", name: "Old Town", lat: 40.656535, lng: -111.506565 },
];

export function loadPricingAnchors() {
  const raw = process.env.TNC_PRICING_ANCHORS;
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_PRICING_ANCHORS;
      const out = arr
        .map((a, i) => {
          const lat = Number(a?.lat);
          const lng = Number(a?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          const id = typeof a?.id === "string" && a.id.trim() ? a.id.trim() : `anchor_${i}`;
          const name = typeof a?.name === "string" && a.name.trim() ? a.name.trim() : id;
          return { id, name, lat, lng };
        })
        .filter(Boolean);
      return out.length > 0 ? out : DEFAULT_PRICING_ANCHORS;
    } catch {
      return DEFAULT_PRICING_ANCHORS;
    }
  }
  return DEFAULT_PRICING_ANCHORS;
}
