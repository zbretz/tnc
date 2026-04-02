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
  /** Google Navigation SDK does not support RN New Architecture yet (see package README). */
  newArchEnabled: false,
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
      NSPhotoLibraryUsageDescription: "Choose a photo for your driver profile picture.",
      NSCameraUsageDescription: "Take a photo for your driver profile picture.",
      NSLocationWhenInUseUsageDescription:
        "We share your location with the rider after you accept a trip.",
      /**
       * Google Navigation SDK updates the road-snapped location client when guidance starts.
       * Without `location` in UIBackgroundModes, Core Location can assert:
       * `!stayUp || CLClientIsBackgroundable(...)`.
       */
      NSLocationAlwaysAndWhenInUseUsageDescription:
        "Turn-by-turn navigation may need location access when the app is in the background so routing can continue.",
      UIBackgroundModes: ["location"],
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
      LSApplicationQueriesSchemes: ["comgooglemaps", "googlechromes"],
      /** Read in AppDelegate for GMSServices.provideAPIKey (react-native-maps + Navigation). */
      ...(googleMapsApiKey ? { GMSApiKey: googleMapsApiKey } : {}),
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
      "expo-build-properties",
      {
        android: { minSdkVersion: 24 },
        ios: { deploymentTarget: "16.0" },
      },
    ],
    "./plugins/withGoogleNavigationAndroid.js",
    "./plugins/withIosSwiftLinkerFix.js",
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "We share your location with the rider after you accept a trip.",
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "Choose a photo for your driver profile picture.",
        cameraPermission: "Take a photo for your driver profile picture.",
      },
    ],
    [
      "expo-notifications",
      {
        sounds: [],
        enableBackgroundRemoteNotifications: false,
      },
    ],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL || "http://10.0.0.135:3000",
    ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID_DRIVER?.trim()
      ? { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID_DRIVER.trim() } }
      : process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim()
        ? { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID.trim() } }
        : {}),
  },
};
