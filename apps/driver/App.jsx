import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import { getApiUrl } from "./lib/config";

const TOKEN_KEY = "tnc_token_driver";

const MAP_EDGE_PADDING = { top: 96, right: 40, bottom: 200, left: 40 };

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
      `${msg}\n\nAPI: ${url}\n\nPhone: use your Mac's LAN IP, e.g. EXPO_PUBLIC_API_URL=http://192.168.x.x:3000 npx expo start apps/driver --go\nAndroid emulator: http://10.0.2.2:3000\nEnsure npm run dev:api is running.`
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

function compactAddress(value) {
  if (typeof value !== "string") return null;
  const out = value.trim();
  if (!out) return null;
  return out.split(",")[0].trim();
}

/** Android: `geo:` shows the system “Open with” maps chooser. iOS: no OS chooser — ActionSheet for Apple vs Google. */
function openMapsNavigation(lat, lng, label) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    Alert.alert("Navigation", "Invalid coordinates.");
    return;
  }
  const title = typeof label === "string" && label.trim() ? label.trim() : "Destination";

  const fail = () => Alert.alert("Navigation", "Could not open a maps app.");

  if (Platform.OS === "android") {
    const geo = `geo:0,0?q=${la},${lo}(${encodeURIComponent(title)})`;
    Linking.openURL(geo).catch(fail);
    return;
  }

  if (Platform.OS === "ios" && ActionSheetIOS?.showActionSheetWithOptions) {
    const apple = `http://maps.apple.com/?daddr=${la},${lo}&dirflg=d`;
    const googleApp = `comgooglemaps://?daddr=${la},${lo}&directionsmode=driving`;
    const googleWeb = `https://www.google.com/maps/dir/?api=1&destination=${la},${lo}`;

    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", "Apple Maps", "Google Maps"],
        cancelButtonIndex: 0,
      },
      (buttonIndex) => {
        if (buttonIndex === 1) {
          Linking.openURL(apple).catch(fail);
        } else if (buttonIndex === 2) {
          Linking.canOpenURL(googleApp)
            .then((ok) => Linking.openURL(ok ? googleApp : googleWeb))
            .catch(() => Linking.openURL(googleWeb).catch(fail));
        }
      }
    );
    return;
  }

  Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${la},${lo}`).catch(fail);
}

export default function App() {
  const [token, setToken] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState([]);
  const [activeTrip, setActiveTrip] = useState(null);
  const [previewTrip, setPreviewTrip] = useState(null);
  const [me, setMe] = useState(null);
  const socketRef = useRef(null);
  const watchRef = useRef(null);
  const mapRef = useRef(null);
  const formatPoint = useCallback((pt) => `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`, []);
  const pickupLabel = useCallback(
    (t) => compactAddress(t?.pickupAddress) || (t?.pickup ? formatPoint(t.pickup) : "Unknown"),
    [formatPoint]
  );
  const dropoffLabel = useCallback(
    (t) => compactAddress(t?.dropoffAddress) || (t?.dropoff ? formatPoint(t.dropoff) : null),
    [formatPoint]
  );

  const openNavigatePickupFor = useCallback(
    (t) => {
      if (!t?.pickup) return;
      openMapsNavigation(t.pickup.lat, t.pickup.lng, pickupLabel(t) || "Pickup");
    },
    [pickupLabel]
  );

  const openNavigateDropoffFor = useCallback(
    (t) => {
      if (t?.dropoff?.lat == null || t?.dropoff?.lng == null) return;
      openMapsNavigation(t.dropoff.lat, t.dropoff.lng, dropoffLabel(t) || "Dropoff");
    },
    [dropoffLabel]
  );

  const loadAvailable = useCallback(async (t) => {
    try {
      const { trips } = await api("/trips/available", { token: t });
      setAvailable(trips);
    } catch {
      setAvailable([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem(TOKEN_KEY);
      setToken(t);
    })();
  }, []);

  useEffect(() => {
    if (!token) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }
    const s = io(getApiUrl(), {
      auth: { token },
      transports: ["websocket"],
    });
    socketRef.current = s;
    const refresh = () => loadAvailable(token);
    s.on("connect", refresh);
    s.on("trips:refresh", refresh);
    s.on("trip:available", refresh);
    return () => {
      s.disconnect();
      if (socketRef.current === s) socketRef.current = null;
    };
  }, [token, loadAvailable]);

  /** Only depend on trip id so location watch is not torn down on every trip:updated. */
  const activeTripId = activeTrip?._id;

  useEffect(() => {
    if (!token || !activeTripId) {
      watchRef.current?.remove();
      watchRef.current = null;
      return;
    }
    const s = socketRef.current;
    if (!s) return;

    const tripId = activeTripId;
    const subscribe = () => s.emit("trip:subscribe", { tripId });
    if (s.connected) subscribe();
    else s.once("connect", subscribe);

    const onTripUpdated = (msg) => {
      if (!msg?.trip || String(msg.trip._id) !== String(tripId)) return;
      setActiveTrip((prev) => {
        const next = msg.trip;
        if (!prev || String(prev._id) !== String(next._id)) {
          return next;
        }
        const merged = { ...prev, ...next };
        if (
          prev.dropoff?.lat != null &&
          (next.dropoff == null || next.dropoff?.lat == null)
        ) {
          merged.dropoff = prev.dropoff;
        }
        return merged;
      });
    };
    s.on("trip:updated", onTripUpdated);

    let cancelled = false;
    let locSub = null;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled || status !== "granted") {
        if (!cancelled && status !== "granted") {
          Alert.alert("Location", "Permission needed to share location with rider.");
        }
        return;
      }
      locSub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          distanceInterval: 12,
          timeInterval: 2500,
        },
        (loc) => {
          const lat = loc.coords.latitude;
          const lng = loc.coords.longitude;
          setMe({ lat, lng });
          s.emit("driver:location", { tripId, lat, lng });
        }
      );
      if (cancelled) {
        locSub.remove();
        return;
      }
      watchRef.current = locSub;
    })();

    return () => {
      cancelled = true;
      s.off("trip:updated", onTripUpdated);
      locSub?.remove();
      watchRef.current = null;
      s.emit("trip:unsubscribe", { tripId });
    };
  }, [token, activeTripId]);

  const login = async () => {
    setBusy(true);
    try {
      const { token: t } = await api("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      await AsyncStorage.setItem(TOKEN_KEY, t);
      setToken(t);
      await loadAvailable(t);
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
        body: {
          email,
          password,
          name: email.split("@")[0] || "Driver",
          role: "driver",
        },
      });
      await AsyncStorage.setItem(TOKEN_KEY, t);
      setToken(t);
      await loadAvailable(t);
    } catch (e) {
      Alert.alert("Register failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    watchRef.current?.remove();
    watchRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    await AsyncStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setActiveTrip(null);
    setAvailable([]);
    setMe(null);
  };

  const accept = async (tripId) => {
    if (!token) return;
    setBusy(true);
    try {
      const listed = available.find((x) => x._id === tripId);
      const { trip } = await api(`/trips/${tripId}/accept`, {
        method: "POST",
        token,
      });
      let merged = trip;
      const listedDrop =
        listed?.dropoff?.lat != null &&
        listed?.dropoff?.lng != null &&
        Number.isFinite(listed.dropoff.lat) &&
        Number.isFinite(listed.dropoff.lng)
          ? { lat: listed.dropoff.lat, lng: listed.dropoff.lng }
          : null;
      const serverDrop =
        merged.dropoff?.lat != null &&
        merged.dropoff?.lng != null &&
        Number.isFinite(merged.dropoff.lat) &&
        Number.isFinite(merged.dropoff.lng);
      if (listedDrop && !serverDrop) {
        merged = { ...merged, dropoff: listedDrop };
      }
      try {
        const { trip: fresh } = await api(`/trips/${tripId}`, { token });
        if (fresh) merged = fresh;
      } catch {
        /* keep merged */
      }
      setActiveTrip(merged);
      setPreviewTrip((prev) => (prev && prev._id === tripId ? null : prev));
      setAvailable((prev) => prev.filter((x) => x._id !== tripId));
    } catch (e) {
      Alert.alert("Accept failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const completeTrip = async () => {
    if (!token || !activeTrip) return;
    setBusy(true);
    try {
      await api(`/trips/${activeTrip._id}/complete`, {
        method: "POST",
        token,
      });
      setActiveTrip(null);
      setMe(null);
      await loadAvailable(token);
    } catch (e) {
      Alert.alert("Complete failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Testing: cancel the trip (rider sees it cleared via socket). */
  const cancelTrip = async () => {
    if (!token || !activeTrip) return;
    const t = activeTrip;
    const rawId = [t._id, t.id].find((x) => x != null && String(x).length > 0);
    const idStr = rawId != null ? String(rawId) : "";
    if (!idStr) {
      Alert.alert("Cancel ride", "Missing trip id.");
      return;
    }
    setBusy(true);
    try {
      await api("/trips/cancel", { method: "POST", token, body: { tripId: idStr } });
      setActiveTrip(null);
      setMe(null);
      await loadAvailable(token);
    } catch (e) {
      Alert.alert("Cancel ride failed", e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const region = useMemo(() => {
    if (activeTrip) {
      const p = activeTrip.pickup;
      const d = activeTrip.dropoff;
      if (d?.lat != null && d?.lng != null) {
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
    }
    return {
      latitude: 37.78,
      longitude: -122.4,
      latitudeDelta: 0.2,
      longitudeDelta: 0.2,
    };
  }, [activeTrip]);

  const previewRegion = useMemo(() => {
    if (!previewTrip) return null;
    const p = previewTrip.pickup;
    const d = previewTrip.dropoff;
    if (d?.lat != null && d?.lng != null) {
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
  }, [previewTrip]);

  useEffect(() => {
    if (!previewTrip) return;
    if (!available.some((x) => x._id === previewTrip._id)) {
      setPreviewTrip(null);
    }
  }, [available, previewTrip]);

  /** Frame pickup, optional dropoff, and you (when GPS is up). */
  useEffect(() => {
    if (!activeTrip || !mapRef.current) return;
    const coords = [{ latitude: activeTrip.pickup.lat, longitude: activeTrip.pickup.lng }];
    if (activeTrip.dropoff?.lat != null && activeTrip.dropoff?.lng != null) {
      coords.push({
        latitude: activeTrip.dropoff.lat,
        longitude: activeTrip.dropoff.lng,
      });
    }
    if (me?.lat != null && me?.lng != null) {
      coords.push({ latitude: me.lat, longitude: me.lng });
    }
    if (coords.length < 2) return;
    const t = setTimeout(() => {
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: MAP_EDGE_PADDING,
        animated: true,
      });
    }, 320);
    return () => clearTimeout(t);
  }, [
    activeTrip?._id,
    activeTrip?.pickup?.lat,
    activeTrip?.pickup?.lng,
    activeTrip?.dropoff?.lat,
    activeTrip?.dropoff?.lng,
    me?.lat,
    me?.lng,
  ]);

  if (!token) {
    return (
      <View style={styles.auth}>
        <StatusBar style="dark" />
        <Text style={styles.title}>TNC Driver</Text>
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
          <Text style={styles.secondaryBtnText}>Create driver account</Text>
        </Pressable>
      </View>
    );
  }

  if (activeTrip) {
    return (
      <View style={styles.container}>
        <StatusBar style="dark" />
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_GOOGLE}
          initialRegion={region}
        >
          {activeTrip.dropoff?.lat != null && activeTrip.dropoff?.lng != null ? (
            <Polyline
              coordinates={[
                { latitude: activeTrip.pickup.lat, longitude: activeTrip.pickup.lng },
                { latitude: activeTrip.dropoff.lat, longitude: activeTrip.dropoff.lng },
              ]}
              strokeColor="#7c3aed"
              strokeWidth={4}
            />
          ) : null}
          <Marker
            coordinate={{
              latitude: activeTrip.pickup.lat,
              longitude: activeTrip.pickup.lng,
            }}
            title="Rider pickup"
            pinColor="dodgerblue"
          />
          {activeTrip.dropoff?.lat != null && activeTrip.dropoff?.lng != null ? (
            <Marker
              coordinate={{
                latitude: activeTrip.dropoff.lat,
                longitude: activeTrip.dropoff.lng,
              }}
              title="Dropoff"
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <View style={styles.dropoffDot} />
            </Marker>
          ) : null}
          {me ? (
            <Marker
              coordinate={{ latitude: me.lat, longitude: me.lng }}
              title="You (driver)"
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <View style={styles.driverCarMarker}>
                <MaterialIcons name="directions-car" size={26} color="#ffffff" />
              </View>
            </Marker>
          ) : null}
        </MapView>
        <View style={styles.overlay}>
          <Text style={styles.banner}>
            Blue: pickup. Purple dot + line: dropoff (if set). You are the car. Location streams to the rider.
            {`\nPickup: ${pickupLabel(activeTrip)}`}
            {dropoffLabel(activeTrip) ? `\nDropoff: ${dropoffLabel(activeTrip)}` : ""}
            {activeTrip?.etaToPickup
              ? `\nETA to pickup: ${activeTrip.etaToPickup.durationText || `~${activeTrip.etaToPickup.summaryMinutes} min`}${activeTrip.etaToPickup.distanceText ? ` · ${activeTrip.etaToPickup.distanceText}` : ""}${activeTrip.etaToPickup.usesTraffic ? " (traffic)" : ""}`
              : me
                ? "\nETA to pickup: updating…"
                : ""}
          </Text>
          <View style={styles.row}>
            <Pressable style={styles.smallBtn} onPress={() => openNavigatePickupFor(activeTrip)}>
              <Text style={styles.smallBtnText}>Nav: pickup</Text>
            </Pressable>
            {activeTrip.dropoff?.lat != null && activeTrip.dropoff?.lng != null ? (
              <Pressable style={styles.smallBtn} onPress={() => openNavigateDropoffFor(activeTrip)}>
                <Text style={styles.smallBtnText}>Nav: dropoff</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.row}>
            <Pressable style={[styles.smallBtn, styles.warn]} onPress={cancelTrip} disabled={busy}>
              <Text style={styles.smallBtnTextLight}>Clear ride</Text>
            </Pressable>
            <Pressable style={[styles.smallBtn, styles.danger]} onPress={completeTrip} disabled={busy}>
              <Text style={styles.smallBtnTextLight}>Complete trip</Text>
            </Pressable>
            <Pressable style={styles.smallBtn} onPress={logout}>
              <Text style={styles.smallBtnText}>Log out</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  if (previewTrip && previewRegion) {
    return (
      <View style={styles.container}>
        <StatusBar style="dark" />
        <MapView style={StyleSheet.absoluteFill} provider={PROVIDER_GOOGLE} initialRegion={previewRegion}>
          {previewTrip.dropoff?.lat != null && previewTrip.dropoff?.lng != null ? (
            <Polyline
              coordinates={[
                { latitude: previewTrip.pickup.lat, longitude: previewTrip.pickup.lng },
                { latitude: previewTrip.dropoff.lat, longitude: previewTrip.dropoff.lng },
              ]}
              strokeColor="#7c3aed"
              strokeWidth={4}
            />
          ) : null}
          <Marker
            coordinate={{
              latitude: previewTrip.pickup.lat,
              longitude: previewTrip.pickup.lng,
            }}
            title="Rider pickup"
            pinColor="dodgerblue"
          />
          {previewTrip.dropoff?.lat != null && previewTrip.dropoff?.lng != null ? (
            <Marker
              coordinate={{
                latitude: previewTrip.dropoff.lat,
                longitude: previewTrip.dropoff.lng,
              }}
              title="Dropoff"
            >
              <View style={styles.dropoffDot} />
            </Marker>
          ) : null}
        </MapView>
        <View style={styles.overlay}>
          <Text style={styles.banner}>
            Trip preview. Blue is pickup.
            {` Purple is dropoff when set.\nPickup: ${pickupLabel(previewTrip)}`}
            {dropoffLabel(previewTrip) ? `\nDropoff: ${dropoffLabel(previewTrip)}` : "\nNo dropoff set on this request."}
          </Text>
          <View style={styles.row}>
            <Pressable style={styles.smallBtn} onPress={() => openNavigatePickupFor(previewTrip)}>
              <Text style={styles.smallBtnText}>Nav: pickup</Text>
            </Pressable>
            {previewTrip.dropoff?.lat != null && previewTrip.dropoff?.lng != null ? (
              <Pressable style={styles.smallBtn} onPress={() => openNavigateDropoffFor(previewTrip)}>
                <Text style={styles.smallBtnText}>Nav: dropoff</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.row}>
            <Pressable style={[styles.smallBtn, styles.acceptSmall]} onPress={() => accept(previewTrip._id)} disabled={busy}>
              <Text style={styles.smallBtnTextLight}>{busy ? "Accepting..." : "Accept trip"}</Text>
            </Pressable>
            <Pressable style={styles.smallBtn} onPress={() => setPreviewTrip(null)} disabled={busy}>
              <Text style={styles.smallBtnText}>Back to list</Text>
            </Pressable>
            <Pressable style={styles.smallBtn} onPress={logout} disabled={busy}>
              <Text style={styles.smallBtnText}>Log out</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.listWrap}>
      <StatusBar style="dark" />
      <Text style={styles.listTitle}>Open requests</Text>
      <Pressable style={styles.refresh} onPress={() => token && loadAvailable(token)}>
        <Text style={styles.refreshText}>Refresh</Text>
      </Pressable>
      <FlatList
        data={available}
        keyExtractor={(item) => item._id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={
          <Text style={styles.empty}>No open requests. Keep this screen open — new rides appear via socket.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Trip {item._id.slice(-6)}</Text>
            <Text style={styles.cardMeta}>
              Pickup: {pickupLabel(item)}
            </Text>
            <Text style={styles.cardMeta}>Dropoff: {dropoffLabel(item) || "Not set"}</Text>
            <View style={styles.cardRow}>
              <Pressable style={[styles.previewBtn, busy && styles.btnDisabled]} onPress={() => setPreviewTrip(item)} disabled={busy}>
                <Text style={styles.previewBtnText}>Preview</Text>
              </Pressable>
              <Pressable style={[styles.acceptBtn, busy && styles.btnDisabled]} onPress={() => accept(item._id)} disabled={busy}>
                <Text style={styles.acceptBtnText}>Accept</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
      <Pressable style={styles.footerBtn} onPress={logout}>
        <Text style={styles.footerBtnText}>Log out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: "#059669",
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontWeight: "600" },
  secondaryBtn: { padding: 12, alignItems: "center" },
  secondaryBtnText: { color: "#059669", fontWeight: "600" },
  container: { flex: 1 },
  listWrap: { flex: 1, paddingTop: 56, paddingHorizontal: 16, backgroundColor: "#f8fafc" },
  listTitle: { fontSize: 22, fontWeight: "700", marginBottom: 8 },
  refresh: { alignSelf: "flex-start", marginBottom: 12 },
  refreshText: { color: "#059669", fontWeight: "600" },
  empty: { color: "#64748b", marginTop: 24 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  cardMeta: { color: "#64748b", marginTop: 4, marginBottom: 12 },
  cardRow: { flexDirection: "row", gap: 8 },
  previewBtn: {
    backgroundColor: "#0f172a",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    flex: 1,
  },
  previewBtnText: { color: "#fff", fontWeight: "700" },
  acceptBtn: {
    backgroundColor: "#059669",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    flex: 1,
  },
  acceptBtnText: { color: "#fff", fontWeight: "700" },
  btnDisabled: { opacity: 0.6 },
  footerBtn: { padding: 16, alignItems: "center" },
  footerBtnText: { color: "#64748b", fontWeight: "600" },
  overlay: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 36,
    gap: 10,
  },
  dropoffDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#7c3aed",
    borderWidth: 3,
    borderColor: "#fff",
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
  banner: {
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 12,
    borderRadius: 12,
    fontSize: 14,
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  smallBtn: {
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  warn: { backgroundColor: "#f59e0b" },
  danger: { backgroundColor: "#dc2626" },
  acceptSmall: { backgroundColor: "#059669" },
  smallBtnText: { fontWeight: "600", color: "#0f172a" },
  smallBtnTextLight: { fontWeight: "600", color: "#fff" },
});
