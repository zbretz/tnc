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
