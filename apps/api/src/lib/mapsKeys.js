/** Google Maps / Directions / Distance Matrix server keys (shared across routes). */

/**
 * Directions API (polylines). Prefers a dedicated Directions key when set.
 */
export function directionsApiKey() {
  return (
    process.env.GOOGLE_DIRECTIONS_API_KEY ||
    process.env.GOOGLE_DISTANCE_MATRIX_API_KEY ||
    process.env.GOOGLE_MAPS_SERVER_API_KEY ||
    ""
  ).trim();
}

/**
 * Distance Matrix API (fare + ETAs). Prefers explicit Matrix / server keys; falls back to
 * {@link directionsApiKey} so one GCP key with both APIs enabled still runs pricing.
 */
export function distanceMatrixApiKey() {
  return (
    process.env.GOOGLE_DISTANCE_MATRIX_API_KEY ||
    process.env.GOOGLE_MAPS_SERVER_API_KEY ||
    process.env.GOOGLE_DIRECTIONS_API_KEY ||
    ""
  ).trim();
}
