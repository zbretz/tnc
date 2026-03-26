import "react-native-reanimated";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  InteractionManager,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { DropoffBeaconMarker, PickupBeaconMarker, FONT_FAMILY } from "@tnc/shared";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { getApiUrl, getGoogleGeocodingApiKey, getGooglePlacesApiKey } from "./lib/config";
import BottomSheet, { BottomSheetScrollView, BottomSheetTextInput } from "@gorhom/bottom-sheet";

SplashScreen.preventAutoHideAsync().catch(() => {});

const TOKEN_KEY = "tnc_token";

/**
 * Map center when pickup is not set yet. Not a real user location — only fills `initialRegion` until
 * GPS/last-known runs (see planning location effect). SF is a common RN/maps placeholder; you’ll see it
 * briefly if there is no cached location and `getCurrentPositionAsync` is still resolving.
 */
const MAP_FALLBACK_CENTER = { lat: 37.78, lng: -122.4 };

/** @gorhom/bottom-sheet does not support web; keep the legacy column layout there. */
const USE_NATIVE_PLANNING_BOTTOM_SHEET = Platform.OS !== "web";
/** Min (default) / mid / max sheet height. Max capped at ~90% screen; min sized to fit header + field + Set pickup with insets. */
const PLANNING_SNAP_POINTS = ["34%", "62%", "90%"];
/** Book ride: one fixed height — no dragging to expand; fits addresses + ride row + CTA. */
const PLANNING_BOOK_RIDE_SNAP = "58%";
const PLANNING_BOOK_RIDE_SNAP_FRACTION = 0.58;
/** Sheet height as a fraction of window height (gorhom snap points are sheet heights). */
const PLANNING_SNAP_HEIGHT_FRACTIONS = PLANNING_SNAP_POINTS.map((s) => {
  const n = parseFloat(String(s).replace("%", ""), 10);
  return Number.isFinite(n) ? n / 100 : 0.34;
});
/** Native trip summary dock max height vs screen (see `tripBottomDock`). */
const TRIP_BOTTOM_DOCK_MAX_FRACTION = 0.44;
/** Same fraction as snap — keep trip UI inside Gorhom sheet so the sheet never unmounts (avoids iOS native crash). */
const TRIP_NATIVE_SHEET_SNAP = `${Math.round(TRIP_BOTTOM_DOCK_MAX_FRACTION * 100)}%`;
/** Space between locate FAB bottom edge and top edge of bottom sheet / dock. */
const MAP_LOCATE_FAB_SHEET_GAP = 10;
/** Deferred ms before clearing trip state — same path for accepted vs in_progress so complete/cancel never diverge on native teardown. */
const RIDER_TRIP_END_DEFER_MS = 320;
/** Last valid snap index for PLANNING_SNAP_POINTS (dynamic sizing off — indices must stay in range). */
const PLANNING_SNAP_MAX_INDEX = PLANNING_SNAP_POINTS.length - 1;

function clampPlanningSnapIndex(i) {
  const n = typeof i === "number" ? i : Number(i);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, PLANNING_SNAP_MAX_INDEX));
}

function clampPlanningIndexToSnapPoints(i, snapPointCount) {
  const maxIdx = Math.max(0, snapPointCount - 1);
  const n = typeof i === "number" ? i : Number(i);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, maxIdx));
}

const SCREEN_HEIGHT = Dimensions.get("window").height;

function MapCenterSelectionPin({ variant }) {
  const isDrop = variant === "dropoff";
  const fill = isDrop ? "#7c3aed" : "#16a34a";
  const letter = isDrop ? "D" : "P";
  return (
    <View style={centerPinStyles.shadowWrap} pointerEvents="none">
      <View style={[centerPinStyles.head, { backgroundColor: fill, borderColor: "#fff" }]}>
        <Text style={centerPinStyles.letter} allowFontScaling={false}>
          {letter}
        </Text>
      </View>
      <View style={[centerPinStyles.point, { borderTopColor: fill }]} />
    </View>
  );
}

const centerPinStyles = StyleSheet.create({
  shadowWrap: {
    alignItems: "center",
    transform: [{ translateY: -26 }],
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 8,
  },
  head: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    color: "#fff",
    fontSize: 16,
    fontFamily: FONT_FAMILY.plusJakartaExtraBold,
    fontWeight: "normal",
  },
  point: {
    width: 0,
    height: 0,
    marginTop: -4,
    borderLeftWidth: 12,
    borderRightWidth: 12,
    borderTopWidth: 16,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
});

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

function formatPickupInLabel(minutes) {
  if (minutes === 0) return "Pickup now";
  if (minutes === 1) return "Pickup in 1 min";
  return `Pickup in ${minutes} mins`;
}

function formatPickupScheduleSubtitle(minutes, atDate) {
  if (minutes === 0) return "As soon as you're ready";
  try {
    const t = atDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `Around ${t}`;
  } catch {
    return "";
  }
}

/** Padding inside the map pane (map sits above the bottom sheet). */
const MAP_EDGE_PADDING = { top: 96, right: 40, bottom: 72, left: 40 };

