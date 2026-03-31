import Constants from "expo-constants";

const DEV_FALLBACK = "http://10.0.0.135:3000";

function extraPayload() {
  return (
    Constants.expoConfig?.extra ??
    Constants.manifest?.extra ??
    (typeof Constants.manifest2 === "object" && Constants.manifest2?.extra) ??
    null
  );
}

export function getApiUrl() {
  const fromEnv =
    typeof process.env.EXPO_PUBLIC_API_URL === "string" && process.env.EXPO_PUBLIC_API_URL.trim().length > 0
      ? process.env.EXPO_PUBLIC_API_URL.trim()
      : null;
  const fromExtra = extraPayload()?.apiUrl;
  const url =
    fromEnv ||
    (typeof fromExtra === "string" && fromExtra.length > 0 ? fromExtra : null);
  return url || DEV_FALLBACK;
}

export function getGoogleGeocodingApiKey() {
  const key = Constants.expoConfig?.extra?.googleGeocodingApiKey;
  return typeof key === "string" && key.length > 0 ? key : "";
}

/** Same key as geocoding; enable "Places API" + billing for autocomplete & place details. */
export function getGooglePlacesApiKey() {
  return getGoogleGeocodingApiKey();
}

/** Stripe publishable key (`pk_test_…` / `pk_live_…`); set `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` in `.env`. */
export function getStripePublishableKey() {
  const key = Constants.expoConfig?.extra?.stripePublishableKey;
  return typeof key === "string" && key.length > 0 ? key : "";
}
