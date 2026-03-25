const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  name: "TNC Rider",
  slug: "tnc-rider",
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
    config: {
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    },
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
    config: {
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_API_KEY || "",
      },
    },
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-font",
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "We use your location to set pickup and show the driver approaching.",
      },
    ],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL || "http://10.0.0.135:3000",
    googleGeocodingApiKey: process.env.EXPO_PUBLIC_GOOGLE_GEOCODING_API_KEY || "",
  },
};
