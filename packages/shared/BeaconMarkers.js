import { StyleSheet, Text, View } from "react-native";
import { Marker } from "react-native-maps";

const PICKUP = "#16a34a";
const DROPOFF = "#7c3aed";

const pickupS = StyleSheet.create({
  wrap: { alignItems: "center" },
  head: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: PICKUP,
    borderWidth: 3,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.28,
    shadowRadius: 3,
    elevation: 5,
  },
  letter: { color: "#fff", fontSize: 15, fontWeight: "900" },
  point: {
    width: 0,
    height: 0,
    marginTop: -4,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderTopWidth: 15,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: PICKUP,
  },
});

const dropoffS = StyleSheet.create({
  wrap: { alignItems: "center" },
  head: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: DROPOFF,
    borderWidth: 3,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.28,
    shadowRadius: 3,
    elevation: 5,
  },
  letter: { color: "#fff", fontSize: 15, fontWeight: "900" },
  point: {
    width: 0,
    height: 0,
    marginTop: -4,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderTopWidth: 15,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: DROPOFF,
  },
});

/**
 * Map pin with a round head and downward point; anchor is the tip for precise placement.
 */
export function PickupBeaconMarker({ coordinate, title = "Pickup", ...markerProps }) {
  return (
    <Marker
      coordinate={coordinate}
      title={title}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={false}
      {...markerProps}
    >
      <View style={pickupS.wrap} collapsable={false}>
        <View style={pickupS.head}>
          <Text style={pickupS.letter} allowFontScaling={false}>
            P
          </Text>
        </View>
        <View style={pickupS.point} />
      </View>
    </Marker>
  );
}

export function DropoffBeaconMarker({ coordinate, title = "Dropoff", ...markerProps }) {
  return (
    <Marker
      coordinate={coordinate}
      title={title}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={false}
      {...markerProps}
    >
      <View style={dropoffS.wrap} collapsable={false}>
        <View style={dropoffS.head}>
          <Text style={dropoffS.letter} allowFontScaling={false}>
            D
          </Text>
        </View>
        <View style={dropoffS.point} />
      </View>
    </Marker>
  );
}
