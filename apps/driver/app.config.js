const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const googleMapsApiKey =
  typeof process.env.GOOGLE_MAPS_API_KEY === "string" && process.env.GOOGLE_MAPS_API_KEY.trim().length > 0
    ? process.env.GOOGLE_MAPS_API_KEY.trim()
    : undefined;

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  name: "TNC Driver",
  slug: "tnc-driver",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },
  ios: {
    bundleIdentifier: "com.tnc.driver",
    supportsTablet: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        "We share your location with the rider after you accept a trip.",
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
      LSApplicationQueriesSchemes: ["comgooglemaps", "googlechromes"],
    },
    ...(googleMapsApiKey ? { config: { googleMapsApiKey } } : {}),
  },
  android: {
    package: "com.tnc.driver",
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
      "expo-location",
      {
        locationWhenInUsePermission:
          "We share your location with the rider after you accept a trip.",
      },
    ],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL || "http://10.0.0.135:3000",
  },
};
