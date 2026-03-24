import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import LottieView from "lottie-react-native";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import { getApiUrl, getGoogleGeocodingApiKey } from "./lib/config";

const TOKEN_KEY = "tnc_token";

const RIDER_FARE_FREE_FALLBACK_EXPLANATION =
  "We're not charging fares while we test our new app and operations with local neighbors. Riding free helps us learn before we launch fully — thank you for being part of it.";

function FreeRideWhyModal({ visible, explanation, onClose }) {
  const body =
    typeof explanation === "string" && explanation.trim().length > 0
      ? explanation.trim()
      : RIDER_FARE_FREE_FALLBACK_EXPLANATION;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.freeRideModalRoot}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Dismiss" />
        <View style={styles.freeRideModalCard}>
          <Text style={styles.freeRideModalTitle}>Why is my ride free?</Text>
          <ScrollView style={styles.freeRideModalScroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.freeRideModalBody}>{body}</Text>
          </ScrollView>
          <Pressable style={styles.freeRideModalBtn} onPress={onClose}>
            <Text style={styles.freeRideModalBtnText}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function FreeRideBanner({ onPressWhy }) {
  return (
    <View style={styles.freeRideBanner}>
      <View style={styles.freeRideBannerTextCol}>
        <Text style={styles.freeRideBannerTitle}>{"No fare — you're covered"}</Text>
        <Text style={styles.freeRideBannerSub}>Local testing · quotes show $0</Text>
      </View>
      <Pressable style={styles.freeRideWhyChip} onPress={onPressWhy} hitSlop={8}>
        <Text style={styles.freeRideWhyChipText}>Why?</Text>
      </Pressable>
    </View>
  );
}
const PICKUP_TIME_OFFSETS = [0, 20, 40, 60];
const MAP_STYLE_CLEAN = [
  { elementType: "geometry", stylers: [{ color: "#f5f7fb" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#6b7280" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#f5f7fb" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#eef2ff" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#dbeafe" }] },
  { featureType: "road.highway", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#dbeafe" }] },
  { featureType: "administrative", elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
];
const MAP_STYLE_CONTRAST = [
  { elementType: "geometry", stylers: [{ color: "#f8fafc" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#334155" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#64748b" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#e2e8f0" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#c7d2fe" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#bfdbfe" }] },
];
const MAP_STYLE_NIGHT = [
  { elementType: "geometry", stylers: [{ color: "#111827" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#cbd5e1" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#111827" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#1f2937" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#334155" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#4338ca" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#1d4ed8" }] },
];
const MAP_STYLE_OPTIONS = [
  { id: "default", label: "Default", style: null },
  { id: "clean", label: "Clean", style: MAP_STYLE_CLEAN },
  { id: "contrast", label: "Contrast", style: MAP_STYLE_CONTRAST },
  { id: "night", label: "Night", style: MAP_STYLE_NIGHT },
];

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

async function fetchDrivingPreviewCoords(token, from, to) {
  if (!from || !to || !token) return null;
  const fla = Number(from.lat);
  const flo = Number(from.lng);
  const tla = Number(to.lat);
  const tlo = Number(to.lng);
  if (![fla, flo, tla, tlo].every((n) => Number.isFinite(n))) return null;
  const params = new URLSearchParams({
    fromLat: String(fla),
    fromLng: String(flo),
    toLat: String(tla),
    toLng: String(tlo),
  });
  try {
    const data = await api(`/routes/driving-preview?${params.toString()}`, { token });
    if (Array.isArray(data.coordinates) && data.coordinates.length >= 2) {
      return data.coordinates
        .map((c) => ({
          latitude: Number(c.lat),
          longitude: Number(c.lng),
        }))
        .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
    }
  } catch {
    /* chord fallback */
  }
  return null;
}

async function fetchRiderServicePublic() {
  const base = getApiUrl().replace(/\/$/, "");
  const url = `${base}/config/rider`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data.error || text || `HTTP ${res.status}`);
  }
  return {
    driversAvailable: data.driversAvailable !== false,
    closedMessage: typeof data.closedMessage === "string" ? data.closedMessage : "",
    fareFreeEnabled: data.fareFreeEnabled === true,
    fareFreeRiderExplanation:
      typeof data.fareFreeRiderExplanation === "string" ? data.fareFreeRiderExplanation : "",
  };
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
  const [pickupQuery, setPickupQuery] = useState("");
  const [dropoffQuery, setDropoffQuery] = useState("");
  const [resolvingPickup, setResolvingPickup] = useState(false);
  const [resolvingDropoff, setResolvingDropoff] = useState(false);
  /** Planning: step 1 = pickup, step 2 = dropoff. */
  const [bookingStep, setBookingStep] = useState("pickup");
  /** For the active step: place pin on map or resolve typed address. */
  const [planEntryMode, setPlanEntryMode] = useState("map");
  const [pickupOffsetMinutes, setPickupOffsetMinutes] = useState(0);
  const [pickupTimeMenuOpen, setPickupTimeMenuOpen] = useState(false);
  const [mapStyleId, setMapStyleId] = useState("default");
  const pickupTimeOptions = useMemo(() => {
    const now = new Date();
    return PICKUP_TIME_OFFSETS.map((minutes) => {
      if (minutes === 0) return { key: "asap", minutes, label: "ASAP", preferredPickupAt: null };
      const at = new Date(now.getTime() + minutes * 60 * 1000);
      return {
        key: String(minutes),
        minutes,
        label: `+${minutes}m`,
        preferredPickupAt: at.toISOString(),
      };
    });
  }, []);

  const preferredPickupAt =
    pickupOffsetMinutes > 0
      ? pickupTimeOptions.find((opt) => opt.minutes === pickupOffsetMinutes)?.preferredPickupAt || null
      : null;
  const selectedPickupTimeLabel = useMemo(() => {
    const opt = pickupTimeOptions.find((o) => o.minutes === pickupOffsetMinutes);
    return opt?.label ?? "ASAP";
  }, [pickupTimeOptions, pickupOffsetMinutes]);
  const activeMapStyle = useMemo(
    () => MAP_STYLE_OPTIONS.find((x) => x.id === mapStyleId)?.style || null,
    [mapStyleId]
  );

  const [trip, setTrip] = useState(null);
  const [driverLive, setDriverLive] = useState(null);
  const [riderService, setRiderService] = useState({
    driversAvailable: true,
    closedMessage: "",
    fareFreeEnabled: false,
    fareFreeRiderExplanation: "",
  });
  const [freeRideWhyOpen, setFreeRideWhyOpen] = useState(false);
  const [regPhone, setRegPhone] = useState("");
  const [planRouteCoords, setPlanRouteCoords] = useState(null);
  const [tripRouteCoords, setTripRouteCoords] = useState(null);
  /** null | { kind: "loading" } | { kind: "ok", estimate } | { kind: "err" } */
  const [farePreview, setFarePreview] = useState(null);
  const socketRef = useRef(null);
  const tripIdRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem(TOKEN_KEY);
      setToken(t);
    })();
  }, []);

  /** One HTTP read for login screen + first paint; logged-in riders also get pushes over Socket.io. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await fetchRiderServicePublic();
        if (!cancelled) setRiderService(c);
      } catch {
        if (!cancelled) {
          setRiderService({
            driversAvailable: true,
            closedMessage: "",
            fareFreeEnabled: false,
            fareFreeRiderExplanation: "",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    tripIdRef.current = trip?._id != null ? String(trip._id) : null;
  }, [trip?._id]);

  const applyIncomingTrip = useCallback((nextTrip) => {
    if (!nextTrip) return;
    if (nextTrip.status === "cancelled" || nextTrip.status === "completed") {
      setTrip(null);
      setDriverLive(null);
      return;
    }
    setTrip((prev) => {
      if (!prev || String(prev._id) !== String(nextTrip._id)) return nextTrip;
      const merged = { ...prev, ...nextTrip };
      if (prev.driverProfile && !nextTrip.driverProfile) merged.driverProfile = prev.driverProfile;
      return merged;
    });
    if (nextTrip.driverLocation) {
      setDriverLive({
        lat: nextTrip.driverLocation.lat,
        lng: nextTrip.driverLocation.lng,
      });
    }
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

    const applyRiderService = (payload) => {
      if (!payload || typeof payload !== "object") return;
      setRiderService({
        driversAvailable: payload.driversAvailable !== false,
        closedMessage: typeof payload.closedMessage === "string" ? payload.closedMessage : "",
        fareFreeEnabled: payload.fareFreeEnabled === true,
        fareFreeRiderExplanation:
          typeof payload.fareFreeRiderExplanation === "string" ? payload.fareFreeRiderExplanation : "",
      });
    };

    s.on("riderService:updated", applyRiderService);

    s.on("trip:updated", (msg) => {
      if (msg?.trip) applyIncomingTrip(msg.trip);
    });
    s.on("driver:location", (msg) => {
      if (typeof msg?.lat === "number" && typeof msg?.lng === "number") {
        setDriverLive({ lat: msg.lat, lng: msg.lng });
      }
    });
    s.on("connect", () => {
      const tid = tripIdRef.current;
      if (tid) s.emit("trip:subscribe", { tripId: tid });
    });
    s.on("connect_error", () => {});

    return () => {
      s.disconnect();
      if (socketRef.current === s) socketRef.current = null;
    };
  }, [token, applyIncomingTrip]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s || !token) return;
    const id = trip?._id != null ? String(trip._id) : null;
    if (id && s.connected) s.emit("trip:subscribe", { tripId: id });
    return () => {
      if (id && socketRef.current?.connected) {
        socketRef.current.emit("trip:unsubscribe", { tripId: id });
      }
    };
  }, [token, trip?._id]);

  useEffect(() => {
    if (!token || !trip?._id) return undefined;
    if (!["requested", "accepted", "in_progress"].includes(trip.status)) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const out = await api(`/trips/${trip._id}`, { token });
        if (!cancelled && out?.trip) applyIncomingTrip(out.trip);
      } catch {
        /* socket remains primary; polling is best-effort fallback */
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, trip?._id, trip?.status, applyIncomingTrip]);

  useEffect(() => {
    if (!token || trip) {
      setPlanRouteCoords(null);
      return;
    }
    if (!pickup || !dropoff) {
      setPlanRouteCoords(null);
      return;
    }
    if (![pickup.lat, pickup.lng, dropoff.lat, dropoff.lng].every((n) => Number.isFinite(Number(n)))) {
      setPlanRouteCoords(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const coords = await fetchDrivingPreviewCoords(token, pickup, dropoff);
      if (!cancelled) setPlanRouteCoords(coords);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, trip, pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng]);

  useEffect(() => {
    if (!token || trip || !pickup || !dropoff) {
      setFarePreview(null);
      return;
    }
    if (![pickup.lat, pickup.lng, dropoff.lat, dropoff.lng].every((n) => Number.isFinite(Number(n)))) {
      setFarePreview(null);
      return;
    }
    let cancelled = false;
    setFarePreview({ kind: "loading" });
    const tid = setTimeout(async () => {
      try {
        const data = await api("/pricing/estimate", {
          method: "POST",
          token,
          body: {
            pickup: { lat: Number(pickup.lat), lng: Number(pickup.lng) },
            dropoff: { lat: Number(dropoff.lat), lng: Number(dropoff.lng) },
          },
        });
        if (!cancelled && data?.estimate) setFarePreview({ kind: "ok", estimate: data.estimate });
        else if (!cancelled) setFarePreview({ kind: "err" });
      } catch {
        if (!cancelled) setFarePreview({ kind: "err" });
      }
    }, 550);
    return () => {
      cancelled = true;
      clearTimeout(tid);
    };
  }, [token, trip, pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng]);

  useEffect(() => {
    if (!token || !trip?.pickup) {
      setTripRouteCoords(null);
      return;
    }
    const st = trip.status || "";
    const p = trip.pickup;
    const d = trip.dropoff;
    const live =
      trip?.driverLocation?.lat != null && Number.isFinite(Number(trip.driverLocation.lat))
        ? { lat: Number(trip.driverLocation.lat), lng: Number(trip.driverLocation.lng) }
        : driverLive?.lat != null && Number.isFinite(Number(driverLive.lat))
          ? { lat: Number(driverLive.lat), lng: Number(driverLive.lng) }
          : null;
    const target = st === "in_progress" ? d : p;
    const from = live;
    if (!from || !target || ![from.lat, from.lng, target.lat, target.lng].every((n) => Number.isFinite(Number(n)))) {
      setTripRouteCoords(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const coords = await fetchDrivingPreviewCoords(token, from, target);
      if (!cancelled) setTripRouteCoords(coords);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    token,
    trip?._id,
    trip?.status,
    trip?.pickup?.lat,
    trip?.pickup?.lng,
    trip?.dropoff?.lat,
    trip?.dropoff?.lng,
    trip?.driverLocation?.lat,
    trip?.driverLocation?.lng,
    driverLive?.lat,
    driverLive?.lng,
  ]);

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
      const body = {
        email,
        password,
        name: email.split("@")[0] || "Rider",
        role: "rider",
        ...(regPhone.trim() ? { phone: regPhone.trim() } : {}),
      };
      const { token: t } = await api("/auth/register", {
        method: "POST",
        body,
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
        setBookingStep("pickup");
        setPlanEntryMode("map");
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
    setPickupQuery("");
    setDropoffQuery("");
    setBookingStep("pickup");
    setPlanEntryMode("map");
    setPickupOffsetMinutes(0);
    setPickupTimeMenuOpen(false);
    setFarePreview(null);
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
    if (trip) {
      animateMapToPoint(c);
      return;
    }
    if (bookingStep === "pickup") {
      setPickup(c);
      setPickupAddressLabel(null);
    } else {
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
        pickupOffsetMinutes,
        preferredPickupAt,
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

  const mapRouteCoords = useMemo(() => {
    if (trip?.pickup && trip?.dropoff) {
      const st = trip.status || "";
      const p = trip.pickup;
      const d = trip.dropoff;
      const live =
        trip?.driverLocation?.lat != null && Number.isFinite(Number(trip.driverLocation.lat))
          ? { lat: Number(trip.driverLocation.lat), lng: Number(trip.driverLocation.lng) }
          : driverLive?.lat != null && Number.isFinite(Number(driverLive.lat))
            ? { lat: Number(driverLive.lat), lng: Number(driverLive.lng) }
            : null;
      if (
        live &&
        [p.lat, p.lng, d.lat, d.lng, live.lat, live.lng].every((n) => Number.isFinite(Number(n)))
      ) {
        const target = st === "in_progress" ? d : p;
        const chord = [
          { latitude: live.lat, longitude: live.lng },
          { latitude: target.lat, longitude: target.lng },
        ];
        return tripRouteCoords?.length >= 2 ? tripRouteCoords : chord;
      }
    }
    const hasSelectedDropoffAddress =
      typeof dropoffAddressLabel === "string" && dropoffAddressLabel.trim().length > 0;
    if (!trip && bookingStep !== "pickup" && hasSelectedDropoffAddress && displayPickup && displayDropoff) {
      const p = displayPickup;
      const d = displayDropoff;
      if ([p.lat, p.lng, d.lat, d.lng].every((n) => Number.isFinite(Number(n)))) {
        const chord = [
          { latitude: p.lat, longitude: p.lng },
          { latitude: d.lat, longitude: d.lng },
        ];
        return planRouteCoords?.length >= 2 ? planRouteCoords : chord;
      }
    }
    return [];
  }, [
    trip,
    trip?.pickup?.lat,
    trip?.pickup?.lng,
    trip?.dropoff?.lat,
    trip?.dropoff?.lng,
    trip?.status,
    tripRouteCoords,
    bookingStep,
    displayPickup?.lat,
    displayPickup?.lng,
    displayDropoff?.lat,
    displayDropoff?.lng,
    trip?.driverLocation?.lat,
    trip?.driverLocation?.lng,
    driverLive?.lat,
    driverLive?.lng,
    dropoffAddressLabel,
    planRouteCoords,
  ]);

  const setPickupFromAddress = async () => {
    const q = pickupQuery.trim();
    if (!q) {
      Alert.alert("Pickup address", "Enter a pickup address first.");
      return;
    }
    setResolvingPickup(true);
    try {
      const out = await geocodeAddressToPoint(q);
      if (!out?.point) {
        Alert.alert(
          "Pickup address",
          getGoogleGeocodingApiKey()
            ? "Could not find that address."
            : "Add EXPO_PUBLIC_GOOGLE_GEOCODING_API_KEY to geocode addresses."
        );
        return;
      }
      setPickup(out.point);
      setPickupAddressLabel(out.address || q);
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
      setResolvingPickup(false);
    }
  };

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
        Alert.alert(
          "Dropoff address",
          getGoogleGeocodingApiKey()
            ? "Could not find that address."
            : "Add EXPO_PUBLIC_GOOGLE_GEOCODING_API_KEY to geocode addresses."
        );
        return;
      }
      setDropoff(out.point);
      setDropoffAddressLabel(out.address || q);
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

  const driverCoord =
    driverLive ||
    (trip?.driverLocation
      ? { lat: trip.driverLocation.lat, lng: trip.driverLocation.lng }
      : null);


  const region = useMemo(() => {
    const p = displayPickup || { lat: 37.78, lng: -122.4 };
    const d = displayDropoff;
    const planningPickupOnly = !trip && bookingStep === "pickup";
    if (planningPickupOnly) {
      return {
        latitude: p.lat,
        longitude: p.lng,
        latitudeDelta: 0.08,
        longitudeDelta: 0.08,
      };
    }

    const spanAB = (a, b) =>
      Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lng - b.lng), 0.02) * 1.4;

    if (trip && driverCoord && trip.status === "accepted") {
      return {
        latitude: (p.lat + driverCoord.lat) / 2,
        longitude: (p.lng + driverCoord.lng) / 2,
        latitudeDelta: spanAB(p, driverCoord),
        longitudeDelta: spanAB(p, driverCoord),
      };
    }
    if (trip && driverCoord && trip.status === "in_progress" && d) {
      return {
        latitude: (d.lat + driverCoord.lat) / 2,
        longitude: (d.lng + driverCoord.lng) / 2,
        latitudeDelta: spanAB(d, driverCoord),
        longitudeDelta: spanAB(d, driverCoord),
      };
    }

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
  }, [displayPickup, displayDropoff, trip, bookingStep, driverCoord?.lat, driverCoord?.lng]);

  /** accepted: pickup + driver (omit dropoff from camera). in_progress: dropoff + driver. */
  useEffect(() => {
    if (!trip || !driverCoord) return;
    if (!["accepted", "in_progress"].includes(trip.status)) return;

    const coords = [];
    if (trip.status === "in_progress") {
      if (!displayDropoff) return;
      coords.push({ latitude: displayDropoff.lat, longitude: displayDropoff.lng });
      coords.push({ latitude: driverCoord.lat, longitude: driverCoord.lng });
    } else {
      if (!displayPickup) return;
      coords.push({ latitude: displayPickup.lat, longitude: displayPickup.lng });
      coords.push({ latitude: driverCoord.lat, longitude: driverCoord.lng });
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

  const ridersPaused = !riderService.driversAvailable;
  const showRidersClosedGate = token && !trip && ridersPaused;

  if (!token) {
    return (
      <View style={styles.auth}>
        <StatusBar style="dark" />
        <Text style={styles.title}>TNC Rider</Text>
        <Text style={styles.apiHint} selectable>
          API: {getApiUrl()}
        </Text>
        {riderService.fareFreeEnabled ? (
          <View style={styles.freeRideBannerAuthWrap}>
            <FreeRideBanner onPressWhy={() => setFreeRideWhyOpen(true)} />
          </View>
        ) : null}
        <FreeRideWhyModal
          visible={freeRideWhyOpen}
          explanation={riderService.fareFreeRiderExplanation}
          onClose={() => setFreeRideWhyOpen(false)}
        />
        {ridersPaused ? (
          <View style={styles.publicClosedBanner}>
            <Text style={styles.publicClosedTitle}>Rides paused</Text>
            <Text style={styles.publicClosedText}>{riderService.closedMessage || "Please check back soon."}</Text>
          </View>
        ) : null}
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
        <TextInput
          style={styles.input}
          placeholder="Phone (optional, for driver contact)"
          keyboardType="phone-pad"
          value={regPhone}
          onChangeText={setRegPhone}
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
      <FreeRideWhyModal
        visible={freeRideWhyOpen}
        explanation={riderService.fareFreeRiderExplanation}
        onClose={() => setFreeRideWhyOpen(false)}
      />
      {showRidersClosedGate ? (
        <View style={styles.ridersClosedLayer} pointerEvents="box-none">
          <View style={styles.ridersClosedCard} pointerEvents="auto">
            <Text style={styles.ridersClosedTitle}>No drivers available</Text>
            <Text style={styles.ridersClosedBody}>
              {riderService.closedMessage || "Please check back soon."}
            </Text>
            <Pressable
              style={[styles.smallBtn, styles.primarySmall]}
              onPress={async () => {
                try {
                  const c = await fetchRiderServicePublic();
                  setRiderService(c);
                } catch {
                  Alert.alert("Check status", "Could not reach the server.");
                }
              }}
            >
              <Text style={[styles.smallBtnText, styles.smallBtnTextOnPrimary]}>Check again</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={styles.mapStyleBar} pointerEvents="box-none">
        {riderService.fareFreeEnabled ? (
          <FreeRideBanner onPressWhy={() => setFreeRideWhyOpen(true)} />
        ) : null}
        <View style={styles.mapStyleChips} pointerEvents="auto">
          {MAP_STYLE_OPTIONS.map((opt) => {
            const active = mapStyleId === opt.id;
            return (
              <Pressable
                key={opt.id}
                style={[styles.mapStyleChip, active && styles.mapStyleChipActive]}
                onPress={() => setMapStyleId(opt.id)}
              >
                <Text style={[styles.mapStyleChipText, active && styles.mapStyleChipTextActive]}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        customMapStyle={activeMapStyle || undefined}
        initialRegion={region}
        onPress={(e) => {
          if (trip) return;
          const { latitude, longitude } = e.nativeEvent.coordinate;
          const c = { lat: latitude, lng: longitude };
          if (bookingStep === "pickup") {
            setPickup(c);
            setPickupAddressLabel(null);
          } else {
            setDropoff(c);
            setDropoffAddressLabel(null);
          }
        }}
      >
        {displayPickup && (!trip || trip.status !== "in_progress") ? (
          <Marker
            coordinate={{ latitude: displayPickup.lat, longitude: displayPickup.lng }}
            title="Pickup"
            anchor={{ x: 0.5, y: 0.5 }}
            image={require("./assets/pickup-marker.png")}
          />
        ) : null}
        {displayDropoff && (trip || bookingStep === "dropoff") ? (
          <Marker
            coordinate={{ latitude: displayDropoff.lat, longitude: displayDropoff.lng }}
            title="Dropoff"
            anchor={{ x: 0.5, y: 0.5 }}
            image={require("./assets/dropoff-marker.png")}
          />
        ) : null}
        {driverCoord && trip && trip.status !== "requested" ? (
          <Marker
            coordinate={{ latitude: driverCoord.lat, longitude: driverCoord.lng }}
            title="Driver"
            anchor={{ x: 0.5, y: 0.5 }}
            image={require("./assets/driver-marker.png")}
          />
        ) : null}
        {mapRouteCoords.length >= 2 ? (
          <Polyline coordinates={mapRouteCoords} strokeColor="#7c3aed" strokeWidth={4} />
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
        {!trip ? (
          <>
            <View style={styles.stepRow}>
              <View style={[styles.stepChip, bookingStep === "pickup" && styles.stepChipActive]}>
                <Text style={[styles.stepChipNum, bookingStep === "pickup" && styles.stepChipOnPrimary]}>1</Text>
                <Text style={[styles.stepChipLabel, bookingStep === "pickup" && styles.stepChipLabelActive]}>Pickup</Text>
              </View>
              <View style={styles.stepConnector} />
              <View style={[styles.stepChip, bookingStep === "dropoff" && styles.stepChipActive]}>
                <Text style={[styles.stepChipNum, bookingStep === "dropoff" && styles.stepChipOnPrimary]}>2</Text>
                <Text style={[styles.stepChipLabel, bookingStep === "dropoff" && styles.stepChipLabelActive]}>Dropoff</Text>
              </View>
            </View>
            <Text style={styles.banner}>
              {bookingStep === "pickup"
                ? "Step 1 — Set your pickup on the map, use My location, or type an address."
                : "Step 2 — Set your dropoff the same way, then request your ride."}
            </Text>
            <View style={styles.timeRow}>
              <Text style={styles.timeLabel}>Pickup time</Text>
              <Pressable
                style={styles.timeDropdown}
                onPress={() => setPickupTimeMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Pickup time"
                accessibilityHint="Opens a list of pickup time options"
              >
                <Text style={styles.timeDropdownValue}>{selectedPickupTimeLabel}</Text>
                <Text style={styles.timeDropdownChevron}>▾</Text>
              </Pressable>
              <Modal
                visible={pickupTimeMenuOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setPickupTimeMenuOpen(false)}
              >
                <View style={styles.timeMenuRoot}>
                  <Pressable style={styles.timeMenuBackdrop} onPress={() => setPickupTimeMenuOpen(false)} />
                  <View style={styles.timeMenuSheet}>
                    <Text style={styles.timeMenuTitle}>Pickup time</Text>
                    {pickupTimeOptions.map((opt) => {
                      const active = pickupOffsetMinutes === opt.minutes;
                      return (
                        <Pressable
                          key={opt.key}
                          style={[styles.timeMenuRow, active && styles.timeMenuRowActive]}
                          onPress={() => {
                            setPickupOffsetMinutes(opt.minutes);
                            setPickupTimeMenuOpen(false);
                          }}
                        >
                          <Text style={[styles.timeMenuRowText, active && styles.timeMenuRowTextActive]}>
                            {opt.label}
                          </Text>
                          {active ? <Text style={styles.timeMenuCheck}>✓</Text> : null}
                        </Pressable>
                      );
                    })}
                    <Pressable style={styles.timeMenuCancel} onPress={() => setPickupTimeMenuOpen(false)}>
                      <Text style={styles.timeMenuCancelText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              </Modal>
            </View>
            <View style={styles.modeRow}>
              <Pressable
                style={[styles.modeBtn, planEntryMode === "map" && styles.modeBtnActive]}
                onPress={() => setPlanEntryMode("map")}
              >
                <Text style={[styles.modeBtnText, planEntryMode === "map" && styles.modeBtnTextActive]}>Map</Text>
              </Pressable>
              <Pressable
                style={[styles.modeBtn, planEntryMode === "address" && styles.modeBtnActive]}
                onPress={() => setPlanEntryMode("address")}
              >
                <Text style={[styles.modeBtnText, planEntryMode === "address" && styles.modeBtnTextActive]}>Address</Text>
              </Pressable>
            </View>
            <View style={styles.addrBox}>
              {bookingStep === "pickup" ? (
                <>
                  <Text style={styles.addrText}>
                    Pickup: {shownPickupAddress || (displayPickup ? "Locating address…" : "Not set yet")}
                  </Text>
                  {planEntryMode === "address" ? (
                    <>
                      <TextInput
                        style={styles.addrInput}
                        placeholder="Street, neighborhood, or place"
                        value={pickupQuery}
                        onChangeText={setPickupQuery}
                        autoCapitalize="words"
                        returnKeyType="search"
                        onSubmitEditing={setPickupFromAddress}
                      />
                      <Pressable
                        style={[styles.smallBtn, styles.primarySmall]}
                        onPress={setPickupFromAddress}
                        disabled={busy || resolvingPickup}
                      >
                        <Text style={[styles.smallBtnText, styles.smallBtnTextOnPrimary]}>
                          {resolvingPickup ? "Finding…" : "Use this address"}
                        </Text>
                      </Pressable>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <Text style={styles.addrText}>Pickup: {shownPickupAddress || "—"}</Text>
                  <Text style={styles.addrText}>
                    Dropoff: {shownDropoffAddress || (displayDropoff ? "Locating address…" : "Not set yet")}
                  </Text>
                  {planEntryMode === "address" ? (
                    <>
                      <TextInput
                        style={styles.addrInput}
                        placeholder="Street, neighborhood, or place"
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
                          {resolvingDropoff ? "Finding…" : "Use this address"}
                        </Text>
                      </Pressable>
                    </>
                  ) : null}
                  {displayDropoff ? (
                    <Pressable
                      style={styles.smallBtn}
                      onPress={() => {
                        setDropoff(null);
                        setDropoffAddressLabel(null);
                        setDropoffQuery("");
                      }}
                    >
                      <Text style={styles.smallBtnText}>Clear dropoff</Text>
                    </Pressable>
                  ) : null}
                  {farePreview?.kind === "loading" ? (
                    <Text style={styles.farePreviewText}>Estimating fare…</Text>
                  ) : farePreview?.kind === "ok" ? (
                    farePreview.estimate.breakdown?.fareFree ? (
                      <View>
                        <Text style={styles.farePreviewText}>
                          Fare waived: $0.00
                          {farePreview.estimate.breakdown?.trip?.durationText
                            ? ` · ~${farePreview.estimate.breakdown.trip.durationText} trip`
                            : ""}
                        </Text>
                        {typeof farePreview.estimate.breakdown?.waivedQuoteUsd === "number" ? (
                          <Text style={styles.farePreviewMuted}>
                            Would have been $
                            {Number(farePreview.estimate.breakdown.waivedQuoteUsd).toFixed(2)} without the waiver
                          </Text>
                        ) : null}
                        <Pressable style={styles.farePreviewWhy} onPress={() => setFreeRideWhyOpen(true)}>
                          <Text style={styles.farePreviewWhyText}>Why is this free?</Text>
                        </Pressable>
                      </View>
                    ) : (
                      <Text style={styles.farePreviewText}>
                        Estimated fare: {farePreview.estimate.currency === "USD" ? "$" : ""}
                        {farePreview.estimate.total.toFixed(2)}
                        {farePreview.estimate.breakdown?.trip?.durationText
                          ? ` · ~${farePreview.estimate.breakdown.trip.durationText} trip`
                          : ""}
                      </Text>
                    )
                  ) : farePreview?.kind === "err" ? (
                    <Text style={styles.farePreviewMuted}>Fare estimate unavailable (check Distance Matrix key).</Text>
                  ) : null}
                </>
              )}
            </View>
          </>
        ) : (
          <>
            <Text style={styles.banner}>
              {trip.status === "requested"
                ? "Your request is live. You can still cancel below if plans change."
                : trip.status === "accepted" || trip.status === "in_progress"
                  ? `Driver accepted — person = pickup, flag = dropoff, car = driver.${
                      trip?.etaToPickup
                        ? `\nDriver ETA to pickup: ${trip.etaToPickup.durationText || `~${trip.etaToPickup.summaryMinutes} min`}${trip.etaToPickup.distanceText ? ` · ${trip.etaToPickup.distanceText}` : ""}${trip.etaToPickup.usesTraffic ? " (traffic)" : ""}`
                        : driverCoord
                          ? "\nDriver ETA to pickup: updating…"
                          : "\nWaiting for driver location…"
                    }`
                  : `Trip: ${trip.status}`}
            </Text>
            {(trip.status === "accepted" || trip.status === "in_progress") && trip.driverProfile ? (
              <View style={styles.driverCard}>
                {typeof trip.driverProfile.avatarUrl === "string" &&
                (trip.driverProfile.avatarUrl.startsWith("http") || trip.driverProfile.avatarUrl.startsWith("data:")) ? (
                  <Image source={{ uri: trip.driverProfile.avatarUrl }} style={styles.driverAvatarImg} />
                ) : (
                  <View style={[styles.driverAvatarImg, styles.driverAvatarPlaceholder]} />
                )}
                <View style={styles.driverCardBody}>
                  <Text style={styles.driverCardName}>
                    {trip.driverProfile.firstName}
                    {trip.driverProfile.lastInitial ? ` ${trip.driverProfile.lastInitial}` : ""}
                  </Text>
                  {trip.driverProfile.vehicle &&
                  (trip.driverProfile.vehicle.make ||
                    trip.driverProfile.vehicle.model ||
                    trip.driverProfile.vehicle.color) ? (
                    <Text style={styles.driverCardMeta} numberOfLines={2}>
                      {[trip.driverProfile.vehicle.color, trip.driverProfile.vehicle.make, trip.driverProfile.vehicle.model]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  ) : null}
                  {trip.driverProfile.vehicle?.licensePlate ? (
                    <Text style={styles.driverCardMeta}>{trip.driverProfile.vehicle.licensePlate}</Text>
                  ) : null}
                </View>
                {typeof trip.driverProfile.vehicle?.photoUrl === "string" &&
                (trip.driverProfile.vehicle.photoUrl.startsWith("http") ||
                  trip.driverProfile.vehicle.photoUrl.startsWith("data:")) ? (
                  <Image source={{ uri: trip.driverProfile.vehicle.photoUrl }} style={styles.vehicleThumb} />
                ) : null}
              </View>
            ) : null}
            <View style={styles.addrBox}>
              <Text style={styles.addrText}>Pickup: {trip?.pickupAddress || "Not available"}</Text>
              <Text style={styles.addrText}>Dropoff: {trip?.dropoffAddress || "Not set"}</Text>
              {trip?.fareEstimate?.total != null ? (
                trip.fareEstimate.breakdown?.fareFree ? (
                  <View>
                    <Text style={styles.farePreviewText}>
                      Fare (at request): waived · $
                      {Number(trip.fareEstimate.total).toFixed(2)}
                    </Text>
                    {typeof trip.fareEstimate.breakdown?.waivedQuoteUsd === "number" ? (
                      <Text style={styles.farePreviewMuted}>
                        Would have been ${Number(trip.fareEstimate.breakdown.waivedQuoteUsd).toFixed(2)}
                      </Text>
                    ) : null}
                    <Pressable style={styles.farePreviewWhy} onPress={() => setFreeRideWhyOpen(true)}>
                      <Text style={styles.farePreviewWhyText}>Why is this free?</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={styles.farePreviewText}>
                    Fare (at request): {trip.fareEstimate.currency === "USD" ? "$" : ""}
                    {Number(trip.fareEstimate.total).toFixed(2)}
                  </Text>
                )
              ) : null}
            </View>
          </>
        )}
        <View style={styles.row}>
          <Pressable style={styles.smallBtn} onPress={centerOnMe}>
            <Text style={styles.smallBtnText}>My location</Text>
          </Pressable>
          {!trip && bookingStep === "pickup" && pickup ? (
            <Pressable
              style={[styles.smallBtn, styles.primarySmall]}
              onPress={() => {
                setBookingStep("dropoff");
                setPlanEntryMode("map");
              }}
            >
              <Text style={[styles.smallBtnText, styles.smallBtnTextOnPrimary]}>Continue to dropoff</Text>
            </Pressable>
          ) : null}
          {!trip && bookingStep === "dropoff" ? (
            <Pressable
              style={styles.smallBtn}
              onPress={() => {
                setBookingStep("pickup");
                setPlanEntryMode("map");
              }}
            >
              <Text style={styles.smallBtnText}>Back</Text>
            </Pressable>
          ) : null}
          {!trip && bookingStep === "dropoff" && pickup && dropoff ? (
            <Pressable style={[styles.smallBtn, styles.primarySmall]} onPress={requestRide} disabled={busy}>
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
  freeRideBannerAuthWrap: { marginBottom: 12 },
  freeRideBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#ecfdf5",
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#6ee7b7",
  },
  freeRideBannerTextCol: { flex: 1, marginRight: 10 },
  freeRideBannerTitle: { fontSize: 14, fontWeight: "800", color: "#065f46" },
  freeRideBannerSub: { fontSize: 12, color: "#047857", marginTop: 2 },
  freeRideWhyChip: {
    backgroundColor: "#059669",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  freeRideWhyChipText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  freeRideModalRoot: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.5)",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  freeRideModalCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    maxHeight: "72%",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  freeRideModalScroll: { maxHeight: 280, marginBottom: 12 },
  freeRideModalTitle: { fontSize: 18, fontWeight: "800", color: "#0f172a", marginBottom: 12 },
  freeRideModalBody: { fontSize: 15, color: "#475569", lineHeight: 22 },
  freeRideModalBtn: {
    alignSelf: "stretch",
    backgroundColor: "#059669",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  freeRideModalBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  farePreviewWhy: { alignSelf: "flex-start", marginTop: 6, paddingVertical: 4 },
  farePreviewWhyText: { fontSize: 13, fontWeight: "800", color: "#059669", textDecorationLine: "underline" },
  publicClosedBanner: {
    backgroundColor: "#fef3c7",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#fcd34d",
  },
  publicClosedTitle: { fontSize: 15, fontWeight: "700", color: "#92400e", marginBottom: 6 },
  publicClosedText: { fontSize: 14, color: "#78350f", lineHeight: 20 },
  ridersClosedLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-start",
    paddingTop: 52,
    paddingHorizontal: 16,
    zIndex: 20,
  },
  ridersClosedCard: {
    backgroundColor: "rgba(255,255,255,0.98)",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
  },
  ridersClosedTitle: { fontSize: 20, fontWeight: "700", color: "#0f172a", marginBottom: 10 },
  ridersClosedBody: { fontSize: 15, color: "#475569", lineHeight: 22, marginBottom: 16 },
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
  mapStyleBar: {
    position: "absolute",
    top: 56,
    left: 12,
    right: 12,
    zIndex: 18,
  },
  mapStyleChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  mapStyleChip: {
    backgroundColor: "rgba(255,255,255,0.95)",
    borderColor: "#cbd5e1",
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  mapStyleChipActive: {
    backgroundColor: "#0f172a",
    borderColor: "#0f172a",
  },
  mapStyleChipText: { color: "#0f172a", fontSize: 12, fontWeight: "700" },
  mapStyleChipTextActive: { color: "#fff" },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  stepChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  stepChipActive: {
    backgroundColor: "#2563eb",
    borderColor: "#1d4ed8",
  },
  stepChipNum: {
    fontSize: 14,
    fontWeight: "800",
    color: "#94a3b8",
    minWidth: 20,
    textAlign: "center",
  },
  stepChipOnPrimary: {
    color: "#fff",
  },
  stepChipLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#64748b",
  },
  stepChipLabelActive: {
    color: "#fff",
  },
  stepConnector: {
    width: 24,
    height: 3,
    backgroundColor: "#cbd5e1",
    borderRadius: 2,
  },
  banner: {
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 12,
    borderRadius: 12,
    fontSize: 15,
    overflow: "hidden",
  },
  driverCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.97)",
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  driverAvatarImg: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#e2e8f0",
  },
  driverAvatarPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  driverCardBody: { flex: 1, minWidth: 0 },
  driverCardName: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
  driverCardMeta: { fontSize: 13, color: "#64748b", marginTop: 2 },
  vehicleThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: "#f1f5f9",
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  addrBox: {
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 10,
    borderRadius: 10,
    gap: 8,
  },
  addrText: { color: "#334155", fontSize: 13 },
  farePreviewText: { color: "#0f172a", fontSize: 14, fontWeight: "700" },
  farePreviewMuted: { color: "#64748b", fontSize: 13 },
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
  timeRow: {
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 10,
    borderRadius: 10,
    gap: 8,
  },
  timeLabel: { color: "#334155", fontSize: 13, fontWeight: "600" },
  timeDropdown: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  timeDropdownValue: { color: "#0f172a", fontSize: 15, fontWeight: "600" },
  timeDropdownChevron: { color: "#64748b", fontSize: 16, fontWeight: "700", marginLeft: 8 },
  timeMenuRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  timeMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15,23,42,0.45)",
  },
  timeMenuSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: Platform.OS === "ios" ? 28 : 20,
    paddingTop: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  timeMenuTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  timeMenuRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
  },
  timeMenuRowActive: { backgroundColor: "#eff6ff" },
  timeMenuRowText: { fontSize: 17, color: "#0f172a", fontWeight: "500" },
  timeMenuRowTextActive: { color: "#1d4ed8", fontWeight: "700" },
  timeMenuCheck: { fontSize: 18, color: "#2563eb", fontWeight: "700" },
  timeMenuCancel: {
    marginTop: 8,
    marginHorizontal: 16,
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: 10,
    backgroundColor: "#f1f5f9",
  },
  timeMenuCancelText: { fontSize: 16, fontWeight: "600", color: "#475569" },
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
