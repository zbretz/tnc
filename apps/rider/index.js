import "react-native-gesture-handler";
import { registerRootComponent } from "expo";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

/**
 * Do not import react-native-reanimated here. If it throws during the entry module load, React Native
 * never runs registerRootComponent → "main" has not been registered. Reanimated loads from App.jsx
 * (first import) after this shell mounts.
 */
function Root() {
  const [AppComponent, setAppComponent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      import("./App")
        .then((m) => {
          if (!cancelled) setAppComponent(() => m.default);
        })
        .catch((err) => {
          console.error(err);
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {AppComponent ? (
        <AppComponent />
      ) : (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#fff" }}>
          <ActivityIndicator size="large" color="#2563eb" />
        </View>
      )}
    </GestureHandlerRootView>
  );
}

registerRootComponent(Root);
