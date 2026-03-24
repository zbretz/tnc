import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import LottieView from "lottie-react-native";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import { getApiUrl, getGoogleGeocodingApiKey } from "./lib/config";

const TOKEN_KEY = "tnc_token";

/** Padding so pins aren’t under the bottom overlay when framing both markers. */
const MAP_EDGE_PADDING = { top: 96, right: 40, bottom: 220, left: 40 };

function stripUndefined(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

async function api(path, opts = {}) {
  const { method = "GET", body, token } = opts;
  const base = getApiUrl().replace(/\/$/, "");
  const url = `${base}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload =
    body != null ? JSON.stringify(body && typeof body === "object" ? stripUndefined(body) : body) : undefined;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
    });
  } catch (e) {
    const msg = e?.message || "Network request failed";
    throw new Error(
      `${msg}\n\nAPI: ${url}\n\nPhone: use your Mac's LAN IP, e.g. EXPO_PUBLIC_API_URL=http://192.168.x.x:3000 npx expo start apps/rider --go\nAndroid emulator: http://10.0.2.2:3000\nEnsure npm run dev:api is running.`
    );
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    throw new Error(data.error || text || `HTTP ${res.status}`);
  }
  return data;
}

function formatAddress(parts) {
  if (!parts) return null;
  const line1 = [parts.name, parts.streetNumber, parts.street].filter(Boolean).join(" ").trim();
  const fallback = [parts.city || parts.subregion, parts.region].filter(Boolean).join(", ").trim();
  return line1 || fallback || null;
}

async function reverseGeocodeLabel(point) {
  if (!point) return null;
  const apiKey = getGoogleGeocodingApiKey();
  if (apiKey) {
    try {
      const lat = Number(point.lat);
      const lng = Number(point.lng);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      const data = await res.json();
      const first = data?.results?.[0];
      const comps = Array.isArray(first?.address_components) ? first.address_components : [];
      const streetNumber = comps.find((c) => c?.types?.includes("street_number"))?.long_name || "";
      const route = comps.find((c) => c?.types?.includes("route"))?.long_name || "";
      const shortStreet = [streetNumber, route].filter(Boolean).join(" ").trim();
      if (shortStreet) return shortStreet;
      const formatted = first?.formatted_address;
      if (typeof formatted === "string" && formatted.trim().length > 0) {
        return formatted.split(",")[0].trim();
      }
    } catch {
      /* fallback to expo geocoder */
    }
  }
  try {
    const out = await Location.reverseGeocodeAsync({
      latitude: point.lat,
      longitude: point.lng,
    });
    return formatAddress(out?.[0]) || null;
  } catch {
    return null;
  }
}

async function geocodeAddressToPoint(addressText) {
  const apiKey = getGoogleGeocodingApiKey();
  if (!apiKey) return null;
  try {
    const q = encodeURIComponent(addressText.trim());
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const data = await res.json();
    const first = data?.results?.[0];
    const loc = first?.geometry?.location;
    if (typeof loc?.lat !== "number" || typeof loc?.lng !== "number") return null;
    const comps = Array.isArray(first?.address_components) ? first.address_components : [];
    const streetNumber = comps.find((c) => c?.types?.includes("street_number"))?.long_name || "";
    const route = comps.find((c) => c?.types?.includes("route"))?.long_name || "";
    const shortStreet = [streetNumber, route].filter(Boolean).join(" ").trim();
    return {
      point: { lat: Number(loc.lat), lng: Number(loc.lng) },
      address: shortStreet || String(first?.formatted_address || "").split(",")[0].trim() || null,
    };
  } catch {
    return null;
  }
}

