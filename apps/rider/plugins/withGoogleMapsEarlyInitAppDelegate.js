const { withAppDelegate } = require("@expo/config-plugins");

/**
 * Expo's `withMaps` injects `GMSServices.provideAPIKey` immediately before
 * `super.application(..., didFinishLaunchingWithOptions:)`. The current
 * AppDelegate template calls `startReactNative` before `super.application`,
 * so that injection runs too late and Google Maps can crash on launch.
 *
 * This plugin removes the late injected block and initializes Maps at the
 * start of `didFinishLaunching`, reading `GMSApiKey` from Info.plist (same as
 * `withGoogleMapsKey`).
 */
const EARLY_INIT = `    // Google Maps SDK (MapView PROVIDER_GOOGLE) — must run before startReactNative.
    #if canImport(GoogleMaps)
    if let key = Bundle.main.object(forInfoDictionaryKey: "GMSApiKey") as? String, !key.isEmpty {
      GMSServices.provideAPIKey(key)
    }
    #endif

`;

function stripLateMapsInit(contents) {
  return contents.replace(
    /\n\/\/ @generated begin react-native-maps-init[\s\S]*?\/\/ @generated end react-native-maps-init\n?/,
    "\n"
  );
}

function ensureEarlyInit(contents) {
  if (contents.includes('forInfoDictionaryKey: "GMSApiKey"')) {
    return contents;
  }
  return contents.replace(
    /(\) -> Bool \{\n)(    let delegate = ReactNativeDelegate\(\))/,
    `$1${EARLY_INIT}$2`
  );
}

module.exports = function withGoogleMapsEarlyInitAppDelegate(config) {
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") {
      return c;
    }
    let contents = c.modResults.contents;
    contents = stripLateMapsInit(contents);
    contents = ensureEarlyInit(contents);
    c.modResults.contents = contents;
    return c;
  });
};