function finiteMapCoord(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

/** Extra bottom inset for book ride so pickup + dropoff stay above the planning sheet (height tracks snap). */
function bookRideFitEdgePadding(planningSheetIndex, bookRideSheetLocked) {
  const top = MAP_EDGE_PADDING.top;
  const horizontal = MAP_EDGE_PADDING.right;
  if (!USE_NATIVE_PLANNING_BOTTOM_SHEET) {
    return {
      top,
      right: horizontal,
      left: horizontal,
      bottom: Math.max(
        MAP_EDGE_PADDING.bottom,
        Math.round(SCREEN_HEIGHT * (bookRideSheetLocked ? PLANNING_BOOK_RIDE_SNAP_FRACTION : 0.28)) + 64
      ),
    };
  }
  const frac = bookRideSheetLocked
    ? PLANNING_BOOK_RIDE_SNAP_FRACTION
    : PLANNING_SNAP_HEIGHT_FRACTIONS[clampPlanningSnapIndex(planningSheetIndex)] ?? 0.34;
  return {
    top,
    right: horizontal,
    left: horizontal,
    bottom: Math.round(SCREEN_HEIGHT * frac) + 64,
  };
}

/** Bottom inset when the trip summary sheet covers the map (accepted / in_progress / requested). */
function tripDockFitEdgePadding() {
  const top = MAP_EDGE_PADDING.top;
  const horizontal = MAP_EDGE_PADDING.right;
  const frac = TRIP_BOTTOM_DOCK_MAX_FRACTION;
  /** Extra space above trip sheet (handle + home indicator + locate FAB band). */
  const dockClearance = 88;
  if (!USE_NATIVE_PLANNING_BOTTOM_SHEET) {
    return {
      top,
      right: horizontal,
      left: horizontal,
      bottom: Math.max(MAP_EDGE_PADDING.bottom, Math.round(SCREEN_HEIGHT * frac) + dockClearance),
    };
  }
  return {
    top,
    right: horizontal,
    left: horizontal,
    bottom: Math.round(SCREEN_HEIGHT * frac) + dockClearance,
  };
}

function formatTripEtaLine(prefix, e) {
  return `${prefix}: ${e.durationText || `~${e.summaryMinutes} min`}${e.distanceText ? ` · ${e.distanceText}` : ""}${e.usesTraffic ? " (traffic)" : ""}`;
}

/** Sheet banner for accepted (pickup leg) or in_progress (dropoff leg). */
function riderAcceptedInProgressBannerCopy(trip, driverCoord) {
  const st = trip?.status;
  if (st === "in_progress") {
    if (trip?.etaToDropoff) return formatTripEtaLine("ETA to destination", trip.etaToDropoff);
    if (driverCoord) return "ETA to destination: updating…";
    return "En route to your destination…";
  }
  if (trip?.etaToPickup) {
    return formatTripEtaLine("Driver ETA to pickup", trip.etaToPickup);
  }
  if (driverCoord) return "Driver ETA to pickup: updating…";
  return "Waiting for driver location…";
}

const RIDER_MAP_CHROME_TOP =
  Platform.OS === "ios" ? 52 : Platform.OS === "android" ? 50 : 14;
const RIDER_SETTINGS_TOP =
  Platform.OS === "ios" ? 54 : Platform.OS === "android" ? 54 : 16;

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

function finiteLatLngObject(p) {
  if (p == null || typeof p !== "object") return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Ensure trip.pickup / trip.dropoff are plain finite coords (server JSON can be odd). */
function normalizeTripForClient(t, pickupFallback, dropoffFallback) {
  const pickup = finiteLatLngObject(t?.pickup) ?? pickupFallback;
  const dropoff = finiteLatLngObject(t?.dropoff) ?? dropoffFallback;
  return { ...t, pickup, dropoff };
}

async function reverseGeocodeLabel(point) {
  if (!point) return null;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const apiKey = getGoogleGeocodingApiKey();
  if (apiKey) {
    try {
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
      latitude: lat,
      longitude: lng,
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

function makePlacesSessionToken() {
  const p = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${p()}${p()}-${p()}-4${p().slice(0, 3)}-${p()}-${p()}${p()}${p()}`;
}

/** Google Places Autocomplete (same API key; Places API must be enabled). */
async function fetchPlacePredictions(inputText, sessionToken) {
  const key = getGooglePlacesApiKey();
  if (!key || !inputText || inputText.trim().length < 2) return [];
  try {
    const input = encodeURIComponent(inputText.trim());
    const st = sessionToken ? `&sessiontoken=${encodeURIComponent(sessionToken)}` : "";
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${input}${st}&types=geocode&key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return [];
    const preds = Array.isArray(data.predictions) ? data.predictions : [];
    return preds.slice(0, 8).map((p) => ({
      placeId: p.place_id,
      description: p.description,
      mainText: p.structured_formatting?.main_text || String(p.description || "").split(",")[0].trim(),
      secondaryText: p.structured_formatting?.secondary_text || "",
    }));
  } catch {
    return [];
  }
}

async function resolvePlaceToPoint(placeId, sessionToken) {
  const key = getGooglePlacesApiKey();
  if (!key || !placeId) return null;
  try {
    const st = sessionToken ? `&sessiontoken=${encodeURIComponent(sessionToken)}` : "";
    const fields = encodeURIComponent("geometry/location,formatted_address,address_components");
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${encodeURIComponent(key)}${st}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK" || !data.result?.geometry?.location) return null;
    const loc = data.result.geometry.location;
    const comps = Array.isArray(data.result.address_components) ? data.result.address_components : [];
    const streetNumber = comps.find((c) => c?.types?.includes("street_number"))?.long_name || "";
    const route = comps.find((c) => c?.types?.includes("route"))?.long_name || "";
    const shortStreet = [streetNumber, route].filter(Boolean).join(" ").trim();
    const address =
      shortStreet ||
      String(data.result.formatted_address || "").split(",")[0].trim() ||
      null;
    return {
      point: { lat: Number(loc.lat), lng: Number(loc.lng) },
      address: address || String(data.result.formatted_address || "").split(",")[0].trim() || null,
    };
  } catch {
    return null;
  }
}

export default function App() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

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
  /** Planning: step 1 = pickup, step 2 = dropoff (choose pin/search, then book ride). */
  const [bookingStep, setBookingStep] = useState("pickup");
  /** After map "Select dropoff" or choosing an address — show Request ride, hide search. */
  const [dropoffBookingCommitted, setDropoffBookingCommittedInner] = useState(false);
  /** Updated synchronously with setter so onRegionChangeComplete cannot race React re-render. */
  const dropoffBookingCommittedRef = useRef(false);
  const setDropoffBookingCommitted = useCallback((v) => {
    dropoffBookingCommittedRef.current = v;
    setDropoffBookingCommittedInner(v);
  }, []);
  const [pickupOffsetMinutes, setPickupOffsetMinutes] = useState(0);
  const [pickupTimeMenuOpen, setPickupTimeMenuOpen] = useState(false);
  const pickupTimeOptions = useMemo(() => {
    const now = new Date();
    return PICKUP_TIME_OFFSETS.map((minutes) => {
      if (minutes === 0) {
        return {
          key: "asap",
          minutes,
          label: formatPickupInLabel(0),
          subtitle: formatPickupScheduleSubtitle(0, now),
          preferredPickupAt: null,
        };
      }
      const at = new Date(now.getTime() + minutes * 60 * 1000);
      return {
        key: String(minutes),
        minutes,
        label: formatPickupInLabel(minutes),
        subtitle: formatPickupScheduleSubtitle(minutes, at),
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
    return opt?.label ?? "Pickup now";
  }, [pickupTimeOptions, pickupOffsetMinutes]);

  const [trip, setTrip] = useState(null);
  /** True while we are tearing down the trip dock (ignore stray driver:location / refits). */
  const tripDockClosingRef = useRef(false);
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
  /** Frozen once per trip so MapView `initialRegion` does not track live driver (re-renders would fight gestures). */
  const [tripMapInitialRegion, setTripMapInitialRegion] = useState(null);
  /** Bumped when a ride ends so Gorhom mounts a new BottomSheet instead of swapping trip → planning inside one instance. */
  const [planningDockMountKey, setPlanningDockMountKey] = useState(0);
  /** Bumped on every ride end so Google Maps remounts (same teardown whether trip ended from accepted or in_progress). */
  const [riderMapMountKey, setRiderMapMountKey] = useState(0);
  /** True = entire map + Gorhom tree unmounted; minimal placeholder only (avoids native teardown race on trip end). */
  const [rideInterstitialReset, setRideInterstitialReset] = useState(false);
  /** null | { kind: "loading" } | { kind: "ok", estimate } | { kind: "err" } */
  const [farePreview, setFarePreview] = useState(null);
  const socketRef = useRef(null);
  const tripIdRef = useRef(null);
  const mapRef = useRef(null);
  const driverCoordRef = useRef(null);
  /** Latest trip + endpoints for refit (avoid useCallback deps on `trip` object identity from sockets). */
  const activeTripCameraCtxRef = useRef({ trip: null, displayPickup: null, displayDropoff: null });
  const programmaticMapMoveRef = useRef(false);
  const lastRegionRef = useRef(null);
  const programmaticClearTimerRef = useRef(null);
  const [userLocationCoord, setUserLocationCoord] = useState(null);
  /** While true, map-driven address updates must not overwrite the planning text field. */
  const planFieldFocusedRef = useRef(false);
  const placesSessionRef = useRef("");
  const addressBlurTimerRef = useRef(null);
  /** Shared with MapView tap-to-collapse so we can blur the planning address field. */
  const planAddressInputRef = useRef(null);
  const planningSheetRef = useRef(null);
  /** One-shot refit when live driver coords first arrive (avoid refitting on every driver tick). */
  const activeTripDriverInitialFitRef = useRef(false);
  const planningSheetPrevIndexRef = useRef(0);
  /** Synced each render for onPlanningSheetChange (snap count changes on book ride). */
  const planningSnapPointsRef = useRef(PLANNING_SNAP_POINTS);
  const [planningSheetIndex, setPlanningSheetIndex] = useState(0);
  const [planAddressFieldFocused, setPlanAddressFieldFocused] = useState(false);
  const [addressPredictions, setAddressPredictions] = useState([]);
  const [addressPredictionsLoading, setAddressPredictionsLoading] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);

  /** Full planning reset — same baseline as a fresh “Select pickup” session (used after ride ends + on logout). */
  const resetPlanningToInitialPickup = useCallback(() => {
    Keyboard.dismiss();
    planFieldFocusedRef.current = false;
    setPlanAddressFieldFocused(false);
    if (addressBlurTimerRef.current) {
      clearTimeout(addressBlurTimerRef.current);
      addressBlurTimerRef.current = null;
    }
    setAddressPredictions([]);
    setAddressPredictionsLoading(false);
    planAddressInputRef.current?.blur?.();
    setPickup(null);
    setDropoff(null);
    setPickupAddressLabel(null);
    setDropoffAddressLabel(null);
    setPickupQuery("");
    setDropoffQuery("");
    setDropoffBookingCommitted(false);
    setBookingStep("pickup");
    setPickupOffsetMinutes(0);
    setPickupTimeMenuOpen(false);
    setFarePreview(null);
    setPlanRouteCoords(null);
    setTripRouteCoords(null);
    setPlanningSheetIndex(0);
  }, [setDropoffBookingCommitted]);

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem(TOKEN_KEY);
      setToken(t);
    })();
  }, []);

  useEffect(() => {
    const showEv = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEv = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = (e) => {
      const h = e?.endCoordinates?.height;
      setKeyboardInset(typeof h === "number" && h > 0 ? h : 0);
    };
    const onHide = () => setKeyboardInset(0);
    const subShow = Keyboard.addListener(showEv, onShow);
    const subHide = Keyboard.addListener(hideEv, onHide);
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (addressBlurTimerRef.current) clearTimeout(addressBlurTimerRef.current);
    };
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

  useEffect(() => {
    if (!trip) tripDockClosingRef.current = false;
  }, [trip]);

  /**
   * One path whenever a ride ends. Caller must set `rideInterstitialReset` true first so map + Gorhom fully unmount
   * before we clear `trip`; `finally` always clears the interstitial.
   */
  const returnToPlanningAfterTripEnds = useCallback((opts) => {
    const { matchTripId } = opts || {};
    InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            try {
              if (matchTripId != null && tripIdRef.current !== String(matchTripId)) return;
              setRiderMapMountKey((k) => k + 1);
              resetPlanningToInitialPickup();
              setTrip(null);
              setDriverLive(null);
              setPlanningDockMountKey((k) => k + 1);
            } finally {
              setRideInterstitialReset(false);
            }
          }, RIDER_TRIP_END_DEFER_MS);
        });
      });
    });
  }, [resetPlanningToInitialPickup]);

  const applyIncomingTrip = useCallback((nextTrip) => {
    if (!nextTrip) return;
    if (nextTrip.status === "cancelled" || nextTrip.status === "completed") {
      setTripRouteCoords(null);
      if (tripDockClosingRef.current) return;
      tripDockClosingRef.current = true;
      setRideInterstitialReset(true);
      returnToPlanningAfterTripEnds({ matchTripId: nextTrip._id });
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
  }, [returnToPlanningAfterTripEnds]);

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
      if (tripDockClosingRef.current) return;
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
    if (bookingStep !== "dropoff" || !pickup || !dropoff) {
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
  }, [token, trip, bookingStep, pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng]);

  useEffect(() => {
    if (!token || trip || bookingStep !== "dropoff" || !dropoffBookingCommitted || !pickup || !dropoff) {
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
  }, [token, trip, bookingStep, dropoffBookingCommitted, pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng]);

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

  const markProgrammaticMapMove = useCallback(() => {
    programmaticMapMoveRef.current = true;
    if (programmaticClearTimerRef.current) clearTimeout(programmaticClearTimerRef.current);
    programmaticClearTimerRef.current = setTimeout(() => {
      programmaticMapMoveRef.current = false;
      programmaticClearTimerRef.current = null;
    }, 900);
  }, []);

  const animateMapToPoint = useCallback(
    (c) => {
      markProgrammaticMapMove();
      mapRef.current?.animateToRegion(
        {
          latitude: c.lat,
          longitude: c.lng,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        },
        400
      );
    },
    [markProgrammaticMapMove]
  );

  const onMapRegionChangeComplete = useCallback(
    (r) => {
      lastRegionRef.current = r;
      if (trip) return;
      if (programmaticMapMoveRef.current) {
        programmaticMapMoveRef.current = false;
        if (programmaticClearTimerRef.current) {
          clearTimeout(programmaticClearTimerRef.current);
          programmaticClearTimerRef.current = null;
        }
        return;
      }
      const lat = r.latitude;
      const lng = r.longitude;
      if (bookingStep === "pickup") {
        setPickup((prev) => (prev?.lat === lat && prev?.lng === lng ? prev : { lat, lng }));
        setPickupAddressLabel(null);
      } else {
        if (dropoffBookingCommittedRef.current) return;
        setDropoff((prev) => (prev?.lat === lat && prev?.lng === lng ? prev : { lat, lng }));
        setDropoffAddressLabel(null);
      }
    },
    [trip, bookingStep]
  );

  /** Seed dropoff from map center (pin) and move to dropoff step — replaces the old Continue button. */
  const advanceToDropoffStep = useCallback((fallbackCenter) => {
    const r = lastRegionRef.current;
    if (r) {
      setDropoff({ lat: r.latitude, lng: r.longitude });
    } else if (fallbackCenter?.lat != null && fallbackCenter?.lng != null) {
      setDropoff({ lat: fallbackCenter.lat, lng: fallbackCenter.lng });
    }
    setDropoffAddressLabel(null);
    setDropoffBookingCommitted(false);
    setBookingStep("dropoff");
  }, []);

  const canConfirmPickup = useMemo(
    () =>
      Boolean(pickup) &&
      typeof pickupAddressLabel === "string" &&
      pickupAddressLabel.trim().length > 0,
    [pickup, pickupAddressLabel]
  );

  const onPressSetPickup = useCallback(() => {
    if (!canConfirmPickup || !pickup) return;
    Keyboard.dismiss();
    planAddressInputRef.current?.blur?.();
    setPlanAddressFieldFocused(false);
    setAddressPredictions([]);
    setAddressPredictionsLoading(false);
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
      setPlanningSheetIndex(0);
      planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0));
    }
    advanceToDropoffStep(pickup);
  }, [canConfirmPickup, pickup, advanceToDropoffStep]);

  /** Leave dropoff: clear destination, reset pickup, return to pickup step, re-center on GPS (or fallback). */
  const goBackFromDropoffToResetPickup = useCallback(async () => {
    if (addressBlurTimerRef.current) {
      clearTimeout(addressBlurTimerRef.current);
      addressBlurTimerRef.current = null;
    }
    planFieldFocusedRef.current = false;
    Keyboard.dismiss();
    planAddressInputRef.current?.blur?.();
    setPlanAddressFieldFocused(false);
    setAddressPredictions([]);
    setAddressPredictionsLoading(false);
    setDropoff(null);
    setDropoffAddressLabel(null);
    setDropoffQuery("");
    setPickup(null);
    setPickupAddressLabel(null);
    setPickupQuery("");
    setFarePreview(null);
    setDropoffBookingCommitted(false);
    setBookingStep("pickup");
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
      setPlanningSheetIndex(0);
      requestAnimationFrame(() => planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0)));
    }
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        animateMapToPoint({ lat: MAP_FALLBACK_CENTER.lat, lng: MAP_FALLBACK_CENTER.lng });
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const c = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setPickup(c);
      setPickupAddressLabel(null);
      animateMapToPoint(c);
    } catch {
      animateMapToPoint({ lat: MAP_FALLBACK_CENTER.lat, lng: MAP_FALLBACK_CENTER.lng });
    }
  }, [animateMapToPoint]);

  /** From book ride: return to adjusting dropoff (map or search) without resetting pickup. */
  const goBackFromBookRideToDropoffSelection = useCallback(() => {
    if (addressBlurTimerRef.current) {
      clearTimeout(addressBlurTimerRef.current);
      addressBlurTimerRef.current = null;
    }
    planFieldFocusedRef.current = false;
    Keyboard.dismiss();
    planAddressInputRef.current?.blur?.();
    setPlanAddressFieldFocused(false);
    setAddressPredictions([]);
    setAddressPredictionsLoading(false);
    setDropoffBookingCommitted(false);
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
      setPlanningSheetIndex(0);
      requestAnimationFrame(() => planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0)));
    }
  }, []);

  /** Book ride: edit pickup — full pickup selector (clears dropoff leg). */
  const onPressBookRideEditPickup = useCallback(() => {
    if (addressBlurTimerRef.current) {
      clearTimeout(addressBlurTimerRef.current);
      addressBlurTimerRef.current = null;
    }
    planFieldFocusedRef.current = false;
    Keyboard.dismiss();
    planAddressInputRef.current?.blur?.();
    setPlanAddressFieldFocused(false);
    setAddressPredictions([]);
    setAddressPredictionsLoading(false);
    setDropoffBookingCommitted(false);
    setDropoff(null);
    setDropoffAddressLabel(null);
    setDropoffQuery("");
    setFarePreview(null);
    setBookingStep("pickup");
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
      setPlanningSheetIndex(0);
      requestAnimationFrame(() => planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0)));
    }
  }, []);

  /** Map path: pin shows dropoff — commit and move to Request ride step. */
  const onPressSelectDropoffFromMap = useCallback(() => {
    if (!pickup || !dropoff) return;
    if (![pickup.lat, pickup.lng, dropoff.lat, dropoff.lng].every((n) => Number.isFinite(Number(n)))) return;
    Keyboard.dismiss();
    planAddressInputRef.current?.blur?.();
    setPlanAddressFieldFocused(false);
    setAddressPredictions([]);
    setAddressPredictionsLoading(false);
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
      setPlanningSheetIndex(0);
      planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0));
    }
    setDropoffBookingCommitted(true);
  }, [pickup, dropoff]);

  /** Tap map while planning: dismiss keyboard, hide suggestions, and optionally advance pickup → dropoff. */
  const onPlanningMapPress = useCallback(() => {
    if (trip) return;
    if (addressBlurTimerRef.current) {
      clearTimeout(addressBlurTimerRef.current);
      addressBlurTimerRef.current = null;
    }
    planFieldFocusedRef.current = false;
    Keyboard.dismiss();
    planAddressInputRef.current?.blur?.();
    setPlanAddressFieldFocused(false);
    setAddressPredictions([]);
    setAddressPredictionsLoading(false);
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
      setPlanningSheetIndex(0);
      planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0));
    }

    const labelReady =
      typeof pickupAddressLabel === "string" && pickupAddressLabel.trim().length > 0;
    if (bookingStep === "pickup" && pickup && labelReady) {
      advanceToDropoffStep(pickup);
    }
  }, [trip, bookingStep, pickup, pickupAddressLabel, advanceToDropoffStep]);

  /** Logged-in planning screen: default pickup = device location, map centered (no trip). */
  const activeTripId = trip?._id;
  useEffect(() => {
    if (!token || activeTripId) return;
    let cancelled = false;
    const applyCoords = (lat, lng) => {
      const c = { lat, lng };
      setPickup(c);
      setPickupAddressLabel(null);
      setBookingStep("pickup");
      requestAnimationFrame(() => {
        if (!cancelled) animateMapToPoint(c);
      });
    };
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled || status !== "granted") return;

        try {
          const last = await Location.getLastKnownPositionAsync({ maxAge: 600_000 });
          if (!cancelled && last?.coords) {
            applyCoords(last.coords.latitude, last.coords.longitude);
          }
        } catch {
          /* no cache yet */
        }

        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        applyCoords(loc.coords.latitude, loc.coords.longitude);
      } catch {
        /* no fix: map stays on MAP_FALLBACK_CENTER until user moves pin or grants location later */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, activeTripId, animateMapToPoint]);

  /** Blue beacon for your GPS position while choosing pickup/dropoff (not shown during an active trip). */
  useEffect(() => {
    if (!token || trip) {
      setUserLocationCoord(null);
      return;
    }
    let sub;
    let alive = true;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!alive || status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (alive && loc?.coords) {
          setUserLocationCoord({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        }
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 12, timeInterval: 5000 },
          (l) => {
            setUserLocationCoord({
              latitude: l.coords.latitude,
              longitude: l.coords.longitude,
            });
          }
        );
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
      sub?.remove();
    };
  }, [token, trip?._id]);

  const logout = async () => {
    await AsyncStorage.removeItem(TOKEN_KEY);
    setRideInterstitialReset(false);
    setToken(null);
    setTrip(null);
    setDriverLive(null);
    resetPlanningToInitialPickup();
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
    const puLat = Number(pickup.lat);
    const puLng = Number(pickup.lng);
    const doLat = Number(dropoff.lat);
    const doLng = Number(dropoff.lng);
    if (![puLat, puLng, doLat, doLng].every((n) => Number.isFinite(n))) {
      Alert.alert("Trip setup", "Pickup and dropoff need valid map locations. Try editing the addresses.");
      return;
    }
    setBusy(true);
    let clearBusyInFinally = true;
    try {
      if (__DEV__) console.warn("[tnc rider] requestRide: start (geocode + POST)");
      const pickupForGeo = { lat: puLat, lng: puLng };
      const dropoffForGeo = { lat: doLat, lng: doLng };
      const [pickupAddress, dropoffAddress] = await Promise.all([
        pickupAddressLabel || reverseGeocodeLabel(pickupForGeo),
        dropoffAddressLabel || reverseGeocodeLabel(dropoffForGeo),
      ]);
      const body = {
        pickup: { lat: puLat, lng: puLng },
        pickupOffsetMinutes,
        preferredPickupAt,
        ...(pickupAddress ? { pickupAddress } : {}),
        dropoff: { lat: doLat, lng: doLng },
        ...(dropoffAddress ? { dropoffAddress } : {}),
      };
      const data = await api("/trips", {
        method: "POST",
        token,
        body,
      });
      const t = data?.trip;
      if (!t || typeof t !== "object" || t._id == null) {
        Alert.alert("Request failed", "Server did not return a trip. Try again.");
        return;
      }
      const normalized = normalizeTripForClient(t, pickupForGeo, dropoffForGeo);
      clearBusyInFinally = false;
      if (__DEV__) console.warn("[tnc rider] requestRide: POST ok, scheduling setTrip (after interactions + rAF)");
      /** Unmounting Gorhom BottomSheet in the same tick as the Book CTA often crashes native (gesture handler). */
      InteractionManager.runAfterInteractions(() => {
        if (__DEV__) console.warn("[tnc rider] requestRide: InteractionManager callback");
        requestAnimationFrame(() => {
          if (__DEV__) console.warn("[tnc rider] requestRide: calling setTrip now");
          setTrip(normalized);
          setDriverLive(null);
          setBusy(false);
          if (__DEV__) console.warn("[tnc rider] requestRide: setTrip dispatched");
        });
      });
    } catch (e) {
      Alert.alert("Request failed", e?.message ? String(e.message) : String(e));
    } finally {
      if (clearBusyInFinally) setBusy(false);
    }
  };

  /** Testing: cancel the trip on the server and reset local trip state. */
  const clearRide = async () => {
    const t = trip;
    if (!t) return;
    if (["completed", "cancelled"].includes(t.status)) {
      if (!tripDockClosingRef.current) {
        tripDockClosingRef.current = true;
        setRideInterstitialReset(true);
        returnToPlanningAfterTripEnds();
      }
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
      if (!tripDockClosingRef.current) {
        tripDockClosingRef.current = true;
        setRideInterstitialReset(true);
        returnToPlanningAfterTripEnds();
      }
    } catch (e) {
      Alert.alert("Clear ride failed", e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const displayPickup = trip?.pickup || pickup;
  const displayDropoff = trip?.dropoff || dropoff;
  activeTripCameraCtxRef.current = { trip, displayPickup, displayDropoff };
  /** Normalized coords for Marker (avoids string/invalid values; stable key for remount after fit). */
  const dropoffMarkerCoord = useMemo(() => {
    const d = trip?.dropoff || dropoff;
    if (!d) return null;
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { latitude: lat, longitude: lng };
  }, [trip?.dropoff?.lat, trip?.dropoff?.lng, dropoff?.lat, dropoff?.lng]);

  const pickupMarkerCoord = useMemo(() => {
    const p = displayPickup;
    if (!p) return null;
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { latitude: lat, longitude: lng };
  }, [displayPickup?.lat, displayPickup?.lng]);
  const tripRequested = trip?.status === "requested";
  /** Dropoff chosen (map button or address pick) — book-ride phase with Request ride. */
  const planningDropoffConfirmed = !trip && bookingStep === "dropoff" && dropoffBookingCommitted;
  /** Pan/zoom/rotate only during pickup / select-dropoff; book-ride is view-only. */
  const planningMapGesturesEnabled = !trip && !planningDropoffConfirmed;

  /** Tighter scroll padding while still choosing dropoff (before commit). */
  const dropoffMinimalSheet = !trip && bookingStep === "dropoff" && !planningDropoffConfirmed;
  const showPlanningSheetHeader = bookingStep === "pickup" || bookingStep === "dropoff";
  const planningSheetTitle =
    bookingStep === "pickup" ? "Select pickup" : planningDropoffConfirmed ? "Book ride" : "Select dropoff";

  /** Native: collapsed = lowest snap. Web: treat focused search as “open” (hide Change pickup). */
  const selectDropoffSheetCollapsed =
    !USE_NATIVE_PLANNING_BOTTOM_SHEET || clampPlanningSnapIndex(planningSheetIndex) === 0;
  const showSelectDropoffChangePickup =
    bookingStep === "dropoff" &&
    !planningDropoffConfirmed &&
    (USE_NATIVE_PLANNING_BOTTOM_SHEET
      ? selectDropoffSheetCollapsed
      : !planAddressFieldFocused);

  /** Hide reset-location FAB when planning sheet is fully expanded (top snap). */
  const hidePlanningLocateFab =
    USE_NATIVE_PLANNING_BOTTOM_SHEET &&
    !trip &&
    !planningDropoffConfirmed &&
    clampPlanningSnapIndex(planningSheetIndex) === PLANNING_SNAP_MAX_INDEX;

  /** Always length 3 — gorhom is unstable when snap count changes; trip mode reuses the same BottomSheet instance. */
  const nativePlanningSheetSnapPoints = useMemo(() => {
    if (trip) {
      return [TRIP_NATIVE_SHEET_SNAP, TRIP_NATIVE_SHEET_SNAP, TRIP_NATIVE_SHEET_SNAP];
    }
    if (planningDropoffConfirmed) {
      return [PLANNING_BOOK_RIDE_SNAP, PLANNING_BOOK_RIDE_SNAP, PLANNING_BOOK_RIDE_SNAP];
    }
    return PLANNING_SNAP_POINTS;
  }, [trip, planningDropoffConfirmed]);
  planningSnapPointsRef.current = nativePlanningSheetSnapPoints;

  const planningDropoffHasBothCoords =
    !trip &&
    bookingStep === "dropoff" &&
    displayPickup &&
    displayDropoff &&
    [displayPickup.lat, displayPickup.lng, displayDropoff.lat, displayDropoff.lng].every((n) =>
      Number.isFinite(Number(n))
    );

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
    if (planningDropoffHasBothCoords) {
      const p = displayPickup;
      const d = displayDropoff;
      const chord = [
        { latitude: p.lat, longitude: p.lng },
        { latitude: d.lat, longitude: d.lng },
      ];
      return planRouteCoords?.length >= 2 ? planRouteCoords : chord;
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
    planningDropoffHasBothCoords,
    displayPickup?.lat,
    displayPickup?.lng,
    displayDropoff?.lat,
    displayDropoff?.lng,
    trip?.driverLocation?.lat,
    trip?.driverLocation?.lng,
    driverLive?.lat,
    driverLive?.lng,
    planRouteCoords,
    bookingStep,
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
      setPickupQuery(out.address || q);
      markProgrammaticMapMove();
      mapRef.current?.animateToRegion(
        {
          latitude: out.point.lat,
          longitude: out.point.lng,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        },
        450
      );
      advanceToDropoffStep(out.point);
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
      setDropoffQuery(out.address || q);
      markProgrammaticMapMove();
      mapRef.current?.animateToRegion(
        {
          latitude: out.point.lat,
          longitude: out.point.lng,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        },
        450
      );
      setDropoffBookingCommitted(true);
      if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
        setPlanningSheetIndex(0);
        planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0));
      }
    } finally {
      setResolvingDropoff(false);
    }
  };

  useEffect(() => {
    if (trip || !pickup) return;
    let cancelled = false;
    const t = setTimeout(() => {
      (async () => {
        const label = await reverseGeocodeLabel(pickup);
        if (!cancelled) setPickupAddressLabel(label);
      })();
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pickup?.lat, pickup?.lng, trip?._id]);

  useEffect(() => {
    if (trip || !dropoff || dropoffAddressLabel) return;
    let cancelled = false;
    const t = setTimeout(() => {
      (async () => {
        const label = await reverseGeocodeLabel(dropoff);
        if (!cancelled) setDropoffAddressLabel(label);
      })();
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [dropoff?.lat, dropoff?.lng, dropoffAddressLabel, trip?._id]);

  /** Keep the single planning field in sync with reverse geocode unless the user is editing it. */
  useEffect(() => {
    if (trip || bookingStep !== "pickup") return;
    if (planFieldFocusedRef.current) return;
    setPickupQuery(pickupAddressLabel ?? "");
  }, [trip, bookingStep, pickupAddressLabel]);

  useEffect(() => {
    if (trip || bookingStep !== "dropoff") return;
    if (planFieldFocusedRef.current) return;
    setDropoffQuery(dropoffAddressLabel ?? "");
  }, [trip, bookingStep, dropoffAddressLabel]);

  useEffect(() => {
    setAddressPredictions([]);
  }, [bookingStep]);

  useEffect(() => {
    if (!USE_NATIVE_PLANNING_BOTTOM_SHEET || trip) return;
    setPlanningSheetIndex(0);
    planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0));
  }, [bookingStep, trip]);

  /** Book ride uses a single snap — force index 0 when entering that step. */
  useEffect(() => {
    if (!USE_NATIVE_PLANNING_BOTTOM_SHEET || trip) return;
    if (!planningDropoffConfirmed) return;
    setPlanningSheetIndex(0);
    requestAnimationFrame(() => {
      planningSheetRef.current?.snapToIndex(0);
    });
  }, [planningDropoffConfirmed, trip]);

  const onPlanningSheetChange = useCallback((idx) => {
    const pts = planningSnapPointsRef.current;
    const maxIdx = Math.max(0, pts.length - 1);
    const safe = clampPlanningIndexToSnapPoints(idx, pts.length);
    setPlanningSheetIndex(safe);
    const prev = planningSheetPrevIndexRef.current;
    planningSheetPrevIndexRef.current = safe;
    if (prev === maxIdx && safe < maxIdx) {
      if (addressBlurTimerRef.current) {
        clearTimeout(addressBlurTimerRef.current);
        addressBlurTimerRef.current = null;
      }
      planFieldFocusedRef.current = false;
      Keyboard.dismiss();
      planAddressInputRef.current?.blur?.();
      setPlanAddressFieldFocused(false);
      setAddressPredictions([]);
      setAddressPredictionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (trip || !planAddressFieldFocused) {
      setAddressPredictionsLoading(false);
      return;
    }
    const raw = bookingStep === "pickup" ? pickupQuery : dropoffQuery;
    const q = raw.trim();
    if (q.length < 2) {
      setAddressPredictions([]);
      setAddressPredictionsLoading(false);
      return;
    }
    if (!getGooglePlacesApiKey()) {
      setAddressPredictions([]);
      setAddressPredictionsLoading(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      setAddressPredictionsLoading(true);
      try {
        const preds = await fetchPlacePredictions(q, placesSessionRef.current);
        if (!cancelled) {
          setAddressPredictions(preds);
        }
      } finally {
        if (!cancelled) setAddressPredictionsLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pickupQuery, dropoffQuery, bookingStep, planAddressFieldFocused, trip]);

  const onPlanAddressFocus = useCallback(() => {
    if (addressBlurTimerRef.current) {
      clearTimeout(addressBlurTimerRef.current);
      addressBlurTimerRef.current = null;
    }
    placesSessionRef.current = makePlacesSessionToken();
    planFieldFocusedRef.current = true;
    setPlanAddressFieldFocused(true);
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET && !trip) {
      const top = clampPlanningSnapIndex(PLANNING_SNAP_MAX_INDEX);
      setPlanningSheetIndex(top);
      requestAnimationFrame(() => planningSheetRef.current?.snapToIndex(top));
    }
  }, [trip]);

  const onPlanAddressBlur = useCallback(() => {
    planFieldFocusedRef.current = false;
    if (addressBlurTimerRef.current) clearTimeout(addressBlurTimerRef.current);
    addressBlurTimerRef.current = setTimeout(() => {
      setPlanAddressFieldFocused(false);
      setAddressPredictions([]);
      addressBlurTimerRef.current = null;
      if (USE_NATIVE_PLANNING_BOTTOM_SHEET && !trip) {
        setPlanningSheetIndex(0);
        planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0));
      }
    }, 220);
  }, [trip]);

  const applyPlacePrediction = useCallback(
    async (pred, isPickup) => {
      Keyboard.dismiss();
      setAddressPredictions([]);
      setAddressPredictionsLoading(false);
      const setBusy = isPickup ? setResolvingPickup : setResolvingDropoff;
      setBusy(true);
      try {
        const out = await resolvePlaceToPoint(pred.placeId, placesSessionRef.current);
        placesSessionRef.current = makePlacesSessionToken();
        if (!out?.point) {
          Alert.alert(
            isPickup ? "Pickup address" : "Dropoff address",
            getGooglePlacesApiKey()
              ? "Could not open that place. Try keyboard search or another suggestion."
              : "Add EXPO_PUBLIC_GOOGLE_GEOCODING_API_KEY and enable Places API on the key."
          );
          return;
        }
        const line = out.address || pred.mainText || pred.description;
        if (isPickup) {
          setPickup(out.point);
          setPickupAddressLabel(line);
          setPickupQuery(line);
        } else {
          setDropoff(out.point);
          setDropoffAddressLabel(line);
          setDropoffQuery(line);
          setDropoffBookingCommitted(true);
          if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
            setPlanningSheetIndex(0);
            planningSheetRef.current?.snapToIndex(clampPlanningSnapIndex(0));
          }
        }
        markProgrammaticMapMove();
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
        setBusy(false);
      }
    },
    [markProgrammaticMapMove]
  );

  const driverCoord =
    driverLive ||
    (trip?.driverLocation
      ? { lat: trip.driverLocation.lat, lng: trip.driverLocation.lng }
      : null);
  driverCoordRef.current = driverCoord;

  const region = useMemo(() => {
    const finitePt = (pt) =>
      pt && Number.isFinite(Number(pt.lat)) && Number.isFinite(Number(pt.lng));
    const p = finitePt(displayPickup) ? displayPickup : MAP_FALLBACK_CENTER;
    const d = finitePt(displayDropoff) ? displayDropoff : null;
    const driverOK = finitePt(driverCoord) ? driverCoord : null;

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

    if (trip && driverOK && trip.status === "accepted") {
      return {
        latitude: (p.lat + driverOK.lat) / 2,
        longitude: (p.lng + driverOK.lng) / 2,
        latitudeDelta: spanAB(p, driverOK),
        longitudeDelta: spanAB(p, driverOK),
      };
    }
    if (trip && driverOK && trip.status === "in_progress" && d) {
      return {
        latitude: (d.lat + driverOK.lat) / 2,
        longitude: (d.lng + driverOK.lng) / 2,
        latitudeDelta: spanAB(d, driverOK),
        longitudeDelta: spanAB(d, driverOK),
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

  const tripMapSeedKey = trip?._id != null ? String(trip._id) : null;
  useLayoutEffect(() => {
    if (!tripMapSeedKey) {
      setTripMapInitialRegion(null);
      return;
    }
    setTripMapInitialRegion({
      latitude: region.latitude,
      longitude: region.longitude,
      latitudeDelta: region.latitudeDelta,
      longitudeDelta: region.longitudeDelta,
    });
    // Intentionally only trip id: `region` updates every driver ping and would keep resetting native camera.
  }, [tripMapSeedKey]);

  useEffect(() => {
    if (trip) return;
    lastRegionRef.current = {
      latitude: region.latitude,
      longitude: region.longitude,
      latitudeDelta: region.latitudeDelta,
      longitudeDelta: region.longitudeDelta,
    };
  }, [trip, region.latitude, region.longitude, region.latitudeDelta, region.longitudeDelta]);

  /**
   * Fit camera for active trip: requested → pickup+dropoff; accepted → pickup+driver (or P+D until location);
   * in_progress → dropoff+driver. Uses trip-dock edge padding and numeric coords for Google Maps.
   */
  const refitActiveTripCamera = useCallback(() => {
    if (tripDockClosingRef.current) return;
    const { trip: t, displayPickup: p, displayDropoff: d } = activeTripCameraCtxRef.current;
    if (!t || !mapRef.current) return;
    const st = t.status;
    if (!["requested", "accepted", "in_progress"].includes(st)) return;

    const pLL = p ? finiteMapCoord(p.lat, p.lng) : null;
    const dLL = d ? finiteMapCoord(d.lat, d.lng) : null;
    const drv = driverCoordRef.current;
    const drvLL = drv ? finiteMapCoord(drv.lat, drv.lng) : null;

    let coords = null;
    if (st === "requested") {
      if (pLL && dLL) coords = [pLL, dLL];
    } else if (st === "accepted") {
      if (drvLL && pLL) coords = [pLL, drvLL];
      else if (pLL && dLL) coords = [pLL, dLL];
    } else if (st === "in_progress") {
      if (drvLL && dLL) coords = [dLL, drvLL];
      else if (pLL && dLL) coords = [pLL, dLL];
    }
    if (!coords || coords.length < 2) return;

    markProgrammaticMapMove();
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: tripDockFitEdgePadding(),
      animated: true,
    });
  }, [markProgrammaticMapMove]);

  useEffect(() => {
    activeTripDriverInitialFitRef.current = false;
  }, [trip?._id]);

  useEffect(() => {
    if (!trip) return;
    if (!["requested", "accepted", "in_progress"].includes(trip.status)) return;

    const run = () => refitActiveTripCamera();
    const t1 = setTimeout(run, 100);
    const t2 = setTimeout(run, 400);
    const t3 = setTimeout(run, 850);
    const t4 = setTimeout(run, 1400);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [trip?._id, trip?.status, displayPickup?.lat, displayPickup?.lng, displayDropoff?.lat, displayDropoff?.lng]);

  /** Driver location streams continuously; refitting on every tick fights map gestures. */
  useEffect(() => {
    if (!trip || !["accepted", "in_progress"].includes(trip.status)) return;
    if (activeTripDriverInitialFitRef.current) return;
    const ok =
      driverCoord &&
      Number.isFinite(Number(driverCoord.lat)) &&
      Number.isFinite(Number(driverCoord.lng));
    if (!ok) return;
    activeTripDriverInitialFitRef.current = true;
    refitActiveTripCamera();
  }, [trip?._id, trip?.status, driverCoord?.lat, driverCoord?.lng]);

  /** Book ride (trip review): fit pickup + dropoff; pad bottom by sheet height; refit after layout. */
  useEffect(() => {
    if (trip) return;
    if (bookingStep !== "dropoff" || !dropoffBookingCommitted) return;
    if (!pickup || !dropoff) return;
    if (![pickup.lat, pickup.lng, dropoff.lat, dropoff.lng].every((n) => Number.isFinite(Number(n)))) return;

    const coords = [
      { latitude: Number(pickup.lat), longitude: Number(pickup.lng) },
      { latitude: Number(dropoff.lat), longitude: Number(dropoff.lng) },
    ];

    const runFit = () => {
      markProgrammaticMapMove();
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: bookRideFitEdgePadding(planningSheetIndex, planningDropoffConfirmed),
        animated: true,
      });
    };

    const t1 = setTimeout(runFit, 180);
    const t2 = setTimeout(runFit, 640);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [
    trip,
    bookingStep,
    dropoffBookingCommitted,
    planningDropoffConfirmed,
    planningSheetIndex,
    pickup?.lat,
    pickup?.lng,
    dropoff?.lat,
    dropoff?.lng,
    markProgrammaticMapMove,
  ]);

  const ridersPaused = !riderService.driversAvailable;
  const showRidersClosedGate = token && !trip && ridersPaused;
  /** Shrink map + give the sheet more flex while the address field is focused and keyboard is up. */
  const addressSheetKeyboardLift =
    keyboardInset > 0 && !trip && planAddressFieldFocused;
  /** Keep the sheet above the keyboard on iOS until the keyboard fully dismisses (avoids a gap on blur). */
  const iosKeyboardSheetMargin = keyboardInset > 0 && !trip && Platform.OS === "ios";

  const mapWrapperStyle = USE_NATIVE_PLANNING_BOTTOM_SHEET
    ? styles.mapLayer
    : [styles.mapArea, !trip && addressSheetKeyboardLift ? styles.mapAreaWhenKeyboard : null].filter(Boolean);

  /** Sit the locate control just above the planning bottom sheet (native) or above the web panel (fixed inset). */
  const mapLocateFabBottomStyle = useMemo(() => {
    if (USE_NATIVE_PLANNING_BOTTOM_SHEET) {
      if (!trip) {
        const frac = planningDropoffConfirmed
          ? PLANNING_BOOK_RIDE_SNAP_FRACTION
          : PLANNING_SNAP_HEIGHT_FRACTIONS[clampPlanningSnapIndex(planningSheetIndex)] ?? 0.34;
        return { bottom: SCREEN_HEIGHT * frac + MAP_LOCATE_FAB_SHEET_GAP };
      }
      if (trip) {
        return { bottom: SCREEN_HEIGHT * TRIP_BOTTOM_DOCK_MAX_FRACTION + MAP_LOCATE_FAB_SHEET_GAP };
      }
    }
    return { bottom: 14 };
  }, [trip, trip?.status, planningSheetIndex, planningDropoffConfirmed]);

  if (!fontsLoaded) return null;

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

  if (rideInterstitialReset) {
    return (
      <View style={styles.container}>
        <StatusBar style="dark" />
        <View style={styles.rideInterstitialRoot}>
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.rideInterstitialText}>Finishing ride…</Text>
        </View>
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
      <Pressable
        style={styles.settingsTopBtn}
        onPress={() =>
          Alert.alert("Account", undefined, [
            { text: "Cancel", style: "cancel" },
            { text: "Log out", style: "destructive", onPress: () => void logout() },
          ])
        }
        accessibilityRole="button"
        accessibilityLabel="Settings and account"
        hitSlop={6}
      >
        <Ionicons name="settings-outline" size={22} color="#334155" />
      </Pressable>
      {!trip ? (
        <Modal
          visible={pickupTimeMenuOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setPickupTimeMenuOpen(false)}
        >
          <View style={styles.timeMenuRoot}>
            <Pressable style={styles.timeMenuBackdrop} onPress={() => setPickupTimeMenuOpen(false)} />
            <View style={styles.timeMenuSheet}>
              <View style={styles.timeMenuHandle} />
              <Text style={styles.timeMenuTitle}>When to pick you up</Text>
              <Text style={styles.timeMenuLead}>Tap an option — we'll match you with a driver for that time.</Text>
              <View style={styles.timeMenuOptions}>
                {pickupTimeOptions.map((opt) => {
                  const active = pickupOffsetMinutes === opt.minutes;
                  return (
                    <Pressable
                      key={opt.key}
                      style={[styles.timeMenuCard, active && styles.timeMenuCardActive]}
                      onPress={() => {
                        setPickupOffsetMinutes(opt.minutes);
                        setPickupTimeMenuOpen(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={opt.label}
                      accessibilityHint={opt.subtitle}
                    >
                      <View
                        style={[
                          styles.timeMenuIconCircle,
                          active && styles.timeMenuIconCircleActive,
                        ]}
                      >
                        <Ionicons
                          name={opt.minutes === 0 ? "flash-outline" : "alarm-outline"}
                          size={22}
                          color={active ? "#1d4ed8" : "#64748b"}
                        />
                      </View>
                      <View style={styles.timeMenuCardTextCol}>
                        <Text style={[styles.timeMenuCardTitle, active && styles.timeMenuCardTitleActive]}>
                          {opt.label}
                        </Text>
                        {opt.subtitle ? (
                          <Text style={[styles.timeMenuCardSub, active && styles.timeMenuCardSubActive]}>
                            {opt.subtitle}
                          </Text>
                        ) : null}
                      </View>
                      {active ? (
                        <Ionicons name="checkmark-circle" size={26} color="#2563eb" style={styles.timeMenuCheckIcon} />
                      ) : (
                        <View style={styles.timeMenuRadioOuter} />
                      )}
                    </Pressable>
                  );
                })}
              </View>
              <Pressable style={styles.timeMenuCancel} onPress={() => setPickupTimeMenuOpen(false)}>
                <Text style={styles.timeMenuCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
      <View style={mapWrapperStyle}>
        {riderService.fareFreeEnabled ? (
          <View style={styles.mapStyleBar} pointerEvents="box-none">
            <FreeRideBanner onPressWhy={() => setFreeRideWhyOpen(true)} />
          </View>
        ) : null}
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <MapView
            key={`rmap-${riderMapMountKey}`}
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            provider={PROVIDER_GOOGLE}
            initialRegion={trip ? tripMapInitialRegion ?? region : region}
            onMapReady={() => {
              if (trip) refitActiveTripCamera();
            }}
            onRegionChangeComplete={onMapRegionChangeComplete}
            onPress={planningMapGesturesEnabled ? onPlanningMapPress : undefined}
            scrollEnabled={trip || planningMapGesturesEnabled}
            zoomEnabled={trip || planningMapGesturesEnabled}
            rotateEnabled={trip || planningMapGesturesEnabled}
            pitchEnabled={trip || planningMapGesturesEnabled}
          >
            {mapRouteCoords.length >= 2 ? (
              <Polyline coordinates={mapRouteCoords} strokeColor="#7c3aed" strokeWidth={4} zIndex={0} />
            ) : null}
            {userLocationCoord && !trip ? (
              <Marker coordinate={userLocationCoord} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={1}>
                <View style={styles.userLocationBeacon} collapsable={false}>
                  <View style={styles.userLocationCore} />
                </View>
              </Marker>
            ) : null}
            {pickupMarkerCoord &&
            (!trip || trip.status !== "in_progress") &&
            (trip || bookingStep === "dropoff") ? (
              tripRequested ? (
                <Marker coordinate={pickupMarkerCoord} title="Pickup" pinColor="#16a34a" />
              ) : (
                <PickupBeaconMarker
                  coordinate={pickupMarkerCoord}
                  title="Pickup"
                  zIndex={2}
                />
              )
            ) : null}
            {dropoffMarkerCoord && (trip || planningDropoffConfirmed) ? (
              tripRequested ? (
                <Marker coordinate={dropoffMarkerCoord} title="Dropoff" pinColor="#7c3aed" />
              ) : (
                <DropoffBeaconMarker
                  key={`dropoff-${dropoffMarkerCoord.latitude.toFixed(5)}-${dropoffMarkerCoord.longitude.toFixed(5)}`}
                  coordinate={dropoffMarkerCoord}
                  title="Dropoff"
                  zIndex={20}
                  tracksViewChanges={false}
                />
              )
            ) : null}
            {driverCoord && trip && trip.status !== "requested" ? (
              <Marker
                coordinate={{ latitude: driverCoord.lat, longitude: driverCoord.lng }}
                title="Driver"
                anchor={{ x: 0.5, y: 0.5 }}
                image={require("./assets/driver-marker.png")}
                zIndex={25}
              />
            ) : null}
          </MapView>
          {!trip && !planningDropoffConfirmed ? (
            <View style={styles.mapCenterPinOverlay} pointerEvents="none">
              <MapCenterSelectionPin variant={bookingStep === "dropoff" ? "dropoff" : "pickup"} />
            </View>
          ) : null}
        </View>

        {!hidePlanningLocateFab ? (
          <Pressable
            style={[styles.mapLocateFab, mapLocateFabBottomStyle]}
            onPress={centerOnMe}
            accessibilityRole="button"
            accessibilityLabel="Reset location"
            accessibilityHint="Centers the map on your GPS and moves the pin"
            hitSlop={8}
          >
            <Ionicons name="locate" size={24} color="#1d4ed8" />
          </Pressable>
        ) : null}
      </View>

      {USE_NATIVE_PLANNING_BOTTOM_SHEET ? (
          <BottomSheet
            key={trip ? `trip-dock-${String(trip._id)}` : `plan-dock-${planningDockMountKey}`}
            ref={planningSheetRef}
            index={trip ? 0 : clampPlanningIndexToSnapPoints(planningSheetIndex, nativePlanningSheetSnapPoints.length)}
            snapPoints={nativePlanningSheetSnapPoints}
            enableContentPanningGesture={!trip}
            onChange={(idx) => {
              if (trip) {
                InteractionManager.runAfterInteractions(() => {
                  setTimeout(() => refitActiveTripCamera(), 180);
                });
                return;
              }
              onPlanningSheetChange(idx);
            }}
            enableOverDrag={false}
            enablePanDownToClose={false}
            enableDynamicSizing={false}
            enableHandlePanningGesture={!trip && !planningDropoffConfirmed}
            keyboardBehavior="interactive"
            keyboardBlurBehavior="restore"
            android_keyboardInputMode="adjustResize"
            backgroundStyle={styles.planningBottomSheetBg}
            handleIndicatorStyle={styles.planningBottomSheetHandle}
          >
            <View style={styles.planningSheetFill}>
              {trip ? (
                <BottomSheetScrollView
                  style={styles.nativeTripInSheetScroll}
                  contentContainerStyle={styles.bottomPanelContent}
                  keyboardShouldPersistTaps="always"
                  showsVerticalScrollIndicator
                  bounces={false}
                  alwaysBounceVertical={false}
                  {...(Platform.OS === "android" ? { overScrollMode: "never" } : {})}
                >
                  <>
                    <Text style={styles.banner}>
                      {trip.status === "requested"
                        ? "Your request is live. You can still cancel below before a driver accepts."
                        : trip.status === "accepted" || trip.status === "in_progress"
                          ? riderAcceptedInProgressBannerCopy(trip, driverCoord)
                          : `Trip: ${trip.status}`}
                    </Text>
                    {(trip.status === "accepted" || trip.status === "in_progress") && trip.driverProfile ? (
                      <View style={styles.driverCard}>
                        {typeof trip.driverProfile.avatarUrl === "string" &&
                        (trip.driverProfile.avatarUrl.startsWith("http") ||
                          trip.driverProfile.avatarUrl.startsWith("data:")) ? (
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
                    <View style={styles.addrSection}>
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
                  <View style={styles.row}>
                    {trip && trip.status !== "completed" && trip.status !== "cancelled" ? (
                      <Pressable style={[styles.smallBtn, styles.warnBtn]} onPress={clearRide} disabled={busy}>
                        <Text style={styles.warnBtnText}>Clear ride</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </BottomSheetScrollView>
              ) : (
                <>
              {showPlanningSheetHeader ? (
                <View style={[styles.planSheetHeaderRow, styles.planningSheetHeaderInset]}>
                  <Text style={styles.selectLocationTitle} numberOfLines={1}>
                    {planningSheetTitle}
                  </Text>
                  <Pressable
                    style={styles.compactTimeChip}
                    onPress={() => setPickupTimeMenuOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={selectedPickupTimeLabel}
                    accessibilityHint="Opens pickup time options"
                  >
                    <View
                      style={[
                        styles.compactTimeChipIconWrap,
                        pickupOffsetMinutes > 0 && styles.compactTimeChipIconWrapScheduled,
                      ]}
                    >
                      <Ionicons
                        name={pickupOffsetMinutes === 0 ? "flash-outline" : "alarm-outline"}
                        size={16}
                        color={pickupOffsetMinutes === 0 ? "#b45309" : "#1d4ed8"}
                      />
                    </View>
                    <View style={styles.compactTimeChipTextCol}>
                      {pickupOffsetMinutes === 0 ? (
                        <Text style={styles.compactTimeChipPrimary}>Pickup now</Text>
                      ) : (
                        <Text style={styles.compactTimeChipPrimary}>
                          <Text style={styles.compactTimeChipMuted}>Pickup in </Text>
                          <Text style={styles.compactTimeChipEmph}>{pickupOffsetMinutes} mins</Text>
                        </Text>
                      )}
                    </View>
                    <Ionicons name="chevron-down" size={16} color="#94a3b8" />
                  </Pressable>
                </View>
              ) : null}
              {planningDropoffConfirmed ? (
                <>
                  <BottomSheetScrollView
                    style={styles.planningBookRideUpperScroll}
                    contentContainerStyle={[
                      styles.bottomPanelContent,
                      styles.bottomSheetPlanScrollContent,
                      styles.planningScrollContentSizing,
                    ]}
                    keyboardShouldPersistTaps="always"
                    showsVerticalScrollIndicator={false}
                    bounces={false}
                    alwaysBounceVertical={false}
                    {...(Platform.OS === "android" ? { overScrollMode: "never" } : {})}
                  >
                    <View style={styles.bookRideStackedAddresses}>
                      <Pressable
                        style={({ pressed }) => [styles.bookRideAddrRow, pressed && styles.bookRideAddrRowPressed]}
                        onPress={onPressBookRideEditPickup}
                        accessibilityRole="button"
                        accessibilityLabel="Edit pickup"
                        accessibilityHint="Opens pickup selection; clears dropoff until you set pickup again"
                      >
                        <View style={styles.bookRideAddrRowTextCol}>
                          <Text style={styles.bookRideAddrRowLabel}>Pickup</Text>
                          <Text style={styles.bookRideAddrRowValue} numberOfLines={3}>
                            {typeof pickupAddressLabel === "string" && pickupAddressLabel.trim().length > 0
                              ? pickupAddressLabel.trim()
                              : "Map pin — tap to set pickup"}
                          </Text>
                        </View>
                        <Ionicons name="create-outline" size={22} color="#64748b" style={styles.bookRideAddrEditIcon} />
                      </Pressable>
                      <View style={styles.bookRideAddrDivider} />
                      <Pressable
                        style={({ pressed }) => [styles.bookRideAddrRow, pressed && styles.bookRideAddrRowPressed]}
                        onPress={goBackFromBookRideToDropoffSelection}
                        accessibilityRole="button"
                        accessibilityLabel="Edit dropoff"
                        accessibilityHint="Returns to dropoff map and search"
                      >
                        <View style={styles.bookRideAddrRowTextCol}>
                          <Text style={styles.bookRideAddrRowLabel}>Dropoff</Text>
                          <Text style={styles.bookRideAddrRowValue} numberOfLines={3}>
                            {typeof dropoffAddressLabel === "string" && dropoffAddressLabel.trim().length > 0
                              ? dropoffAddressLabel.trim()
                              : "Map pin — tap to change dropoff"}
                          </Text>
                        </View>
                        <Ionicons name="create-outline" size={22} color="#64748b" style={styles.bookRideAddrEditIcon} />
                      </Pressable>
                    </View>
                    {planningDropoffHasBothCoords ? (
                      <BookRideTravelTimeRow styles={styles} farePreview={farePreview} />
                    ) : null}
                  </BottomSheetScrollView>
                  <View style={styles.planningBookRideFooterShell}>
                    {planningDropoffHasBothCoords ? (
                      <BookRideFooter
                        styles={styles}
                        farePreview={farePreview}
                        busy={busy}
                        onRequestRide={requestRide}
                        onPressWhyFree={() => setFreeRideWhyOpen(true)}
                      />
                    ) : null}
                  </View>
                </>
              ) : (
                <BottomSheetScrollView
                  style={styles.planningSheetScrollFill}
                  contentContainerStyle={[
                    styles.bottomPanelContent,
                    styles.bottomSheetPlanScrollContent,
                    styles.nativePlanningSheetScrollBottomPad,
                    styles.planningScrollContentSizing,
                    dropoffMinimalSheet && styles.planningDropoffMinimalScroll,
                    planAddressFieldFocused && styles.bottomPanelContentKeyboardOpen,
                  ]}
                  keyboardShouldPersistTaps="always"
                  showsVerticalScrollIndicator={planAddressFieldFocused}
                  bounces={false}
                  alwaysBounceVertical={false}
                  {...(Platform.OS === "android" ? { overScrollMode: "never" } : {})}
                >
                  {bookingStep === "pickup" ? (
                    <>
                      <PlanAddressSearchField
                        styles={styles}
                        label="Address"
                        value={pickupQuery}
                        onChangeText={setPickupQuery}
                        placeholder={
                          pickup && pickupAddressLabel == null ? "Locating address…" : "Start typing an address"
                        }
                        resolving={resolvingPickup}
                        predictionsLoading={addressPredictionsLoading}
                        predictions={addressPredictions}
                        onFocus={onPlanAddressFocus}
                        onBlur={onPlanAddressBlur}
                        onSubmitGeocode={setPickupFromAddress}
                        onSelectPrediction={(p) => applyPlacePrediction(p, true)}
                        TextInputComponent={BottomSheetTextInput}
                        textInputRef={planAddressInputRef}
                      />
                      <Pressable
                        style={[styles.setPickupButton, !canConfirmPickup && styles.setPickupButtonDisabled]}
                        onPress={onPressSetPickup}
                        disabled={!canConfirmPickup}
                        accessibilityRole="button"
                        accessibilityLabel="Set pickup"
                        accessibilityHint="Continues to choose dropoff location"
                      >
                        <Text style={styles.setPickupButtonText}>Set pickup</Text>
                      </Pressable>
                    </>
                  ) : (
                    <>
                      {showSelectDropoffChangePickup ? (
                        <Pressable
                          style={({ pressed }) => [
                            styles.selectDropoffChangePickupRow,
                            pressed && styles.selectDropoffChangePickupRowPressed,
                          ]}
                          onPress={() => void goBackFromDropoffToResetPickup()}
                          accessibilityRole="button"
                          accessibilityLabel="Change pickup"
                          accessibilityHint="Returns to pickup selection and clears dropoff"
                        >
                          <Ionicons name="chevron-back" size={22} color="#2563eb" />
                          <Text style={styles.selectDropoffChangePickupText}>Change pickup</Text>
                        </Pressable>
                      ) : null}
                      <PlanAddressSearchField
                        styles={styles}
                        label="Dropoff address"
                        minimal
                        value={dropoffQuery}
                        onChangeText={setDropoffQuery}
                        placeholder={
                          dropoff && dropoffAddressLabel == null ? "Locating address…" : "Start typing an address"
                        }
                        resolving={resolvingDropoff}
                        predictionsLoading={addressPredictionsLoading}
                        predictions={addressPredictions}
                        onFocus={onPlanAddressFocus}
                        onBlur={onPlanAddressBlur}
                        onSubmitGeocode={setDropoffFromAddress}
                        onSelectPrediction={(p) => applyPlacePrediction(p, false)}
                        TextInputComponent={BottomSheetTextInput}
                        textInputRef={planAddressInputRef}
                      />
                      <Pressable
                        style={[
                          styles.setPickupButton,
                          !planningDropoffHasBothCoords && styles.setPickupButtonDisabled,
                        ]}
                        onPress={onPressSelectDropoffFromMap}
                        disabled={!planningDropoffHasBothCoords}
                        accessibilityRole="button"
                        accessibilityLabel="Select dropoff"
                        accessibilityHint="Uses the map pin as dropoff and continues to book your ride"
                      >
                        <Text style={styles.setPickupButtonText}>Select dropoff</Text>
                      </Pressable>
                    </>
                  )}
                </BottomSheetScrollView>
              )}
                </>
              )}
            </View>
          </BottomSheet>
      ) : (
        <View
          style={[
            styles.bottomPanel,
            addressSheetKeyboardLift && styles.bottomPanelWhenKeyboard,
            iosKeyboardSheetMargin && { marginBottom: keyboardInset },
            !trip && planningDropoffConfirmed ? styles.bottomPanelBookRideWeb : null,
          ].filter(Boolean)}
        >
          {!trip ? (
            <View style={styles.planningSheetFill}>
              {showPlanningSheetHeader ? (
                <View style={[styles.planSheetHeaderRow, styles.planningSheetHeaderInset]}>
                  <Text style={styles.selectLocationTitle} numberOfLines={1}>
                    {planningSheetTitle}
                  </Text>
                  <Pressable
                    style={styles.compactTimeChip}
                    onPress={() => setPickupTimeMenuOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={selectedPickupTimeLabel}
                    accessibilityHint="Opens pickup time options"
                  >
                    <View
                      style={[
                        styles.compactTimeChipIconWrap,
                        pickupOffsetMinutes > 0 && styles.compactTimeChipIconWrapScheduled,
                      ]}
                    >
                      <Ionicons
                        name={pickupOffsetMinutes === 0 ? "flash-outline" : "alarm-outline"}
                        size={16}
                        color={pickupOffsetMinutes === 0 ? "#b45309" : "#1d4ed8"}
                      />
                    </View>
                    <View style={styles.compactTimeChipTextCol}>
                      {pickupOffsetMinutes === 0 ? (
                        <Text style={styles.compactTimeChipPrimary}>Pickup now</Text>
                      ) : (
                        <Text style={styles.compactTimeChipPrimary}>
                          <Text style={styles.compactTimeChipMuted}>Pickup in </Text>
                          <Text style={styles.compactTimeChipEmph}>{pickupOffsetMinutes} mins</Text>
                        </Text>
                      )}
                    </View>
                    <Ionicons name="chevron-down" size={16} color="#94a3b8" />
                  </Pressable>
                </View>
              ) : null}
              {planningDropoffConfirmed ? (
                <>
                  <ScrollView
                    style={styles.planningBookRideUpperScroll}
                    contentContainerStyle={[
                      styles.bottomPanelContent,
                      styles.planningScrollContentSizing,
                    ]}
                    keyboardShouldPersistTaps="always"
                    keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                    showsVerticalScrollIndicator={false}
                    bounces={false}
                    alwaysBounceVertical={false}
                    {...(Platform.OS === "android" ? { overScrollMode: "never" } : {})}
                  >
                    <View style={styles.bookRideStackedAddresses}>
                      <Pressable
                        style={({ pressed }) => [styles.bookRideAddrRow, pressed && styles.bookRideAddrRowPressed]}
                        onPress={onPressBookRideEditPickup}
                        accessibilityRole="button"
                        accessibilityLabel="Edit pickup"
                        accessibilityHint="Opens pickup selection; clears dropoff until you set pickup again"
                      >
                        <View style={styles.bookRideAddrRowTextCol}>
                          <Text style={styles.bookRideAddrRowLabel}>Pickup</Text>
                          <Text style={styles.bookRideAddrRowValue} numberOfLines={3}>
                            {typeof pickupAddressLabel === "string" && pickupAddressLabel.trim().length > 0
                              ? pickupAddressLabel.trim()
                              : "Map pin — tap to set pickup"}
                          </Text>
                        </View>
                        <Ionicons name="create-outline" size={22} color="#64748b" style={styles.bookRideAddrEditIcon} />
                      </Pressable>
                      <View style={styles.bookRideAddrDivider} />
                      <Pressable
                        style={({ pressed }) => [styles.bookRideAddrRow, pressed && styles.bookRideAddrRowPressed]}
                        onPress={goBackFromBookRideToDropoffSelection}
                        accessibilityRole="button"
                        accessibilityLabel="Edit dropoff"
                        accessibilityHint="Returns to dropoff map and search"
                      >
                        <View style={styles.bookRideAddrRowTextCol}>
                          <Text style={styles.bookRideAddrRowLabel}>Dropoff</Text>
                          <Text style={styles.bookRideAddrRowValue} numberOfLines={3}>
                            {typeof dropoffAddressLabel === "string" && dropoffAddressLabel.trim().length > 0
                              ? dropoffAddressLabel.trim()
                              : "Map pin — tap to change dropoff"}
                          </Text>
                        </View>
                        <Ionicons name="create-outline" size={22} color="#64748b" style={styles.bookRideAddrEditIcon} />
                      </Pressable>
                    </View>
                    {planningDropoffHasBothCoords ? (
                      <BookRideTravelTimeRow styles={styles} farePreview={farePreview} />
                    ) : null}
                  </ScrollView>
                  <View style={styles.planningBookRideFooterShell}>
                    {planningDropoffHasBothCoords ? (
                      <BookRideFooter
                        styles={styles}
                        farePreview={farePreview}
                        busy={busy}
                        onRequestRide={requestRide}
                        onPressWhyFree={() => setFreeRideWhyOpen(true)}
                      />
                    ) : null}
                  </View>
                </>
              ) : (
                <ScrollView
                  style={styles.planningSheetScrollFill}
                  contentContainerStyle={[
                    styles.bottomPanelContent,
                    styles.planningScrollContentSizing,
                    dropoffMinimalSheet && styles.planningDropoffMinimalScroll,
                    planAddressFieldFocused && styles.bottomPanelContentKeyboardOpen,
                  ]}
                  keyboardShouldPersistTaps="always"
                  keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                  showsVerticalScrollIndicator={planAddressFieldFocused}
                  bounces={false}
                  alwaysBounceVertical={false}
                  {...(Platform.OS === "android" ? { overScrollMode: "never" } : {})}
                >
                  {bookingStep === "pickup" ? (
                    <>
                      <PlanAddressSearchField
                        styles={styles}
                        label="Address"
                        value={pickupQuery}
                        onChangeText={setPickupQuery}
                        placeholder={
                          pickup && pickupAddressLabel == null ? "Locating address…" : "Start typing an address"
                        }
                        resolving={resolvingPickup}
                        predictionsLoading={addressPredictionsLoading}
                        predictions={addressPredictions}
                        onFocus={onPlanAddressFocus}
                        onBlur={onPlanAddressBlur}
                        onSubmitGeocode={setPickupFromAddress}
                        onSelectPrediction={(p) => applyPlacePrediction(p, true)}
                        textInputRef={planAddressInputRef}
                      />
                      <Pressable
                        style={[styles.setPickupButton, !canConfirmPickup && styles.setPickupButtonDisabled]}
                        onPress={onPressSetPickup}
                        disabled={!canConfirmPickup}
                        accessibilityRole="button"
                        accessibilityLabel="Set pickup"
                        accessibilityHint="Continues to choose dropoff location"
                      >
                        <Text style={styles.setPickupButtonText}>Set pickup</Text>
                      </Pressable>
                    </>
                  ) : (
                    <>
                      {showSelectDropoffChangePickup ? (
                        <Pressable
                          style={({ pressed }) => [
                            styles.selectDropoffChangePickupRow,
                            pressed && styles.selectDropoffChangePickupRowPressed,
                          ]}
                          onPress={() => void goBackFromDropoffToResetPickup()}
                          accessibilityRole="button"
                          accessibilityLabel="Change pickup"
                          accessibilityHint="Returns to pickup selection and clears dropoff"
                        >
                          <Ionicons name="chevron-back" size={22} color="#2563eb" />
                          <Text style={styles.selectDropoffChangePickupText}>Change pickup</Text>
                        </Pressable>
                      ) : null}
                      <PlanAddressSearchField
                        styles={styles}
                        label="Dropoff address"
                        minimal
                        value={dropoffQuery}
                        onChangeText={setDropoffQuery}
                        placeholder={
                          dropoff && dropoffAddressLabel == null ? "Locating address…" : "Start typing an address"
                        }
                        resolving={resolvingDropoff}
                        predictionsLoading={addressPredictionsLoading}
                        predictions={addressPredictions}
                        onFocus={onPlanAddressFocus}
                        onBlur={onPlanAddressBlur}
                        onSubmitGeocode={setDropoffFromAddress}
                        onSelectPrediction={(p) => applyPlacePrediction(p, false)}
                        textInputRef={planAddressInputRef}
                      />
                      <Pressable
                        style={[
                          styles.setPickupButton,
                          !planningDropoffHasBothCoords && styles.setPickupButtonDisabled,
                        ]}
                        onPress={onPressSelectDropoffFromMap}
                        disabled={!planningDropoffHasBothCoords}
                        accessibilityRole="button"
                        accessibilityLabel="Select dropoff"
                        accessibilityHint="Uses the map pin as dropoff and continues to book your ride"
                      >
                        <Text style={styles.setPickupButtonText}>Select dropoff</Text>
                      </Pressable>
                    </>
                  )}
                </ScrollView>
              )}
            </View>
          ) : (
            <ScrollView
              style={styles.bottomPanelScroll}
              contentContainerStyle={styles.bottomPanelContent}
              keyboardShouldPersistTaps="always"
            >
              <>
                <Text style={styles.banner}>
                  {trip.status === "requested"
                    ? "Your request is live. You can still cancel below if plans change."
                    : trip.status === "accepted" || trip.status === "in_progress"
                      ? riderAcceptedInProgressBannerCopy(trip, driverCoord)
                      : `Trip: ${trip.status}`}
                </Text>
                {(trip.status === "accepted" || trip.status === "in_progress") && trip.driverProfile ? (
                  <View style={styles.driverCard}>
                    {typeof trip.driverProfile.avatarUrl === "string" &&
                    (trip.driverProfile.avatarUrl.startsWith("http") ||
                      trip.driverProfile.avatarUrl.startsWith("data:")) ? (
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
                <View style={styles.addrSection}>
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
              <View style={styles.row}>
                {trip && trip.status !== "completed" && trip.status !== "cancelled" ? (
                  <Pressable style={[styles.smallBtn, styles.warnBtn]} onPress={clearRide} disabled={busy}>
                    <Text style={styles.warnBtnText}>Clear ride</Text>
                  </Pressable>
                ) : null}
              </View>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

const pj = {
  r: { fontFamily: FONT_FAMILY.plusJakartaRegular },
  m: { fontFamily: FONT_FAMILY.plusJakartaMedium, fontWeight: "normal" },
  sb: { fontFamily: FONT_FAMILY.plusJakartaSemiBold, fontWeight: "normal" },
  b: { fontFamily: FONT_FAMILY.plusJakartaBold, fontWeight: "normal" },
  xb: { fontFamily: FONT_FAMILY.plusJakartaExtraBold, fontWeight: "normal" },
};

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: "column", backgroundColor: "#fff" },
  /** ~75% of vertical space — map must have bounded flex so it renders. */
  mapArea: { flex: 3, overflow: "hidden" },
  /** Shrink map while keyboard is open so the sheet gets more height. */
  mapAreaWhenKeyboard: { flex: 1, minHeight: 100 },
  /** Native planning: map fills space under chrome; gorhom sheet overlays the bottom. */
  mapLayer: { flex: 1, overflow: "hidden" },
  rideInterstitialRoot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#ffffff" },
  rideInterstitialText: { marginTop: 16, fontSize: 16, ...pj.m, color: "#64748b" },
  planningBottomSheetBg: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  planningBottomSheetHandle: { backgroundColor: "#cbd5e1", width: 36 },
  /** Keep scroll content from stretching past real content (no empty drag zone below). */
  planningScrollContentSizing: { flexGrow: 0 },
  /** Tighter chrome when dropoff step shows only search + suggestions. */
  planningDropoffMinimalScroll: { paddingTop: 8, gap: 8 },
  selectDropoffChangePickupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "stretch",
    paddingVertical: 10,
    paddingHorizontal: 4,
    marginBottom: 4,
    borderRadius: 10,
  },
  selectDropoffChangePickupRowPressed: {
    backgroundColor: "#f1f5f9",
  },
  selectDropoffChangePickupText: {
    fontSize: 16,
    ...pj.sb,
    color: "#1d4ed8",
  },
  bottomSheetPlanScrollContent: { paddingBottom: 8 },
  /** Space above the home indicator / sheet bottom so “Set pickup” isn’t flush with the screen edge. */
  nativePlanningSheetScrollBottomPad: { paddingBottom: 22 },
  /** Book ride: scroll area above pinned footer (native bottom sheet + web panel). */
  planningBookRideUpperScroll: { flex: 1, minHeight: 0 },
  planningBookRideFooterShell: {
    flexShrink: 0,
    backgroundColor: "#ffffff",
    paddingHorizontal: 0,
    paddingTop: 4,
    paddingBottom: Platform.OS === "ios" ? 12 : 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e2e8f0",
  },
  bookRideTravelTimeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  bookRideTravelTimeText: { flex: 1, fontSize: 15, ...pj.m, color: "#334155" },
  /** Trip summary inside persistent BottomSheet — flex only; sheet snap height already caps layout. */
  nativeTripInSheetScroll: { flex: 1 },
  tripBottomDock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: SCREEN_HEIGHT * 0.44,
    width: "100%",
    backgroundColor: "#ffffff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#cbd5e1",
  },
  tripBottomDockScroll: { maxHeight: SCREEN_HEIGHT * 0.44 },
  /** ~25% — planning sheet and trip summary. */
  bottomPanel: {
    flex: 1,
    minHeight: 140,
    backgroundColor: "#ffffff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#cbd5e1",
  },
  /** Web: book ride step matches native sheet height so footer stays on-screen. */
  bottomPanelBookRideWeb: {
    minHeight: Math.round(SCREEN_HEIGHT * PLANNING_BOOK_RIDE_SNAP_FRACTION),
  },
  /** Give the sheet a larger share of the screen when the keyboard is visible. */
  bottomPanelWhenKeyboard: { flex: 4, minHeight: 200 },
  /** Planning UI while typing an address: fill the sheet under the header, actions pinned below. */
  planningSheetFill: { flex: 1, minHeight: 0 },
  planningSheetScrollFill: { flex: 1, minHeight: 0 },
  /** Insets for header row when it sits outside the padded ScrollView (address-focused layout). */
  planningSheetHeaderInset: { paddingHorizontal: 16, paddingTop: 12 },
  bottomPanelScroll: { flex: 1 },
  bottomPanelContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 12,
  },
  /** Extra bottom space while typing so content clears the keyboard comfortably. */
  bottomPanelContentKeyboardOpen: {
    paddingBottom: 32,
  },
  planSheetHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  selectLocationTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 17,
    ...pj.b,
    color: "#0f172a",
  },
  compactTimeChip: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    maxWidth: 168,
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 10,
    gap: 8,
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  compactTimeChipIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: "#fffbeb",
    alignItems: "center",
    justifyContent: "center",
  },
  compactTimeChipIconWrapScheduled: {
    backgroundColor: "#eff6ff",
  },
  compactTimeChipTextCol: { flex: 1, minWidth: 0, justifyContent: "center" },
  compactTimeChipPrimary: { fontSize: 12, ...pj.sb, color: "#0f172a", lineHeight: 15 },
  compactTimeChipMuted: { ...pj.m, color: "#64748b", fontWeight: "normal" },
  compactTimeChipEmph: { ...pj.sb, color: "#1d4ed8" },
  setPickupButton: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "#2563eb",
    marginTop: 4,
    marginBottom: 6,
  },
  setPickupButtonDisabled: {
    backgroundColor: "#94a3b8",
    opacity: 0.85,
  },
  setPickupButtonText: {
    fontSize: 16,
    ...pj.sb,
    color: "#ffffff",
  },
  bookRideStackedAddresses: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    backgroundColor: "#f8fafc",
    overflow: "hidden",
    marginBottom: 8,
  },
  bookRideAddrRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minHeight: 56,
  },
  bookRideAddrRowPressed: {
    backgroundColor: "#f1f5f9",
  },
  bookRideAddrRowTextCol: {
    flex: 1,
    minWidth: 0,
  },
  bookRideAddrRowLabel: {
    fontSize: 11,
    ...pj.b,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.55,
    marginBottom: 3,
  },
  bookRideAddrRowValue: {
    fontSize: 15,
    ...pj.m,
    color: "#0f172a",
    lineHeight: 20,
  },
  bookRideAddrEditIcon: { flexShrink: 0 },
  bookRideAddrDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#e2e8f0",
    marginLeft: 14,
  },
  settingsTopBtn: {
    position: "absolute",
    top: RIDER_SETTINGS_TOP,
    right: 10,
    zIndex: 30,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e2e8f0",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 3,
    elevation: 4,
  },
  mapLocateFab: {
    position: "absolute",
    right: 12,
    zIndex: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 5,
  },
  addressFieldBlock: { gap: 6 },
  addressFieldLabelPressable: { paddingVertical: 2, marginBottom: 2 },
  addressFieldLabel: {
    fontSize: 12,
    ...pj.b,
    color: "#475569",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  addressFieldHint: {
    fontSize: 12,
    ...pj.r,
    color: "#64748b",
    lineHeight: 16,
    marginTop: -2,
    marginBottom: 2,
  },
  addressInputShell: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    backgroundColor: "#ffffff",
    borderWidth: 1.5,
    borderColor: "#94a3b8",
    borderRadius: 10,
    paddingLeft: 14,
    paddingRight: 10,
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  addressInputShellMuted: { opacity: 0.72 },
  addressInputShellWithBack: { paddingLeft: 8 },
  addressInputInner: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  addressInputBackBtn: {
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 6,
    paddingRight: 6,
    marginRight: 2,
  },
  /** Keeps the trailing spinner from shifting the text when loading state toggles. */
  addressInputSpinnerSlot: {
    width: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  addressInputSerious: {
    flex: 1,
    minHeight: 48,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
    fontSize: 16,
    ...pj.m,
    color: "#0f172a",
    letterSpacing: 0.2,
  },
  suggestionsWrap: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    backgroundColor: "#f8fafc",
    overflow: "hidden",
  },
  suggestionItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  suggestionItemPressed: { backgroundColor: "#f1f5f9" },
  suggestionIcon: { marginTop: 2 },
  suggestionTextCol: { flex: 1, minWidth: 0 },
  suggestionMain: { fontSize: 15, ...pj.sb, color: "#0f172a" },
  suggestionSecondary: { fontSize: 13, ...pj.r, color: "#64748b", marginTop: 2, lineHeight: 18 },
  mapCenterPinOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  userLocationBeacon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(37, 99, 235, 0.35)",
    borderWidth: 2,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  userLocationCore: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#2563eb",
  },
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
  freeRideBannerTitle: { fontSize: 14, ...pj.xb, color: "#065f46" },
  freeRideBannerSub: { fontSize: 12, ...pj.r, color: "#047857", marginTop: 2 },
  freeRideWhyChip: {
    backgroundColor: "#059669",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  freeRideWhyChipText: { color: "#fff", ...pj.xb, fontSize: 13 },
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
  freeRideModalTitle: { fontSize: 18, ...pj.xb, color: "#0f172a", marginBottom: 12 },
  freeRideModalBody: { fontSize: 15, ...pj.r, color: "#475569", lineHeight: 22 },
  freeRideModalBtn: {
    alignSelf: "stretch",
    backgroundColor: "#059669",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  freeRideModalBtnText: { color: "#fff", ...pj.xb, fontSize: 15 },
  farePreviewWhy: { alignSelf: "flex-start", marginTop: 6, paddingVertical: 4 },
  farePreviewWhyText: { fontSize: 13, ...pj.xb, color: "#059669", textDecorationLine: "underline" },
  publicClosedBanner: {
    backgroundColor: "#fef3c7",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#fcd34d",
  },
  publicClosedTitle: { fontSize: 15, ...pj.b, color: "#92400e", marginBottom: 6 },
  publicClosedText: { fontSize: 14, ...pj.r, color: "#78350f", lineHeight: 20 },
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
  ridersClosedTitle: { fontSize: 20, ...pj.b, color: "#0f172a", marginBottom: 10 },
  ridersClosedBody: { fontSize: 15, ...pj.r, color: "#475569", lineHeight: 22, marginBottom: 16 },
  waitingLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
    zIndex: 12,
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
    ...pj.b,
    color: "#0f172a",
    marginTop: -8,
  },
  waitingSubtitle: {
    fontSize: 14,
    ...pj.r,
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
  title: { fontSize: 24, ...pj.b, marginBottom: 8 },
  apiHint: { fontSize: 11, ...pj.r, color: "#64748b", marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 14,
    backgroundColor: "#fff",
    fontSize: 16,
    ...pj.r,
  },
  primaryBtn: {
    backgroundColor: "#2563eb",
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", ...pj.sb },
  secondaryBtn: { padding: 12, alignItems: "center" },
  secondaryBtnText: { color: "#2563eb", ...pj.sb },
  mapStyleBar: {
    position: "absolute",
    top: RIDER_MAP_CHROME_TOP,
    left: 10,
    right: 56,
    zIndex: 18,
  },
  banner: {
    backgroundColor: "#eff6ff",
    padding: 12,
    borderRadius: 12,
    fontSize: 15,
    ...pj.r,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#bfdbfe",
    color: "#1e3a8a",
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
  driverCardName: { fontSize: 17, ...pj.b, color: "#0f172a" },
  driverCardMeta: { fontSize: 13, ...pj.r, color: "#64748b", marginTop: 2 },
  vehicleThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: "#f1f5f9",
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  addrSection: {
    backgroundColor: "#f1f5f9",
    padding: 12,
    borderRadius: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  addrText: { color: "#334155", fontSize: 13, ...pj.r },
  farePreviewText: { color: "#0f172a", fontSize: 14, ...pj.b },
  farePreviewMuted: { color: "#64748b", fontSize: 13, ...pj.r },
  timeMenuRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  timeMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15,23,42,0.5)",
  },
  timeMenuSheet: {
    backgroundColor: "#f8fafc",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: Platform.OS === "ios" ? 32 : 22,
    paddingTop: 8,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 16,
  },
  timeMenuHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#cbd5e1",
    marginBottom: 14,
  },
  timeMenuTitle: {
    fontSize: 20,
    letterSpacing: -0.3,
    ...pj.b,
    color: "#0f172a",
    paddingHorizontal: 20,
    marginBottom: 6,
  },
  timeMenuLead: {
    fontSize: 14,
    lineHeight: 20,
    ...pj.r,
    color: "#64748b",
    paddingHorizontal: 20,
    marginBottom: 18,
  },
  timeMenuOptions: {
    paddingHorizontal: 16,
    gap: 10,
  },
  timeMenuCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: "#e2e8f0",
    gap: 14,
  },
  timeMenuCardActive: {
    borderColor: "#3b82f6",
    backgroundColor: "#eff6ff",
    borderWidth: 2,
  },
  timeMenuIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "#f1f5f9",
    alignItems: "center",
    justifyContent: "center",
  },
  timeMenuIconCircleActive: {
    backgroundColor: "#dbeafe",
  },
  timeMenuCardTextCol: { flex: 1, minWidth: 0 },
  timeMenuCardTitle: {
    fontSize: 17,
    letterSpacing: -0.2,
    ...pj.sb,
    color: "#0f172a",
  },
  timeMenuCardTitleActive: { color: "#1e40af" },
  timeMenuCardSub: {
    fontSize: 13,
    marginTop: 3,
    ...pj.r,
    color: "#64748b",
    lineHeight: 18,
  },
  timeMenuCardSubActive: { color: "#3b82f6" },
  timeMenuCheckIcon: { flexShrink: 0 },
  timeMenuRadioOuter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#cbd5e1",
    flexShrink: 0,
  },
  timeMenuCancel: {
    marginTop: 14,
    marginHorizontal: 16,
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: 14,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  timeMenuCancelText: { fontSize: 16, ...pj.sb, color: "#475569" },
  smallBtn: {
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  primarySmall: { backgroundColor: "#2563eb" },
  smallBtnText: { ...pj.sb, color: "#0f172a" },
  smallBtnTextOnPrimary: { color: "#fff", ...pj.sb },
  warnBtn: { backgroundColor: "#f59e0b" },
  warnBtnText: { ...pj.sb, color: "#fff" },
  /** Uber-style book ride: single product row + dark CTA (native + web planning dock). */
  bookRideFooter: {
    gap: 10,
    marginTop: 0,
    paddingHorizontal: 16,
    paddingBottom: Platform.OS === "ios" ? 4 : 2,
  },
  bookRideOptionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: "#f3f4f6",
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#0f172a",
  },
  bookRideOptionIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  bookRideOptionTextBlock: { flex: 1, minWidth: 0 },
  bookRideOptionProductTitle: { fontSize: 16, ...pj.sb, color: "#0f172a" },
  bookRideOptionProductMeta: { fontSize: 13, ...pj.r, color: "#64748b", marginTop: 3 },
  bookRideOptionPriceBlock: { alignItems: "flex-end", minWidth: 72 },
  bookRideOptionPrice: { fontSize: 17, ...pj.sb, color: "#0f172a" },
  bookRideOptionPriceWas: { fontSize: 11, ...pj.r, color: "#64748b", marginTop: 2 },
  bookRideFooterWhy: { alignSelf: "flex-start", marginLeft: 2, paddingVertical: 2 },
  bookRideFooterWhyText: { fontSize: 13, ...pj.sb, color: "#059669", textDecorationLine: "underline" },
  bookRideCta: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    borderRadius: 10,
    backgroundColor: "#000000",
  },
  bookRideCtaDisabled: { backgroundColor: "#9ca3af" },
  bookRideCtaText: { fontSize: 17, ...pj.sb, color: "#ffffff" },
  bookRideCtaTextMuted: { color: "rgba(255,255,255,0.9)" },
});

function BookRideTravelTimeRow({ styles, farePreview }) {
  let line = "Estimating trip time…";
  if (farePreview?.kind === "ok") {
    const d = farePreview.estimate?.breakdown?.trip?.durationText;
    line = d ? `~${d} trip` : "Trip time unavailable";
  } else if (farePreview?.kind === "err") {
    line = "Trip time unavailable";
  } else if (farePreview?.kind === "loading") {
    line = "Estimating trip time…";
  } else {
    line = "Trip time unavailable";
  }
  return (
    <View style={styles.bookRideTravelTimeRow}>
      <Ionicons name="time-outline" size={20} color="#64748b" />
      <Text style={styles.bookRideTravelTimeText}>{line}</Text>
    </View>
  );
}

function BookRideFooter({ styles, farePreview, busy, onRequestRide, onPressWhyFree }) {
  const productMeta = "Up to 4 passengers";

  let priceLine = "…";
  let priceWas = null;
  let showWhyFree = false;

  if (farePreview?.kind === "loading") {
    priceLine = "…";
  } else if (farePreview?.kind === "ok") {
    const e = farePreview.estimate;
    if (e && typeof e === "object") {
      const cur = e.currency === "USD" ? "$" : "";
      if (e.breakdown?.fareFree) {
        priceLine = `${cur}0.00`;
        if (typeof e.breakdown?.waivedQuoteUsd === "number") {
          priceWas = `Was ${cur}${Number(e.breakdown.waivedQuoteUsd).toFixed(2)}`;
        }
        showWhyFree = true;
      } else {
        const t = e.total;
        priceLine =
          typeof t === "number" && Number.isFinite(t) ? `${cur}${t.toFixed(2)}` : "—";
      }
    } else {
      priceLine = "—";
    }
  } else if (farePreview?.kind === "err") {
    priceLine = "—";
  } else {
    priceLine = "—";
  }

  const ctaDisabled = busy || farePreview?.kind === "loading";

  return (
    <View style={styles.bookRideFooter}>
      <View style={styles.bookRideOptionCard}>
        <View style={styles.bookRideOptionIconWrap}>
          <Ionicons name="car-outline" size={26} color="#0f172a" />
        </View>
        <View style={styles.bookRideOptionTextBlock}>
          <Text style={styles.bookRideOptionProductTitle}>TNC Ride</Text>
          <Text style={styles.bookRideOptionProductMeta} numberOfLines={2}>
            {productMeta}
          </Text>
        </View>
        <View style={styles.bookRideOptionPriceBlock}>
          <Text style={styles.bookRideOptionPrice}>{priceLine}</Text>
          {priceWas ? <Text style={styles.bookRideOptionPriceWas}>{priceWas}</Text> : null}
        </View>
      </View>
      {showWhyFree ? (
        <Pressable style={styles.bookRideFooterWhy} onPress={onPressWhyFree} hitSlop={8}>
          <Text style={styles.bookRideFooterWhyText}>Why is this free?</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={[styles.bookRideCta, ctaDisabled && styles.bookRideCtaDisabled]}
        onPress={onRequestRide}
        disabled={ctaDisabled}
        accessibilityRole="button"
        accessibilityLabel="Book ride"
      >
        <Text style={[styles.bookRideCtaText, ctaDisabled && styles.bookRideCtaTextMuted]}>Book ride</Text>
      </Pressable>
    </View>
  );
}

function PlanAddressSearchField({
  styles,
  label,
  minimal = false,
  leadingAccessory = null,
  value,
  onChangeText,
  placeholder,
  resolving,
  predictionsLoading,
  predictions,
  onFocus,
  onBlur,
  onSubmitGeocode,
  onSelectPrediction,
  TextInputComponent = TextInput,
  textInputRef: externalTextInputRef,
}) {
  const addressInputRef = useRef(null);

  const setInputRef = useCallback(
    (node) => {
      addressInputRef.current = node;
      if (typeof externalTextInputRef === "function") externalTextInputRef(node);
      else if (externalTextInputRef) externalTextInputRef.current = node;
    },
    [externalTextInputRef]
  );

  return (
    <View style={styles.addressFieldBlock}>
      {!minimal ? (
        <Pressable
          onPress={() => addressInputRef.current?.focus()}
          accessibilityRole="button"
          accessibilityLabel={`${label}: focus search field`}
          style={styles.addressFieldLabelPressable}
        >
          <Text style={styles.addressFieldLabel}>{label}</Text>
          <Text style={styles.addressFieldHint}>Type to search, or move the map pin.</Text>
        </Pressable>
      ) : null}
      <View
        style={[
          styles.addressInputShell,
          resolving && styles.addressInputShellMuted,
          leadingAccessory ? styles.addressInputShellWithBack : null,
        ]}
      >
        {leadingAccessory}
        <View style={styles.addressInputInner}>
          <TextInputComponent
            ref={setInputRef}
            style={styles.addressInputSerious}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor="#64748b"
            onFocus={onFocus}
            onBlur={onBlur}
            returnKeyType="search"
            onSubmitEditing={onSubmitGeocode}
            editable={!resolving}
            autoCapitalize="words"
            autoCorrect={false}
            selectionColor="#2563eb"
            underlineColorAndroid="transparent"
            textContentType="streetAddressLine1"
            autoComplete="street-address"
            showSoftInputOnFocus
            {...(Platform.OS === "ios" ? { clearButtonMode: "while-editing" } : {})}
          />
          <View style={styles.addressInputSpinnerSlot} pointerEvents="none">
            {resolving || predictionsLoading ? <ActivityIndicator size="small" color="#2563eb" /> : null}
          </View>
        </View>
      </View>
      {predictions.length > 0 ? (
        <View style={styles.suggestionsWrap}>
          {predictions.map((p, i) => (
            <Pressable
              key={p.placeId}
              onPress={() => onSelectPrediction(p)}
              style={({ pressed }) => [
                styles.suggestionItem,
                i === predictions.length - 1 ? { borderBottomWidth: 0 } : null,
                pressed && styles.suggestionItemPressed,
              ]}
            >
              <Ionicons name="location-outline" size={18} color="#64748b" style={styles.suggestionIcon} />
              <View style={styles.suggestionTextCol}>
                <Text style={styles.suggestionMain} numberOfLines={2}>
                  {p.mainText}
                </Text>
                {p.secondaryText ? (
                  <Text style={styles.suggestionSecondary} numberOfLines={2}>
                    {p.secondaryText}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