export default function App() {
  const [token, setToken] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickup, setPickup] = useState(null);
  /** Optional destination; sent with POST /trips when set. */
  const [dropoff, setDropoff] = useState(null);
  const [pickupAddressLabel, setPickupAddressLabel] = useState(null);
  const [dropoffAddressLabel, setDropoffAddressLabel] = useState(null);
  const [dropoffQuery, setDropoffQuery] = useState("");
  const [resolvingDropoff, setResolvingDropoff] = useState(false);
  const [enterDropoffAddress, setEnterDropoffAddress] = useState(false);
  /** Which pin map taps update before a trip is created. */
  const [pinMode, setPinMode] = useState("pickup");
  const [trip, setTrip] = useState(null);
  const [driverLive, setDriverLive] = useState(null);
  const socketRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem(TOKEN_KEY);
      setToken(t);
    })();
  }, []);

  const subscribeTripSocket = useCallback((tripId, authToken) => {
    socketRef.current?.disconnect();
    const s = io(getApiUrl(), {
      auth: { token: authToken },
      transports: ["websocket"],
    });
    socketRef.current = s;
    s.on("connect", () => {
      s.emit("trip:subscribe", { tripId });
    });
    s.on("trip:updated", (msg) => {
      if (msg?.trip) {
        if (msg.trip.status === "cancelled" || msg.trip.status === "completed") {
          setTrip(null);
          setDriverLive(null);
          return;
        }
        setTrip(msg.trip);
        if (msg.trip.driverLocation) {
          setDriverLive({
            lat: msg.trip.driverLocation.lat,
            lng: msg.trip.driverLocation.lng,
          });
        }
      }
    });
    s.on("driver:location", (msg) => {
      if (typeof msg?.lat === "number" && typeof msg?.lng === "number") {
        setDriverLive({ lat: msg.lat, lng: msg.lng });
      }
    });
    s.on("connect_error", () => {});
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (token && trip?._id) {
      subscribeTripSocket(trip._id, token);
    } else {
      socketRef.current?.disconnect();
      socketRef.current = null;
    }
  }, [token, trip?._id, subscribeTripSocket]);

  const login = async () => {
    setBusy(true);
    try {
      const { token: t } = await api("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      await AsyncStorage.setItem(TOKEN_KEY, t);
      setToken(t);
    } catch (e) {
      Alert.alert("Login failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    try {
      const { token: t } = await api("/auth/register", {
        method: "POST",
        body: { email, password, name: email.split("@")[0] || "Rider", role: "rider" },
      });
      await AsyncStorage.setItem(TOKEN_KEY, t);
      setToken(t);
    } catch (e) {
      Alert.alert("Register failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const animateMapToPoint = useCallback((c) => {
    mapRef.current?.animateToRegion(
      {
        latitude: c.lat,
        longitude: c.lng,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      },
      400
    );
  }, []);

  /** Logged-in planning screen: default pickup = device location, map centered (no trip). */
  const activeTripId = trip?._id;
  useEffect(() => {
    if (!token || activeTripId) return;
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled || status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        const c = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        setPickup(c);
        setPickupAddressLabel(null);
        setPinMode("pickup");
        requestAnimationFrame(() => {
          if (!cancelled) animateMapToPoint(c);
        });
      } catch {
        /* stay on default map region */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, activeTripId, animateMapToPoint]);

  const logout = async () => {
    await AsyncStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setTrip(null);
    setDriverLive(null);
    setPickup(null);
    setDropoff(null);
    setPickupAddressLabel(null);
    setDropoffAddressLabel(null);
    setDropoffQuery("");
    setEnterDropoffAddress(false);
    setPinMode("pickup");
    socketRef.current?.disconnect();
  };

  const centerOnMe = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Location", "Permission is required to center the map.");
      return;
    }
    const loc = await Location.getCurrentPositionAsync({});
    const c = { lat: loc.coords.latitude, lng: loc.coords.longitude };
    if (pinMode === "pickup") {
      setPickup(c);
      setPickupAddressLabel(null);
    } else if (!enterDropoffAddress) {
      setDropoff(c);
      setDropoffAddressLabel(null);
    }
    animateMapToPoint(c);
  };

  const requestRide = async () => {
    if (!token || !pickup || !dropoff) {
      Alert.alert("Trip setup", "Set both pickup and dropoff before requesting a ride.");
      return;
    }
    setBusy(true);
    try {
      const [pickupAddress, dropoffAddress] = await Promise.all([
        pickupAddressLabel || reverseGeocodeLabel(pickup),
        dropoff ? dropoffAddressLabel || reverseGeocodeLabel(dropoff) : Promise.resolve(null),
      ]);
      const body = {
        pickup: { lat: Number(pickup.lat), lng: Number(pickup.lng) },
        ...(pickupAddress ? { pickupAddress } : {}),
        ...(dropoff
          ? {
              dropoff: { lat: Number(dropoff.lat), lng: Number(dropoff.lng) },
              ...(dropoffAddress ? { dropoffAddress } : {}),
            }
          : {}),
      };
      const { trip: t } = await api("/trips", {
        method: "POST",
        token,
        body,
      });
      setTrip(t);
      setDriverLive(null);
    } catch (e) {
      Alert.alert("Request failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Testing: cancel the trip on the server and reset local trip state. */
  const clearRide = async () => {
    const t = trip;
    if (!t) return;
    if (["completed", "cancelled"].includes(t.status)) {
      setTrip(null);
      setDriverLive(null);
      return;
    }
    const tripId = [t._id, t.id].find((x) => x != null && String(x).length > 0);
    const idStr = tripId != null ? String(tripId) : "";
    if (!idStr || !token) {
      Alert.alert("Clear ride", "Missing trip id — try logging out and back in.");
      return;
    }
    setBusy(true);
    try {
      await api("/trips/cancel", { method: "POST", token, body: { tripId: idStr } });
      setTrip(null);
      setDriverLive(null);
    } catch (e) {
      Alert.alert("Clear ride failed", e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const displayPickup = trip?.pickup || pickup;
  const displayDropoff = trip?.dropoff || dropoff;
  const shownPickupAddress = trip?.pickupAddress || pickupAddressLabel;
  const shownDropoffAddress = trip?.dropoffAddress || dropoffAddressLabel;

  const setDropoffFromAddress = async () => {
    const q = dropoffQuery.trim();
    if (!q) {
      Alert.alert("Dropoff address", "Enter a dropoff address first.");
      return;
    }
    setResolvingDropoff(true);
    try {
      const out = await geocodeAddressToPoint(q);
      if (!out?.point) {
        Alert.alert("Dropoff address", "Could not find that address.");
        return;
      }
      setDropoff(out.point);
      setDropoffAddressLabel(out.address || q);
      setPinMode("dropoff");
      setEnterDropoffAddress(true);
      mapRef.current?.animateToRegion(
        {
          latitude: out.point.lat,
          longitude: out.point.lng,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        },
        450
      );
    } finally {
      setResolvingDropoff(false);
    }
  };

  useEffect(() => {
    if (trip || !pickup) return;
    let cancelled = false;
    (async () => {
      const label = await reverseGeocodeLabel(pickup);
      if (!cancelled) setPickupAddressLabel(label);
    })();
    return () => {
      cancelled = true;
    };
  }, [pickup?.lat, pickup?.lng, trip?._id]);

  useEffect(() => {
    if (trip || !dropoff || dropoffAddressLabel) return;
    let cancelled = false;
    (async () => {
      const label = await reverseGeocodeLabel(dropoff);
      if (!cancelled) setDropoffAddressLabel(label);
    })();
    return () => {
      cancelled = true;
    };
  }, [dropoff?.lat, dropoff?.lng, dropoffAddressLabel, trip?._id]);

  const region = useMemo(() => {
    const p = displayPickup || { lat: 37.78, lng: -122.4 };
    const d = displayDropoff;
    if (d && p) {
      const midLat = (p.lat + d.lat) / 2;
      const midLng = (p.lng + d.lng) / 2;
      const span = Math.max(Math.abs(p.lat - d.lat), Math.abs(p.lng - d.lng), 0.02) * 1.4;
      return {
        latitude: midLat,
        longitude: midLng,
        latitudeDelta: span,
        longitudeDelta: span,
      };
    }
    return {
      latitude: p.lat,
      longitude: p.lng,
      latitudeDelta: 0.08,
      longitudeDelta: 0.08,
    };
  }, [displayPickup, displayDropoff]);

  const driverCoord =
    driverLive ||
    (trip?.driverLocation
      ? { lat: trip.driverLocation.lat, lng: trip.driverLocation.lng }
      : null);

  /** Frame pickup + driver in the map when the trip is active and both positions exist. */
  useEffect(() => {
    if (!trip || !displayPickup) return;
    if (!["accepted", "in_progress"].includes(trip.status)) return;
    if (!driverCoord) return;

    const coords = [
      { latitude: displayPickup.lat, longitude: displayPickup.lng },
      { latitude: driverCoord.lat, longitude: driverCoord.lng },
    ];
    if (displayDropoff) {
      coords.push({ latitude: displayDropoff.lat, longitude: displayDropoff.lng });
    }

    const t = setTimeout(() => {
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: MAP_EDGE_PADDING,
        animated: true,
      });
    }, 320);

    return () => clearTimeout(t);
  }, [
    trip?.status,
    trip?._id,
    displayPickup?.lat,
    displayPickup?.lng,
    driverCoord?.lat,
    driverCoord?.lng,
    displayDropoff?.lat,
    displayDropoff?.lng,
  ]);

  if (!token) {
    return (
      <View style={styles.auth}>
        <StatusBar style="dark" />
        <Text style={styles.title}>TNC Rider</Text>
        <Text style={styles.apiHint} selectable>
          API: {getApiUrl()}
        </Text>
        <TextInput
          style={styles.input}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <Pressable style={styles.primaryBtn} onPress={login} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Log in</Text>}
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={register} disabled={busy}>
          <Text style={styles.secondaryBtnText}>Create rider account</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        initialRegion={region}
        onPress={(e) => {
          const { latitude, longitude } = e.nativeEvent.coordinate;
          const c = { lat: latitude, lng: longitude };
          if (pinMode === "pickup") {
            setPickup(c);
            setPickupAddressLabel(null);
          } else if (!enterDropoffAddress) {
            setDropoff(c);
            setDropoffAddressLabel(null);
          }
        }}
      >
        {displayPickup ? (
          <Marker
            coordinate={{ latitude: displayPickup.lat, longitude: displayPickup.lng }}
            title="Pickup"
            pinColor="dodgerblue"
          />
        ) : null}
        {displayDropoff ? (
          <Marker
            coordinate={{ latitude: displayDropoff.lat, longitude: displayDropoff.lng }}
            title="Dropoff"
            pinColor="purple"
          />
        ) : null}
        {driverCoord && trip && trip.status !== "requested" ? (
          <Marker
            coordinate={{ latitude: driverCoord.lat, longitude: driverCoord.lng }}
            title="Driver"
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={styles.driverCarMarker}>
              <MaterialIcons name="directions-car" size={26} color="#ffffff" />
            </View>
          </Marker>
        ) : null}
      </MapView>

      {trip?.status === "requested" ? (
        <View style={styles.waitingLayer} pointerEvents="box-none">
          <View style={styles.waitingCard} pointerEvents="auto">
            {Platform.OS === "web" ? (
              <ActivityIndicator size="large" color="#2563eb" style={styles.waitingSpinner} />
            ) : (
              <LottieView
                source={require("./assets/lottie/waiting.json")}
                autoPlay
                loop
                resizeMode="contain"
                style={styles.waitingLottie}
              />
            )}
            <Text style={styles.waitingTitle}>Finding a driver</Text>
            <Text style={styles.waitingSubtitle}>Hang tight — nearby drivers can accept your ride any moment.</Text>
          </View>
        </View>
      ) : null}

      <View style={styles.overlay}>
        <Text style={styles.banner}>
          {!trip
            ? `Pickup defaults to your location. Tap the map to move pins (blue = pickup, purple = dropoff). Dropoff is optional.`
            : trip.status === "requested"
              ? "Your request is live. You can still cancel below if plans change."
              : trip.status === "accepted" || trip.status === "in_progress"
                ? `Driver accepted — car icon is the driver.${
                    trip?.etaToPickup
                      ? `\nDriver ETA to pickup: ${trip.etaToPickup.durationText || `~${trip.etaToPickup.summaryMinutes} min`}${trip.etaToPickup.distanceText ? ` · ${trip.etaToPickup.distanceText}` : ""}${trip.etaToPickup.usesTraffic ? " (traffic)" : ""}`
                      : driverCoord
                        ? "\nDriver ETA to pickup: updating…"
                        : "\nWaiting for driver location…"
                  }`
                : `Trip: ${trip.status}`}
        </Text>
        {!trip ? (
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeBtn, pinMode === "pickup" && styles.modeBtnActive]}
              onPress={() => setPinMode("pickup")}
            >
              <Text style={[styles.modeBtnText, pinMode === "pickup" && styles.modeBtnTextActive]}>Pickup</Text>
            </Pressable>
            <Pressable
              style={[styles.modeBtn, pinMode === "dropoff" && !enterDropoffAddress && styles.modeBtnActive]}
              onPress={() => {
                setPinMode("dropoff");
                setEnterDropoffAddress(false);
              }}
            >
              <Text style={[styles.modeBtnText, pinMode === "dropoff" && !enterDropoffAddress && styles.modeBtnTextActive]}>
                Dropoff on map
              </Text>
            </Pressable>
            <Pressable
              style={[styles.modeBtn, pinMode === "dropoff" && enterDropoffAddress && styles.modeBtnActive]}
              onPress={() => {
                setPinMode("dropoff");
                setEnterDropoffAddress(true);
              }}
            >
              <Text style={[styles.modeBtnText, pinMode === "dropoff" && enterDropoffAddress && styles.modeBtnTextActive]}>
                Enter address
              </Text>
            </Pressable>
            {dropoff ? (
              <Pressable
                style={styles.modeBtn}
                onPress={() => {
                  setDropoff(null);
                  setDropoffAddressLabel(null);
                  setDropoffQuery("");
                  setEnterDropoffAddress(false);
                }}
              >
                <Text style={styles.modeBtnText}>Clear dropoff</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {!trip ? (
          <View style={styles.addrBox}>
            <Text style={styles.addrText}>Pickup: {shownPickupAddress || (displayPickup ? "Locating address..." : "Not set")}</Text>
            <Text style={styles.addrText}>Dropoff: {shownDropoffAddress || (displayDropoff ? "Locating address..." : "Not set")}</Text>
            {enterDropoffAddress ? (
              <>
                <TextInput
                  style={styles.addrInput}
                  placeholder="Type dropoff address"
                  value={dropoffQuery}
                  onChangeText={setDropoffQuery}
                  autoCapitalize="words"
                  returnKeyType="search"
                  onSubmitEditing={setDropoffFromAddress}
                />
                <Pressable
                  style={[styles.smallBtn, styles.primarySmall]}
                  onPress={setDropoffFromAddress}
                  disabled={busy || resolvingDropoff}
                >
                  <Text style={[styles.smallBtnText, styles.smallBtnTextOnPrimary]}>
                    {resolvingDropoff ? "Finding..." : "Set dropoff from address"}
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : (
          <View style={styles.addrBox}>
            <Text style={styles.addrText}>Pickup: {trip?.pickupAddress || "Not available"}</Text>
            <Text style={styles.addrText}>Dropoff: {trip?.dropoffAddress || "Not set"}</Text>
          </View>
        )}
        <View style={styles.row}>
          <Pressable style={styles.smallBtn} onPress={centerOnMe}>
            <Text style={styles.smallBtnText}>My location</Text>
          </Pressable>
          {(!trip || trip.status === "cancelled" || trip.status === "completed") && pickup && dropoff ? (
            <Pressable
              style={[styles.smallBtn, styles.primarySmall]}
              onPress={requestRide}
              disabled={busy}
            >
              <Text style={[styles.smallBtnText, styles.smallBtnTextOnPrimary]}>Request ride</Text>
            </Pressable>
          ) : null}
          {trip && trip.status !== "completed" && trip.status !== "cancelled" ? (
            <Pressable style={[styles.smallBtn, styles.warnBtn]} onPress={clearRide} disabled={busy}>
              <Text style={styles.warnBtnText}>Clear ride</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.smallBtn} onPress={logout}>
            <Text style={styles.smallBtnText}>Log out</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  waitingLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  waitingCard: {
    backgroundColor: "rgba(255,255,255,0.97)",
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 24,
    alignItems: "center",
    maxWidth: 340,
    width: "100%",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(226,232,240,0.9)",
  },
  waitingLottie: {
    width: 168,
    height: 168,
  },
  waitingSpinner: {
    marginVertical: 32,
  },
  waitingTitle: {
    fontSize: 19,
    fontWeight: "700",
    color: "#0f172a",
    marginTop: -8,
  },
  waitingSubtitle: {
    fontSize: 14,
    color: "#64748b",
    textAlign: "center",
    lineHeight: 20,
    marginTop: 8,
    marginBottom: 12,
  },
  driverCarMarker: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#059669",
    borderWidth: 3,
    borderColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.28,
    shadowRadius: 4,
    elevation: 5,
  },
  auth: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#f8fafc",
  },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  apiHint: { fontSize: 11, color: "#64748b", marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 14,
    backgroundColor: "#fff",
  },
  primaryBtn: {
    backgroundColor: "#2563eb",
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontWeight: "600" },
  secondaryBtn: { padding: 12, alignItems: "center" },
  secondaryBtnText: { color: "#2563eb", fontWeight: "600" },
  overlay: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 36,
    gap: 10,
  },
  banner: {
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 12,
    borderRadius: 12,
    fontSize: 15,
    overflow: "hidden",
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  addrBox: {
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 10,
    borderRadius: 10,
    gap: 8,
  },
  addrText: { color: "#334155", fontSize: 13 },
  addrInput: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    color: "#0f172a",
  },
  modeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  },
  modeBtn: {
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  modeBtnActive: {
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  modeBtnText: { fontWeight: "600", fontSize: 14, color: "#475569" },
  modeBtnTextActive: { color: "#1d4ed8" },
  smallBtn: {
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  primarySmall: { backgroundColor: "#2563eb" },
  smallBtnText: { fontWeight: "600", color: "#0f172a" },
  smallBtnTextOnPrimary: { color: "#fff" },
  warnBtn: { backgroundColor: "#f59e0b" },
  warnBtnText: { fontWeight: "600", color: "#fff" },
});
