import Constants from "expo-constants";

export function getApiUrl() {
  const url = Constants.expoConfig?.extra?.apiUrl;
  return typeof url === "string" && url.length > 0 ? url : "http://10.0.0.135:3000";
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
