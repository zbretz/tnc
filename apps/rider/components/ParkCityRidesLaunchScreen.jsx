import { StyleSheet, Text, View } from "react-native";
import LottieView from "lottie-react-native";

export function ParkCityRidesLaunchScreen() {
  return (
    <View
      style={styles.root}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading Park City Rides"
    >
      <Text style={styles.title}>Park City Rides</Text>
      <LottieView
        source={require("../assets/loading-cube.json")}
        autoPlay
        loop
        style={styles.lottie}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: "#0f172a",
    letterSpacing: -0.5,
    marginBottom: 28,
    textAlign: "center",
  },
  lottie: {
    width: 200,
    height: 200,
  },
});
