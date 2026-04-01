const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

/** Non-empty only — Expo `withMaps` skips `react-native-google-maps` when this is missing/falsy (empty string counts as “no Google Maps”). */
const googleMapsApiKey =
  typeof process.env.GOOGLE_MAPS_API_KEY === "string" && process.env.GOOGLE_MAPS_API_KEY.trim().length > 0
    ? process.env.GOOGLE_MAPS_API_KEY.trim()
    : undefined;

const stripePublishableKey =
  typeof process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY === "string"
    ? process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY.trim()
    : "";

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  name: "TNC Rider",
  slug: "tnc-rider",
  scheme: "tnc-rider",
  version: "1.0.0",
  /** Reanimated 4 / bottom-sheet require the new architecture in custom dev builds; Expo Go already matches SDK 54. */
  newArchEnabled: true,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },
  ios: {
    bundleIdentifier: "com.tnc.rider",
    supportsTablet: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        "We use your location to set pickup and show the driver approaching.",
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
    },
    ...(googleMapsApiKey ? { config: { googleMapsApiKey } } : {}),
  },
  android: {
    package: "com.tnc.rider",
    /** Lets the window resize when the keyboard opens so the bottom sheet can stay visible. */
    softwareKeyboardLayoutMode: "resize",
    usesCleartextTraffic: true,
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION"],
    ...(googleMapsApiKey ? { config: { googleMaps: { apiKey: googleMapsApiKey } } } : {}),
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-font",
    [
      "@stripe/stripe-react-native",
      {
        merchantIdentifier: "",
        enableGooglePay: false,
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "We use your location to set pickup and show the driver approaching.",
      },
    ],
    /** After Expo `withMaps` — fixes GMSServices init order for the new AppDelegate template. */
    "./plugins/withGoogleMapsEarlyInitAppDelegate",
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL || "http://10.0.0.135:3000",
    googleGeocodingApiKey: process.env.EXPO_PUBLIC_GOOGLE_GEOCODING_API_KEY || "",
    stripePublishableKey,
  },
};
