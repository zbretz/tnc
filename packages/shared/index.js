export { DropoffBeaconMarker, PickupBeaconMarker } from "./BeaconMarkers.js";

/** Shared string constants for trips and roles (optional import from apps). */
export const TRIP_STATUSES = Object.freeze([
  "requested",
  "accepted",
  "in_progress",
  "completed",
  "cancelled",
]);

export const USER_ROLES = Object.freeze(["rider", "driver"]);

/**
 * Plus Jakarta Sans (via @expo-google-fonts/plus-jakarta-sans in each Expo app).
 * Uber uses proprietary Uber Move; this is a close, contemporary geometric sans.
 */
export const FONT_FAMILY = Object.freeze({
  plusJakartaRegular: "PlusJakartaSans_400Regular",
  plusJakartaMedium: "PlusJakartaSans_500Medium",
  plusJakartaSemiBold: "PlusJakartaSans_600SemiBold",
  plusJakartaBold: "PlusJakartaSans_700Bold",
  plusJakartaExtraBold: "PlusJakartaSans_800ExtraBold",
});
