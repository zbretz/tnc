import "react-native-gesture-handler";
import { registerRootComponent } from "expo";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  NavigationProvider,
  TaskRemovedBehavior,
} from "@googlemaps/react-native-navigation-sdk";
import App from "./App";

function Root() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationProvider
        termsAndConditionsDialogOptions={{
          title: "Google Maps Navigation",
          companyName: "TNC",
          showOnlyDisclaimer: false,
        }}
        taskRemovedBehavior={TaskRemovedBehavior.CONTINUE_SERVICE}
      >
        <App />
      </NavigationProvider>
    </GestureHandlerRootView>
  );
}

registerRootComponent(Root);
