/**
 * Google Navigation SDK (Android) needs Jetifier + core library desugaring.
 * @see https://github.com/googlemaps/react-native-navigation-sdk#android
 */
const { withGradleProperties, withAppBuildGradle } = require("expo/config-plugins");

function withGoogleNavigationAndroid(config) {
  config = withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    const ensure = (key, value) => {
      const i = props.findIndex((p) => p.type === "property" && p.key === key);
      if (i >= 0) props[i].value = value;
      else props.push({ type: "property", key, value });
    };
    ensure("android.enableJetifier", "true");
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") return cfg;
    let contents = cfg.modResults.contents;
    // Expo prebuild template may omit compileOptions; Navigation SDK needs desugaring.
    if (!contents.includes("coreLibraryDesugaringEnabled")) {
      contents = contents.replace(
        /android\s*\{\n/,
        `android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
        coreLibraryDesugaringEnabled true
    }
`
      );
    }
    if (!contents.includes("desugar_jdk_libs_nio")) {
      contents = contents.replace(
        /^dependencies\s*\{/m,
        `dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.0.4")`
      );
    }
    cfg.modResults.contents = contents;
    return cfg;
  });

  return config;
}

module.exports = withGoogleNavigationAndroid;
