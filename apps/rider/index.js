import "react-native-gesture-handler";
import { registerRootComponent } from "expo";
import { useEffect, useState } from "react";
import { ParkCityRidesLaunchScreen } from "./components/ParkCityRidesLaunchScreen";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StripeProvider } from "@stripe/stripe-react-native";
import { getStripePublishableKey } from "./lib/config";

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

  const stripePk = getStripePublishableKey();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {AppComponent ? (
        <StripeProvider publishableKey={stripePk} urlScheme="tnc-rider">
          <AppComponent />
        </StripeProvider>
      ) : (
        <ParkCityRidesLaunchScreen />
      )}
    </GestureHandlerRootView>
  );
}

registerRootComponent(Root);
