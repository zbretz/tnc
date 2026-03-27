/** Google Maps / Directions / Distance Matrix server keys (shared across routes). */
export function directionsApiKey() {
  return (
    process.env.GOOGLE_DIRECTIONS_API_KEY ||
    process.env.GOOGLE_DISTANCE_MATRIX_API_KEY ||
    process.env.GOOGLE_MAPS_SERVER_API_KEY ||
    ""
  );
}
