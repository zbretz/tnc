import Constants from "expo-constants";

export function getApiUrl() {
  const url = Constants.expoConfig?.extra?.apiUrl;
  return typeof url === "string" && url.length > 0 ? url : "http://10.0.0.135:3000";
}
