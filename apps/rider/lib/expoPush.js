import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import Constants from "expo-constants";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function ensureTripNotificationChannel() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("trips", {
      name: "Trips",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
}

/**
 * Request permission (if needed), get Expo push token, POST /auth/me/push-token as `app: rider`.
 */
export async function registerExpoPushWithApi({ api, authToken }) {
  const app = "rider";
  await ensureTripNotificationChannel();
  const { status: existing } = await Notifications.getPermissionsAsync();
  let s = existing;
  if (existing !== "granted") {
    const r = await Notifications.requestPermissionsAsync();
    s = r.status;
  }
  if (s !== "granted") return { ok: false, reason: "denied" };
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId || typeof projectId !== "string") {
    console.warn("[tnc rider push] Set EXPO_PUBLIC_EAS_PROJECT_ID after `eas init` for this app.");
    return { ok: false, reason: "no_project_id" };
  }
  let expoToken;
  try {
    expoToken = await Notifications.getExpoPushTokenAsync({ projectId });
  } catch (e) {
    console.warn("[tnc rider push] getExpoPushTokenAsync", e?.message || e);
    return { ok: false, reason: "token_error" };
  }
  const tokenStr = expoToken?.data;
  if (!tokenStr) return { ok: false, reason: "no_token" };
  const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
  await api("/auth/me/push-token", {
    method: "POST",
    token: authToken,
    body: { expoPushToken: tokenStr, app, platform },
  });
  return { ok: true };
}
