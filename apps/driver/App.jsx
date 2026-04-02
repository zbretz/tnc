import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
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
import { DropoffBeaconMarker, PickupBeaconMarker, FONT_FAMILY, fetchApiHealth } from "@tnc/shared";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import FarePercentSlider from "./components/FarePercentSlider";
import { getApiUrl } from "./lib/config";
import DriverInAppNavigationModal from "./DriverInAppNavigationModal";

const TOKEN_KEY = "tnc_token_driver";

/** `/auth/me` and login responses — reject rider-only JWTs in this app (see refreshSessionUser). */
function responseUserIsDriver(user) {
  if (!user || typeof user !== "object") return false;
  if (user.role === "driver") return true;
  return Array.isArray(user.roles) && user.roles.includes("driver");
}

/** Quoted fare = calculated fare × (pct / 100); 50–150%, 100 = baseline. */
const FARE_ADJUSTMENT_PRESETS = [50, 75, 100, 125, 150];

function fareAdjustmentSummary(pct) {
  const n = typeof pct === "number" && Number.isFinite(pct) ? Math.round(pct) : 100;
  if (n === 100) return "Standard — 100% of calculated fare";
  if (n < 100) return `${n}% — ${100 - n}% below calculated`;
  return `${n}% — +${n - 100}% surge`;
}

function fareAdjustmentTrackColor(pct) {
  if (pct < 100) return "#059669";
  if (pct > 100) return "#ea580c";
  return "#7c3aed";
}

const MAP_EDGE_PADDING = { top: 96, right: 40, bottom: 200, left: 40 };
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

function parseTripIsoDate(iso) {
  if (iso == null || iso === "") return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * How long ago the trip was requested (`createdAt`), e.g. "Requested 5 minutes ago".
 * @param {number} [nowMs] — for tests; defaults to `Date.now()`.
 */
function tripRequestMadeLabel(trip, nowMs = Date.now()) {
  const d = parseTripIsoDate(trip?.createdAt);
  if (!d) return null;
  const elapsedSec = Math.floor((nowMs - d.getTime()) / 1000);
  if (elapsedSec < 0) return "Requested just now";
  if (elapsedSec < 45) return "Requested just now";
  if (elapsedSec < 90) return "Requested 1 minute ago";
  const minutes = Math.floor(elapsedSec / 60);
  if (minutes < 60) {
    return `Requested ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Requested ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `Requested ${days} day${days === 1 ? "" : "s"} ago`;
  }
  return `Requested ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** Rider-scheduled pickup window; null if ASAP / not set. */
function tripPickupByLabel(trip) {
  const d = parseTripIsoDate(trip?.preferredPickupAt);
  if (!d) return null;
  const created = parseTripIsoDate(trip?.createdAt);
  const sameCalendarDay = created && created.toDateString() === d.toDateString();
  const opts = sameCalendarDay
    ? { hour: "numeric", minute: "2-digit" }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return `Pickup by ${d.toLocaleString(undefined, opts)}`;
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
    /* fall back to chord */
  }
  return null;
}

/** Straight segment when Directions is unavailable. */
function chordDrivingLine(trip, me, enRouteDropoff) {
  if (!trip?.pickup) return [];
  const p = trip.pickup;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return [];
  if (me?.lat == null || !Number.isFinite(me.lat) || !Number.isFinite(me.lng)) return [];
  if (enRouteDropoff) {
    const d = trip.dropoff;
    const hasDrop = d?.lat != null && d?.lng != null && Number.isFinite(d.lat) && Number.isFinite(d.lng);
    if (!hasDrop) return [];
    return [
      { latitude: me.lat, longitude: me.lng },
      { latitude: d.lat, longitude: d.lng },
    ];
  }
  return [
    { latitude: me.lat, longitude: me.lng },
    { latitude: p.lat, longitude: p.lng },
  ];
}

function formatLegEtaLine(eta) {
  if (!eta) return null;
  const dur = eta.durationText || (eta.summaryMinutes != null ? `~${eta.summaryMinutes} min` : null);
  if (!dur) return null;
  const bits = [dur];
  if (eta.distanceText) bits.push(eta.distanceText);
  if (eta.usesTraffic) bits.push("live traffic");
  return bits.join(" · ");
}

/** Short map-overlay label for active trip phases (driver). */
function driverTripPhaseIndicatorLabel(trip) {
  const st = trip?.status;
  if (st === "awaiting_rider_checkout") return "Waiting for payment";
  if (st === "in_progress") return "Trip in progress";
  if (st === "accepted") {
    if (trip?.driverArrivedAtPickupAt) return "At pickup";
    return "Heading to pickup";
  }
  return "Active ride";
}

export default function App() {
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState([]);
  const [activeTrip, setActiveTrip] = useState(null);
  const [previewTrip, setPreviewTrip] = useState(null);
  const [me, setMe] = useState(null);
  const [sessionUser, setSessionUser] = useState(null);
  const [devDrivers, setDevDrivers] = useState([]);
  const [devListErr, setDevListErr] = useState(null);
  const [devRefreshing, setDevRefreshing] = useState(false);
  const [adminRiderCfg, setAdminRiderCfg] = useState(null);
  const [adminClosedMsgDraft, setAdminClosedMsgDraft] = useState("");
  const [adminFareAdjustmentDraft, setAdminFareAdjustmentDraft] = useState(100);
  const [adminFreeExplanationDraft, setAdminFreeExplanationDraft] = useState("");
  const [riderAdminOpen, setRiderAdminOpen] = useState(false);
  const [activeDrivingCoords, setActiveDrivingCoords] = useState(null);
  const [previewDrivingCoords, setPreviewDrivingCoords] = useState(null);
  const [mapStyleId, setMapStyleId] = useState("default");
  /** Bumps on an interval so open-request cards re-render and refresh relative "Requested … ago" text. */
  const [requestRelativeTick, setRequestRelativeTick] = useState(0);
  /** Native: Google Navigation SDK full-screen guidance; `key` forces a fresh session when reopening. */
  const [inAppNavTarget, setInAppNavTarget] = useState(null);
  const inAppNavTargetRef = useRef(null);
  inAppNavTargetRef.current = inAppNavTarget;
  const [arrivedPickupBusy, setArrivedPickupBusy] = useState(false);
  /** After first in-app "Head to dropoff" for this trip, card shows Complete + return to nav. */
  const [dropoffNavOpenedTripId, setDropoffNavOpenedTripId] = useState(null);
  /** Full-screen overlay while completing a ride until the open-requests list is ready. */
  const [completingTrip, setCompletingTrip] = useState(false);
  /** Pre-login: GET /health against configured API. */
  const [apiHealth, setApiHealth] = useState(null);
  /** landing | signIn | register (phone OTP) | registerProfile (after code) | dev */
  const [authPhase, setAuthPhase] = useState("landing");
  const [devBypassAvailable, setDevBypassAvailable] = useState(false);
  const [driverPhone, setDriverPhone] = useState("");
  const [loginOtp, setLoginOtp] = useState("");
  const [loginOtpSent, setLoginOtpSent] = useState(false);
  const [otpModalVisible, setOtpModalVisible] = useState(false);
  const [signInErr, setSignInErr] = useState(null);
  const otpInputRef = useRef(null);
  const otpVerifyInFlightRef = useRef(false);
  /** true when the open OTP flow is Create account (allowSignup on verify). */
  const otpFlowSignupRef = useRef(false);
  const [pendingDriverSignupToken, setPendingDriverSignupToken] = useState(null);
  const [regFirst, setRegFirst] = useState("");
  const [regLast, setRegLast] = useState("");
  const [regLicNum, setRegLicNum] = useState("");
  const [regLicExpiry, setRegLicExpiry] = useState("");
  const [regVehMake, setRegVehMake] = useState("");
  const [regVehModel, setRegVehModel] = useState("");
  const [regVehYear, setRegVehYear] = useState("");
  const [regVehColor, setRegVehColor] = useState("");
  const [regVehPlate, setRegVehPlate] = useState("");
  const [regErr, setRegErr] = useState(null);

  const retryApiHealth = useCallback(() => {
    setApiHealth("loading");
    fetchApiHealth(getApiUrl()).then(setApiHealth);
  }, []);

  useEffect(() => {
    if (token) return undefined;
    let cancelled = false;
    setApiHealth("loading");
    fetchApiHealth(getApiUrl()).then((r) => {
      if (!cancelled) setApiHealth(r);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    setDropoffNavOpenedTripId(null);
  }, [activeTrip?._id]);

  useEffect(() => {
    setInAppNavTarget((prev) => {
      if (!prev || prev.leg !== "pickup") return prev;
      if (!activeTrip?._id || String(activeTrip._id) !== String(prev.tripId)) return prev;
      if (!activeTrip.driverArrivedAtPickupAt) return prev;
      if (prev.showArrivalChrome === false && !prev.signalPickupArrivalOnArrived) return prev;
      return { ...prev, showArrivalChrome: false, signalPickupArrivalOnArrived: false };
    });
  }, [activeTrip?.driverArrivedAtPickupAt, activeTrip?._id]);
  const socketRef = useRef(null);
  const watchRef = useRef(null);
  const mapRef = useRef(null);
  const formatPoint = useCallback((pt) => `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`, []);
  const activeMapStyle = useMemo(
    () => MAP_STYLE_OPTIONS.find((x) => x.id === mapStyleId)?.style || null,
    [mapStyleId]
  );
  const pickupLabel = useCallback(
    (t) => compactAddress(t?.pickupAddress) || (t?.pickup ? formatPoint(t.pickup) : "Unknown"),
    [formatPoint]
  );
  const dropoffLabel = useCallback(
    (t) => compactAddress(t?.dropoffAddress) || (t?.dropoff ? formatPoint(t.dropoff) : null),
    [formatPoint]
  );

  /** ~100m grid so driver leg refetches occasionally while en route, not every GPS tick. */
  const meForRoute = useMemo(() => {
    if (me?.lat == null || me?.lng == null) return null;
    const lat = Number(me.lat);
    const lng = Number(me.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: Number(lat.toFixed(3)), lng: Number(lng.toFixed(3)) };
  }, [me?.lat, me?.lng]);


  const openInAppNavigatePickupFor = useCallback(
    async (t) => {
      if (!t?.pickup) return;
      const la = Number(t.pickup.lat);
      const lo = Number(t.pickup.lng);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        Alert.alert("Navigation", "Invalid coordinates.");
        return;
      }
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Location required",
          "Google turn-by-turn needs location access. Enable it in Settings → Privacy → Location → TNC Driver."
        );
        return;
      }
      const pickupArrivalPending = t?.status === "accepted" && !t?.driverArrivedAtPickupAt;
      setInAppNavTarget({
        lat: la,
        lng: lo,
        title: pickupLabel(t) || "Pickup",
        key: Date.now(),
        tripId: t?._id != null ? String(t._id) : null,
        leg: "pickup",
        signalPickupArrivalOnArrived: pickupArrivalPending,
        showArrivalChrome: t?.status !== "accepted" || !t?.driverArrivedAtPickupAt,
      });
    },
    [pickupLabel]
  );

  const openInAppNavigateDropoffFor = useCallback(
    async (t) => {
      if (t?.dropoff?.lat == null || t?.dropoff?.lng == null) return;
      const la = Number(t.dropoff.lat);
      const lo = Number(t.dropoff.lng);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        Alert.alert("Navigation", "Invalid coordinates.");
        return;
      }
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Location required",
          "Google turn-by-turn needs location access. Enable it in Settings → Privacy → Location → TNC Driver."
        );
        return;
      }
      setInAppNavTarget({
        lat: la,
        lng: lo,
        title: dropoffLabel(t) || "Dropoff",
        key: Date.now(),
        tripId: t?._id != null ? String(t._id) : null,
        leg: "dropoff",
        signalPickupArrivalOnArrived: false,
        showArrivalChrome: true,
      });
      if (t?._id != null) setDropoffNavOpenedTripId(String(t._id));
    },
    [dropoffLabel]
  );

  const closeInAppNav = useCallback(() => setInAppNavTarget(null), []);

  const postDriverArrivedAtPickup = useCallback(async (tripId) => {
    if (!token || !tripId) return;
    setArrivedPickupBusy(true);
    try {
      const data = await api(`/trips/${tripId}/driver-arrived-pickup`, { method: "POST", token });
      const next = data?.trip;
      if (next) {
        setActiveTrip((prev) => {
          if (!prev || String(prev._id) !== String(tripId)) return prev;
          const merged = { ...prev, ...next };
          if (prev.driverProfile && !next.driverProfile) merged.driverProfile = prev.driverProfile;
          return merged;
        });
      }
    } catch (e) {
      Alert.alert("Could not notify rider", e?.message ? String(e.message) : String(e));
    } finally {
      setArrivedPickupBusy(false);
    }
  }, [token]);

  const handleInAppNavArrived = useCallback(() => {
    const nav = inAppNavTargetRef.current;
    if (!nav?.signalPickupArrivalOnArrived || !nav.tripId) return;
    void postDriverArrivedAtPickup(nav.tripId);
  }, [postDriverArrivedAtPickup]);

  const loadAvailable = useCallback(async (t) => {
    try {
      const { trips } = await api("/trips/available", { token: t });
      setAvailable(trips);
    } catch {
      setAvailable([]);
    }
  }, []);

  const refreshSessionUser = useCallback(async (t) => {
    try {
      const { user } = await api("/auth/me", { token: t });
      if (user && !responseUserIsDriver(user)) {
        await AsyncStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setSessionUser(null);
        setAuthPhase("landing");
        setOtpModalVisible(false);
        setLoginOtpSent(false);
        setLoginOtp("");
        Alert.alert(
          "Rider account",
          "This session is for a rider account. Use the rider app for that login, or sign in with a driver account here."
        );
        return;
      }
      setSessionUser(user || null);
    } catch {
      setSessionUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem(TOKEN_KEY);
      setToken(t);
    })();
  }, []);

  useEffect(() => {
    if (token) refreshSessionUser(token);
    else setSessionUser(null);
  }, [token, refreshSessionUser]);

  useEffect(() => {
    const id = setInterval(() => setRequestRelativeTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!token || !sessionUser?.isAdmin) {
      setAdminRiderCfg(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const c = await api("/admin/rider-service", { token });
        if (!cancelled) {
          setAdminRiderCfg(c);
          setAdminClosedMsgDraft(c.closedMessage || "");
          setAdminFareAdjustmentDraft(
            typeof c.fareAdjustmentPercent === "number" ? c.fareAdjustmentPercent : 100
          );
          setAdminFreeExplanationDraft(
            typeof c.fareFreeRiderExplanationStored === "string" ? c.fareFreeRiderExplanationStored : ""
          );
        }
      } catch {
        if (!cancelled) setAdminRiderCfg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, sessionUser?.isAdmin]);

  useEffect(() => {
    if (!sessionUser?.isAdmin) setRiderAdminOpen(false);
  }, [sessionUser?.isAdmin]);

  const patchAdminRiderService = useCallback(
    async (body) => {
      if (!token) return;
      try {
        const c = await api("/admin/rider-service", { method: "PATCH", token, body });
        setAdminRiderCfg(c);
        setAdminClosedMsgDraft(c.closedMessage || "");
        setAdminFareAdjustmentDraft(
          typeof c.fareAdjustmentPercent === "number" ? c.fareAdjustmentPercent : 100
        );
        setAdminFreeExplanationDraft(
          typeof c.fareFreeRiderExplanationStored === "string" ? c.fareFreeRiderExplanationStored : ""
        );
      } catch (e) {
        Alert.alert("Rider app settings", String(e));
        try {
          const c = await api("/admin/rider-service", { token });
          setAdminRiderCfg(c);
          setAdminClosedMsgDraft(c.closedMessage || "");
          setAdminFareAdjustmentDraft(
            typeof c.fareAdjustmentPercent === "number" ? c.fareAdjustmentPercent : 100
          );
          setAdminFreeExplanationDraft(
            typeof c.fareFreeRiderExplanationStored === "string" ? c.fareFreeRiderExplanationStored : ""
          );
        } catch {
          /* ignore */
        }
      }
    },
    [token]
  );

  useEffect(() => {
    if (!token || !activeTrip) {
      setActiveDrivingCoords(null);
      return;
    }
    const st = activeTrip.status || "";
    const p = activeTrip.pickup;
    const d = activeTrip.dropoff;
    const hasDrop = d?.lat != null && d?.lng != null && Number.isFinite(d.lat) && Number.isFinite(d.lng);
    if (!p?.lat || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
      setActiveDrivingCoords(null);
      return;
    }
    const enRouteDropoff = st === "in_progress" || st === "awaiting_rider_checkout";
    const from = meForRoute;
    const to = enRouteDropoff ? d : p;
    if (!from || !to || (enRouteDropoff && !hasDrop)) {
      setActiveDrivingCoords(null);
      return;
    }
    let cancelled = false;
    const delay = enRouteDropoff ? 500 : 0;
    const tid = setTimeout(async () => {
      const coords = await fetchDrivingPreviewCoords(token, from, to);
      if (!cancelled) setActiveDrivingCoords(coords);
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(tid);
    };
  }, [
    token,
    activeTrip?._id,
    activeTrip?.status,
    activeTrip?.pickup?.lat,
    activeTrip?.pickup?.lng,
    activeTrip?.dropoff?.lat,
    activeTrip?.dropoff?.lng,
    meForRoute?.lat,
    meForRoute?.lng,
  ]);

  useEffect(() => {
    if (!token || !previewTrip?._id) {
      setPreviewDrivingCoords(null);
      return;
    }
    const p = previewTrip.pickup;
    const d = previewTrip.dropoff;
    if (
      !p?.lat ||
      !d?.lat ||
      ![p.lat, p.lng, d.lat, d.lng].every((n) => Number.isFinite(Number(n)))
    ) {
      setPreviewDrivingCoords(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const coords = await fetchDrivingPreviewCoords(token, p, d);
      if (!cancelled) setPreviewDrivingCoords(coords);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    token,
    previewTrip?._id,
    previewTrip?.pickup?.lat,
    previewTrip?.pickup?.lng,
    previewTrip?.dropoff?.lat,
    previewTrip?.dropoff?.lng,
  ]);

  const loadDevDrivers = useCallback(async () => {
    try {
      const { drivers } = await api("/auth/dev/drivers");
      setDevDrivers(Array.isArray(drivers) ? drivers : []);
      setDevListErr(null);
      setDevBypassAvailable(true);
    } catch (e) {
      const msg = String(e?.message || e);
      setDevDrivers([]);
      setDevBypassAvailable(false);
      const looks404 = /\b404\b/i.test(msg) || /not found/i.test(msg);
      setDevListErr(
        looks404
          ? "Dev bypass is disabled. Set TNC_DEV_AUTH=1 on the API and restart."
          : msg
      );
    }
  }, []);

  useEffect(() => {
    if (token) return;
    loadDevDrivers();
  }, [token, loadDevDrivers]);

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
      const next = msg.trip;
      if (next.status === "completed" || next.status === "cancelled") {
        setActiveTrip(null);
        setMe(null);
        loadAvailable(token);
        return;
      }
      setActiveTrip((prev) => {
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
        if (prev.driverProfile && !next.driverProfile) merged.driverProfile = prev.driverProfile;
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

  const pickDriver = async (driverId) => {
    setBusy(true);
    try {
      const { token: t, user } = await api("/auth/dev/login", {
        method: "POST",
        body: { driverId },
      });
      if (!responseUserIsDriver(user)) {
        Alert.alert("Dev sign-in", "That account is not a driver.");
        return;
      }
      await AsyncStorage.setItem(TOKEN_KEY, t);
      setToken(t);
      setSessionUser(user || null);
      await loadAvailable(t);
    } catch (e) {
      Alert.alert("Sign in failed", String(e));
    } finally {
      setBusy(false);
    }
  };

  const goAuthLanding = useCallback(() => {
    setAuthPhase("landing");
    setSignInErr(null);
    setLoginOtpSent(false);
    setOtpModalVisible(false);
    setLoginOtp("");
    setDriverPhone("");
    setRegErr(null);
    setPendingDriverSignupToken(null);
    otpFlowSignupRef.current = false;
    otpVerifyInFlightRef.current = false;
  }, []);

  const sendDriverOtp = async (isSignup) => {
    otpFlowSignupRef.current = Boolean(isSignup);
    setSignInErr(null);
    const phone = driverPhone.trim();
    if (!phone) {
      setSignInErr("Enter your mobile number.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/otp/start", { method: "POST", body: { phone } });
      setLoginOtpSent(true);
      setLoginOtp("");
      setOtpModalVisible(true);
    } catch (e) {
      setSignInErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const verifyDriverOtp = useCallback(
    async (fourDigitCode) => {
      const code = String(fourDigitCode ?? "").replace(/\D/g, "").slice(0, 4);
      const phone = driverPhone.trim();
      if (!phone || !/^\d{4}$/.test(code)) return;
      if (otpVerifyInFlightRef.current) return;
      otpVerifyInFlightRef.current = true;
      setSignInErr(null);
      setBusy(true);
      const allowSignup = otpFlowSignupRef.current;
      try {
        const data = await api("/auth/otp/verify", {
          method: "POST",
          body: { phone, code, intent: "driver", ...(allowSignup ? { allowSignup: true } : {}) },
        });
        if (data.needsProfile === true && typeof data.signupToken === "string" && data.signupToken) {
          if (!allowSignup) {
            setSignInErr("Create an account first, or sign in with a registered number.");
            setLoginOtp("");
            return;
          }
          setPendingDriverSignupToken(data.signupToken);
          setLoginOtp("");
          setLoginOtpSent(false);
          setOtpModalVisible(false);
          setAuthPhase("registerProfile");
          return;
        }
        const t = data.token;
        if (!t) {
          setSignInErr("Unexpected response from server.");
          setLoginOtp("");
          return;
        }
        if (!responseUserIsDriver(data.user)) {
          setSignInErr("This account is not a driver. Use the rider app or register as a driver.");
          setLoginOtp("");
          return;
        }
        await AsyncStorage.setItem(TOKEN_KEY, t);
        setToken(t);
        setSessionUser(data.user || null);
        setLoginOtp("");
        setLoginOtpSent(false);
        setOtpModalVisible(false);
        await loadAvailable(t);
      } catch (e) {
        setSignInErr(String(e?.message || e));
        setLoginOtp("");
      } finally {
        setBusy(false);
        otpVerifyInFlightRef.current = false;
      }
    },
    [driverPhone, loadAvailable]
  );

  const handleOtpModalDigitChange = useCallback(
    (text) => {
      const digits = text.replace(/\D/g, "").slice(0, 4);
      setSignInErr(null);
      setLoginOtp(digits);
      if (digits.length === 4) {
        void verifyDriverOtp(digits);
      }
    },
    [verifyDriverOtp]
  );

  const closeOtpModal = useCallback(() => {
    setOtpModalVisible(false);
    setSignInErr(null);
    setLoginOtp("");
    otpVerifyInFlightRef.current = false;
  }, []);

  useEffect(() => {
    if (!otpModalVisible) return undefined;
    const t = requestAnimationFrame(() => {
      otpInputRef.current?.focus?.();
    });
    return () => cancelAnimationFrame(t);
  }, [otpModalVisible]);

  const submitDriverProfileComplete = async () => {
    setRegErr(null);
    const fn = regFirst.trim();
    const ln = regLast.trim();
    if (!pendingDriverSignupToken) {
      setRegErr("Session expired. Go back and request a new verification code.");
      return;
    }
    if (!fn || !ln) {
      setRegErr("First and last name are required.");
      return;
    }
    const licN = regLicNum.trim();
    const licExp = regLicExpiry.trim();
    if (!licN || !licExp) {
      setRegErr("Driver license number and expiry are required.");
      return;
    }
    const mk = regVehMake.trim();
    const md = regVehModel.trim();
    const plate = regVehPlate.trim();
    if (!mk || !md || !plate) {
      setRegErr("Vehicle make, model, and license plate are required.");
      return;
    }
    const yearStr = regVehYear.trim();
    let yearOpt;
    if (yearStr) {
      const y = parseInt(yearStr, 10);
      if (!Number.isInteger(y)) {
        setRegErr("Vehicle year must be a number.");
        return;
      }
      yearOpt = y;
    }
    setBusy(true);
    try {
      const { token: t, user } = await api("/auth/otp/complete-driver-profile", {
        method: "POST",
        body: {
          signupToken: pendingDriverSignupToken,
          firstName: fn,
          lastName: ln,
          license: { number: licN, expiry: licExp },
          vehicle: {
            make: mk,
            model: md,
            licensePlate: plate,
            color: regVehColor.trim(),
            ...(yearOpt !== undefined ? { year: yearOpt } : {}),
          },
        },
      });
      if (!responseUserIsDriver(user)) {
        setRegErr("Server returned a non-driver account. Try again or contact support.");
        return;
      }
      await AsyncStorage.setItem(TOKEN_KEY, t);
      setToken(t);
      setSessionUser(user || null);
      setPendingDriverSignupToken(null);
      await loadAvailable(t);
    } catch (e) {
      setRegErr(String(e?.message || e));
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
    setSessionUser(null);
    setInAppNavTarget(null);
    goAuthLanding();
  };

  /** Admin: cancel an open request or any in-progress trip (API allows driver+isAdmin). */
  const confirmAdminCancelTrip = useCallback(
    (tripId, contextLabel) => {
      if (!token || !sessionUser?.isAdmin || !tripId) return;
      const idStr = String(tripId);
      Alert.alert(
        "Cancel ride",
        contextLabel ||
          "This cancels the trip for the rider and removes it from the open list. Continue?",
        [
          { text: "No", style: "cancel" },
          {
            text: "Cancel ride",
            style: "destructive",
            onPress: async () => {
              setBusy(true);
              try {
                await api("/trips/cancel", { method: "POST", token, body: { tripId: idStr } });
                setPreviewTrip((prev) => (prev && String(prev._id) === idStr ? null : prev));
                setActiveTrip((prev) => (prev && String(prev._id) === idStr ? null : prev));
                await loadAvailable(token);
              } catch (e) {
                Alert.alert("Cancel failed", e?.message ? String(e.message) : String(e));
              } finally {
                setBusy(false);
              }
            },
          },
        ]
      );
    },
    [token, sessionUser?.isAdmin, loadAvailable]
  );

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
    if (activeTrip.status === "awaiting_rider_checkout") return;
    setBusy(true);
    setCompletingTrip(true);
    try {
      await api(`/trips/${activeTrip._id}/complete`, {
        method: "POST",
        token,
      });
      closeInAppNav();
      setActiveTrip(null);
      setMe(null);
      setPreviewTrip(null);
      await loadAvailable(token);
    } catch (e) {
      Alert.alert("Complete failed", String(e));
    } finally {
      setBusy(false);
      setCompletingTrip(false);
    }
  };

  const startRide = async () => {
    if (!token || !activeTrip) return;
    const rawId = [activeTrip._id, activeTrip.id].find((x) => x != null && String(x).length > 0);
    const idStr = rawId != null ? String(rawId) : "";
    if (!idStr) return;
    setBusy(true);
    try {
      const { trip } = await api(`/trips/${idStr}/start-ride`, { method: "POST", token });
      if (!trip || typeof trip !== "object") {
        Alert.alert("Start ride", "Server did not return trip data.");
        return;
      }
      const prev = activeTrip;
      const merged =
        prev && String(prev._id) === String(trip._id)
          ? (() => {
              const m = { ...prev, ...trip };
              if (prev.dropoff?.lat != null && (trip.dropoff == null || trip.dropoff?.lat == null)) {
                m.dropoff = prev.dropoff;
              }
              if (prev.driverProfile && !trip.driverProfile) m.driverProfile = prev.driverProfile;
              return m;
            })()
          : trip;
      setActiveTrip(merged);
      if (Platform.OS !== "web") {
        await openInAppNavigateDropoffFor(merged);
      }
    } catch (e) {
      Alert.alert("Start ride", String(e));
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
    if (!activeTrip) {
      return {
        latitude: 37.78,
        longitude: -122.4,
        latitudeDelta: 0.2,
        longitudeDelta: 0.2,
      };
    }
    const p = activeTrip.pickup;
    const d = activeTrip.dropoff;
    const st = activeTrip.status || "accepted";
    const spanAB = (a, b) =>
      Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lng - b.lng), 0.02) * 1.4;

    if (st === "in_progress" || st === "awaiting_rider_checkout") {
      if (d?.lat != null && d?.lng != null && me?.lat != null && me?.lng != null) {
        return {
          latitude: (d.lat + me.lat) / 2,
          longitude: (d.lng + me.lng) / 2,
          latitudeDelta: spanAB(d, me),
          longitudeDelta: spanAB(d, me),
        };
      }
      if (d?.lat != null && d?.lng != null) {
        return { latitude: d.lat, longitude: d.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 };
      }
      if (me?.lat != null && me?.lng != null) {
        return { latitude: me.lat, longitude: me.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 };
      }
      return { latitude: p.lat, longitude: p.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 };
    }

    // accepted: frame driver ↔ pickup (omit dropoff from camera)
    if (me?.lat != null && me?.lng != null) {
      return {
        latitude: (p.lat + me.lat) / 2,
        longitude: (p.lng + me.lng) / 2,
        latitudeDelta: spanAB(p, me),
        longitudeDelta: spanAB(p, me),
      };
    }
    return { latitude: p.lat, longitude: p.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 };
  }, [activeTrip, me?.lat, me?.lng]);

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

  /**
   * accepted: fit pickup + driver (omit dropoff).
   * in_progress: fit dropoff + driver (omit pickup).
   */
  useEffect(() => {
    if (!activeTrip || !mapRef.current) return;
    const p = activeTrip.pickup;
    const d = activeTrip.dropoff;
    const st = activeTrip.status || "accepted";
    const coords = [];

    if (st === "in_progress" || st === "awaiting_rider_checkout") {
      if (d?.lat != null && d?.lng != null) {
        coords.push({ latitude: d.lat, longitude: d.lng });
      }
      if (me?.lat != null && me?.lng != null) {
        coords.push({ latitude: me.lat, longitude: me.lng });
      }
    } else {
      coords.push({ latitude: p.lat, longitude: p.lng });
      if (me?.lat != null && me?.lng != null) {
        coords.push({ latitude: me.lat, longitude: me.lng });
      }
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
    activeTrip?.status,
    activeTrip?.pickup?.lat,
    activeTrip?.pickup?.lng,
    activeTrip?.dropoff?.lat,
    activeTrip?.dropoff?.lng,
    me?.lat,
    me?.lng,
  ]);

  const inAppNavModal = (
    <DriverInAppNavigationModal
      key={inAppNavTarget?.key ?? "nav-closed"}
      visible={inAppNavTarget != null}
      onClose={closeInAppNav}
      onArrived={handleInAppNavArrived}
      arrivalChromeEnabled={inAppNavTarget?.showArrivalChrome !== false}
      destinationTitle={inAppNavTarget?.title}
      lat={inAppNavTarget?.lat}
      lng={inAppNavTarget?.lng}
    />
  );

  if (!token) {
    return (
      <KeyboardAvoidingView
        style={styles.authKeyboardRoot}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.authPicker}>
          <StatusBar style="dark" />
          <Text style={styles.title}>TNC Driver</Text>
          <Text style={styles.apiHint} selectable>
            API: {getApiUrl()}
          </Text>
          {apiHealth === "loading" ? (
            <Text style={styles.apiHealthLine}>Checking server…</Text>
          ) : apiHealth?.ok ? (
            <Text style={styles.apiHealthOk}>Server reachable (GET /health)</Text>
          ) : apiHealth ? (
            <View style={styles.apiHealthBlock}>
              <Text style={styles.apiHealthErr}>
                Server check failed:{" "}
                {typeof apiHealth.error === "string" ? apiHealth.error : "Unknown error"}
              </Text>
              <Pressable onPress={retryApiHealth} style={styles.apiHealthRetry} accessibilityRole="button">
                <Text style={styles.apiHealthRetryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          {authPhase === "landing" ? (
            <View style={styles.landingBlock}>
              <Text style={styles.landingSubtitle}>
                Sign in or create an account with your mobile number — we’ll text a code. No password.
              </Text>
              <Pressable
                style={styles.landingPrimaryBtn}
                onPress={() => {
                  setAuthPhase("signIn");
                  setSignInErr(null);
                  setRegErr(null);
                  setLoginOtpSent(false);
                  setOtpModalVisible(false);
                  setLoginOtp("");
                  setPendingDriverSignupToken(null);
                  otpFlowSignupRef.current = false;
                }}
                accessibilityRole="button"
              >
                <Text style={styles.landingPrimaryBtnText}>Sign in</Text>
              </Pressable>
              <Pressable
                style={styles.landingSecondaryBtn}
                onPress={() => {
                  setAuthPhase("register");
                  setSignInErr(null);
                  setRegErr(null);
                  setLoginOtpSent(false);
                  setOtpModalVisible(false);
                  setLoginOtp("");
                  setPendingDriverSignupToken(null);
                  otpFlowSignupRef.current = false;
                }}
                accessibilityRole="button"
              >
                <Text style={styles.landingSecondaryBtnText}>Create account</Text>
              </Pressable>
              {devBypassAvailable ? (
                <Pressable
                  style={styles.landingDevBtn}
                  onPress={() => {
                    setAuthPhase("dev");
                    setDevListErr(null);
                    void loadDevDrivers();
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.landingDevBtnText}>Dev: switch seed driver</Text>
                </Pressable>
              ) : null}
              <Text style={styles.landingFinePrint}>
                Dev bypass skips OTP and logs you in as a seed demo driver when the API runs with TNC_DEV_AUTH=1. For
                SMS codes locally, set TNC_DEV_OTP_LOG=1 on the API to print codes in the server console.
              </Text>
            </View>
          ) : null}

          {authPhase === "signIn" ? (
            <View style={styles.signInWrap}>
              <Pressable onPress={goAuthLanding} style={styles.authBackRow} accessibilityRole="button">
                <Text style={styles.authBackText}>← Back</Text>
              </Pressable>
              <Text style={styles.signInTitle}>Sign in</Text>
              {signInErr && !otpModalVisible ? <Text style={styles.errText}>{signInErr}</Text> : null}
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={styles.regScrollContent}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.regHint}>
                  We’ll text a 4-digit code to the mobile number on your driver account (the one you used when you
                  registered).
                </Text>
                <Text style={styles.regLabel}>Mobile number</Text>
                <TextInput
                  style={styles.regInput}
                  value={driverPhone}
                  onChangeText={setDriverPhone}
                  keyboardType="phone-pad"
                  placeholder="+1 or 10 digits"
                  placeholderTextColor="#94a3b8"
                  editable={!busy}
                />
                <Pressable
                  style={[styles.regSubmitBtn, busy && styles.btnDisabled]}
                  onPress={() => void sendDriverOtp(false)}
                  disabled={busy}
                  accessibilityRole="button"
                >
                  <Text style={styles.regSubmitBtnText}>{loginOtpSent ? "Resend code" : "Send code"}</Text>
                </Pressable>
                {loginOtpSent ? (
                  <Pressable
                    style={[styles.landingSecondaryBtn, { marginTop: 12 }]}
                    onPress={() => {
                      setOtpModalVisible(true);
                      setSignInErr(null);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.landingSecondaryBtnText}>Enter code</Text>
                  </Pressable>
                ) : null}
                {loginOtpSent ? (
                  <Pressable
                    style={styles.authBackRow}
                    onPress={() => {
                      setLoginOtpSent(false);
                      setOtpModalVisible(false);
                      setLoginOtp("");
                      setSignInErr(null);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.authBackText, styles.useDifferentNumberText]}>Use a different number</Text>
                  </Pressable>
                ) : null}
              </ScrollView>
            </View>
          ) : null}

          {authPhase === "register" ? (
            <View style={styles.signInWrap}>
              <Pressable onPress={goAuthLanding} style={styles.authBackRow} accessibilityRole="button">
                <Text style={styles.authBackText}>← Back</Text>
              </Pressable>
              <Text style={styles.signInTitle}>Create account</Text>
              {signInErr && !otpModalVisible ? <Text style={styles.errText}>{signInErr}</Text> : null}
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={styles.regScrollContent}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.regHint}>
                  Enter your mobile number. We’ll text a code to verify it, then you’ll add your license and vehicle.
                  Your application stays pending until an admin activates it.
                </Text>
                <Text style={styles.regLabel}>Mobile number</Text>
                <TextInput
                  style={styles.regInput}
                  value={driverPhone}
                  onChangeText={setDriverPhone}
                  keyboardType="phone-pad"
                  placeholder="+1 or 10 digits"
                  placeholderTextColor="#94a3b8"
                  editable={!busy}
                />
                <Pressable
                  style={[styles.regSubmitBtn, busy && styles.btnDisabled]}
                  onPress={() => void sendDriverOtp(true)}
                  disabled={busy}
                  accessibilityRole="button"
                >
                  <Text style={styles.regSubmitBtnText}>{loginOtpSent ? "Resend code" : "Send code"}</Text>
                </Pressable>
                {loginOtpSent ? (
                  <Pressable
                    style={[styles.landingSecondaryBtn, { marginTop: 12 }]}
                    onPress={() => {
                      setOtpModalVisible(true);
                      setSignInErr(null);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.landingSecondaryBtnText}>Enter code</Text>
                  </Pressable>
                ) : null}
                {loginOtpSent ? (
                  <Pressable
                    style={styles.authBackRow}
                    onPress={() => {
                      setLoginOtpSent(false);
                      setOtpModalVisible(false);
                      setLoginOtp("");
                      setSignInErr(null);
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.authBackText, styles.useDifferentNumberText]}>Use a different number</Text>
                  </Pressable>
                ) : null}
              </ScrollView>
            </View>
          ) : null}

          {authPhase === "registerProfile" ? (
            <View style={{ flex: 1 }}>
              <Pressable
                onPress={() => {
                  setAuthPhase("register");
                  setPendingDriverSignupToken(null);
                  setRegErr(null);
                }}
                style={styles.authBackRow}
                accessibilityRole="button"
              >
                <Text style={styles.authBackText}>← Back</Text>
              </Pressable>
              <Text style={styles.signInTitle}>Your details</Text>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={styles.regScrollContent}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.regHint}>
                  Phone verified. Complete your driver profile. You’ll sign in with SMS only from now on.
                </Text>
                {regErr ? <Text style={styles.errText}>{regErr}</Text> : null}
                <Text style={styles.regSectionTitle}>Your name</Text>
                <Text style={styles.regLabel}>First name</Text>
                <TextInput
                  style={styles.regInput}
                  value={regFirst}
                  onChangeText={setRegFirst}
                  autoCapitalize="words"
                  placeholder="Legal first name"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regLabel}>Last name</Text>
                <TextInput
                  style={styles.regInput}
                  value={regLast}
                  onChangeText={setRegLast}
                  autoCapitalize="words"
                  placeholder="Legal last name"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regSectionTitle}>Driver license</Text>
                <Text style={styles.regLabel}>License number</Text>
                <TextInput
                  style={styles.regInput}
                  value={regLicNum}
                  onChangeText={setRegLicNum}
                  autoCapitalize="characters"
                  placeholder="State license number"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regLabel}>Expiry</Text>
                <TextInput
                  style={styles.regInput}
                  value={regLicExpiry}
                  onChangeText={setRegLicExpiry}
                  placeholder="YYYY-MM-DD or ISO date"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regSectionTitle}>Vehicle</Text>
                <Text style={styles.regLabel}>Make</Text>
                <TextInput
                  style={styles.regInput}
                  value={regVehMake}
                  onChangeText={setRegVehMake}
                  autoCapitalize="words"
                  placeholder="e.g. Toyota"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regLabel}>Model</Text>
                <TextInput
                  style={styles.regInput}
                  value={regVehModel}
                  onChangeText={setRegVehModel}
                  autoCapitalize="words"
                  placeholder="e.g. Camry"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regLabel}>Year (optional)</Text>
                <TextInput
                  style={styles.regInput}
                  value={regVehYear}
                  onChangeText={setRegVehYear}
                  keyboardType="number-pad"
                  placeholder="e.g. 2022"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regLabel}>Color</Text>
                <TextInput
                  style={styles.regInput}
                  value={regVehColor}
                  onChangeText={setRegVehColor}
                  autoCapitalize="words"
                  placeholder="e.g. Silver"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.regLabel}>License plate</Text>
                <TextInput
                  style={styles.regInput}
                  value={regVehPlate}
                  onChangeText={setRegVehPlate}
                  autoCapitalize="characters"
                  placeholder="Plate number"
                  placeholderTextColor="#94a3b8"
                />
                <Pressable
                  style={[styles.regSubmitBtn, busy && styles.btnDisabled]}
                  onPress={() => void submitDriverProfileComplete()}
                  disabled={busy}
                  accessibilityRole="button"
                >
                  <Text style={styles.regSubmitBtnText}>{busy ? "Submitting…" : "Submit application"}</Text>
                </Pressable>
                {busy ? <ActivityIndicator style={styles.pickerSpinner} /> : null}
              </ScrollView>
            </View>
          ) : null}

          {authPhase === "dev" ? (
            <View style={{ flex: 1 }}>
              <Pressable onPress={goAuthLanding} style={styles.authBackRow} accessibilityRole="button">
                <Text style={styles.authBackText}>← Back</Text>
              </Pressable>
              <Text style={styles.signInTitle}>Dev: seed drivers</Text>
              <Text style={styles.pickerHint}>
                Bypasses OTP. Only seed demo accounts (not every driver). Requires TNC_DEV_AUTH=1.
              </Text>
              {devListErr ? <Text style={styles.errText}>{devListErr}</Text> : null}
              <FlatList
                data={devDrivers}
                keyExtractor={(x) => x.id}
                style={{ flex: 1 }}
                contentContainerStyle={styles.driverListContent}
                refreshing={devRefreshing}
                onRefresh={async () => {
                  setDevRefreshing(true);
                  await loadDevDrivers();
                  setDevRefreshing(false);
                }}
                renderItem={({ item }) => (
                  <Pressable
                    style={[styles.driverPickRow, busy && styles.btnDisabled]}
                    onPress={() => pickDriver(item.id)}
                    disabled={busy}
                  >
                    <Text style={styles.driverPickName}>{item.label}</Text>
                    {item.vehicleSummary ? <Text style={styles.driverPickVeh}>{item.vehicleSummary}</Text> : null}
                    <Text style={styles.driverPickEmail}>{item.email}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  devListErr ? null : (
                    <Text style={styles.empty}>
                      No seed drivers yet. Start the API with TNC_DEV_AUTH=1, then pull to refresh.
                    </Text>
                  )
                }
              />
              {busy ? <ActivityIndicator style={styles.pickerSpinner} /> : null}
            </View>
          ) : null}

          <Modal
            visible={otpModalVisible && (authPhase === "signIn" || authPhase === "register")}
            animationType="fade"
            transparent
            onRequestClose={closeOtpModal}
          >
            <View style={styles.otpModalOuter}>
              <Pressable
                style={styles.otpModalBackdrop}
                onPress={closeOtpModal}
                accessibilityRole="button"
                accessibilityLabel="Close"
              />
              <KeyboardAvoidingView
                style={styles.otpModalKb}
                behavior={Platform.OS === "ios" ? "padding" : undefined}
              >
                <View style={styles.otpModalCard}>
                  <Text style={styles.otpModalTitle}>Enter verification code</Text>
                  <Text style={styles.otpModalSubtitle}>
                    4-digit code sent to {driverPhone.trim() || "your phone"}
                  </Text>
                  <TextInput
                    ref={otpInputRef}
                    style={styles.otpModalInput}
                    value={loginOtp}
                    onChangeText={handleOtpModalDigitChange}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="••••"
                    placeholderTextColor="#cbd5e1"
                    editable={!busy}
                    accessibilityLabel="Verification code, 4 digits"
                  />
                  {busy ? <ActivityIndicator style={styles.otpModalSpinner} color="#7c3aed" /> : null}
                  {signInErr && otpModalVisible ? <Text style={styles.otpModalErr}>{signInErr}</Text> : null}
                  <View style={styles.otpModalActions}>
                    <Pressable
                      style={[styles.otpModalSecondaryBtn, busy && styles.btnDisabled]}
                      onPress={() => void sendDriverOtp(authPhase === "register")}
                      disabled={busy}
                      accessibilityRole="button"
                    >
                      <Text style={styles.otpModalSecondaryBtnText}>Resend code</Text>
                    </Pressable>
                    <Pressable
                      onPress={closeOtpModal}
                      disabled={busy}
                      style={[styles.otpModalCancelBtn, busy && styles.btnDisabled]}
                      accessibilityRole="button"
                    >
                      <Text style={styles.otpModalCancelText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              </KeyboardAvoidingView>
            </View>
          </Modal>

          {inAppNavModal}
        </View>
      </KeyboardAvoidingView>
    );
  }

  if (activeTrip) {
    const enRouteDropoff =
      activeTrip.status === "in_progress" || activeTrip.status === "awaiting_rider_checkout";
    const hasDrop =
      activeTrip.dropoff?.lat != null &&
      activeTrip.dropoff?.lng != null &&
      Number.isFinite(activeTrip.dropoff.lat) &&
      Number.isFinite(activeTrip.dropoff.lng);
    const activeChord = chordDrivingLine(activeTrip, me, enRouteDropoff);
    const activeLineCoords =
      activeDrivingCoords?.length >= 2 ? activeDrivingCoords : activeChord;
    const dropoffNavLaunchedThisTrip =
      Platform.OS !== "web" &&
      hasDrop &&
      activeTrip.status === "in_progress" &&
      dropoffNavOpenedTripId != null &&
      String(dropoffNavOpenedTripId) === String(activeTrip._id);

    return (
      <View style={styles.container}>
        <StatusBar style="dark" />
        <View style={styles.driverMapTopChrome} pointerEvents="box-none">
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
          <View style={styles.driverTripPhasePillRow} pointerEvents="none">
            <View
              style={styles.driverTripPhasePill}
              accessibilityRole="text"
              accessibilityLabel={driverTripPhaseIndicatorLabel(activeTrip)}
            >
              <Text style={styles.driverTripPhasePillText}>{driverTripPhaseIndicatorLabel(activeTrip)}</Text>
            </View>
          </View>
        </View>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_GOOGLE}
          customMapStyle={activeMapStyle || undefined}
          initialRegion={region}
        >
          {activeLineCoords.length >= 2 ? (
            <Polyline coordinates={activeLineCoords} strokeColor="#7c3aed" strokeWidth={4} />
          ) : null}
          {!enRouteDropoff ? (
            <PickupBeaconMarker
              coordinate={{
                latitude: activeTrip.pickup.lat,
                longitude: activeTrip.pickup.lng,
              }}
              title="Rider pickup"
            />
          ) : null}
          {hasDrop ? (
            <DropoffBeaconMarker
              coordinate={{
                latitude: activeTrip.dropoff.lat,
                longitude: activeTrip.dropoff.lng,
              }}
              title="Dropoff"
            />
          ) : null}
          {me ? (
            <Marker
              coordinate={{ latitude: me.lat, longitude: me.lng }}
              title="You (driver)"
              anchor={{ x: 0.5, y: 0.5 }}
              image={require("./assets/driver-marker.png")}
            />
          ) : null}
        </MapView>
        <View style={styles.overlay}>
          <View style={styles.activeTripCard}>
            {activeTrip.status === "awaiting_rider_checkout" ? (
              <>
                <Text style={styles.activeTripWaitTitle}>Waiting for rider</Text>
                <Text style={styles.activeTripSub}>
                  They’re confirming tip and payment in their app. Stay nearby.
                </Text>
                <Text style={styles.activeTripAddrLabel}>Pickup</Text>
                <Text style={styles.activeTripAddr}>{pickupLabel(activeTrip)}</Text>
                {dropoffLabel(activeTrip) ? (
                  <>
                    <Text style={[styles.activeTripAddrLabel, styles.activeTripAddrLabelSpaced]}>Dropoff</Text>
                    <Text style={styles.activeTripAddr}>{dropoffLabel(activeTrip)}</Text>
                  </>
                ) : null}
                {Platform.OS !== "web" && hasDrop ? (
                  <Pressable
                    style={[styles.primaryNavBtn, styles.primaryNavBtnSpaced]}
                    onPress={() => void openInAppNavigateDropoffFor(activeTrip)}
                  >
                    <Text style={styles.primaryNavBtnText}>Head to dropoff</Text>
                  </Pressable>
                ) : null}
              </>
            ) : enRouteDropoff ? (
              <>
                <Text style={styles.activeTripLegLabel}>Dropoff</Text>
                <Text style={styles.activeTripEta}>
                  {formatLegEtaLine(activeTrip?.etaToDropoff) ||
                    (me ? "Getting ETA…" : "ETA when location is on")}
                </Text>
                <Text style={styles.activeTripAddr}>{dropoffLabel(activeTrip) || "No dropoff set"}</Text>
                {Platform.OS !== "web" && hasDrop && activeTrip.status === "in_progress" ? (
                  dropoffNavLaunchedThisTrip ? (
                    <>
                      <Pressable
                        style={[styles.primaryCompleteTripBtn, styles.primaryNavBtnSpaced, busy && styles.btnDisabled]}
                        onPress={completeTrip}
                        disabled={busy}
                      >
                        <Text style={styles.primaryNavBtnText}>Complete trip</Text>
                      </Pressable>
                      <Pressable
                        style={styles.tertiaryNavLink}
                        onPress={() => void openInAppNavigateDropoffFor(activeTrip)}
                      >
                        <Text style={styles.tertiaryNavLinkText}>Return to navigation</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      style={[styles.primaryNavBtn, styles.primaryNavBtnSpaced]}
                      onPress={() => void openInAppNavigateDropoffFor(activeTrip)}
                    >
                      <Text style={styles.primaryNavBtnText}>Head to dropoff</Text>
                    </Pressable>
                  )
                ) : null}
              </>
            ) : (
              <>
                <Text style={styles.activeTripLegLabel}>Pickup</Text>
                <Text style={styles.activeTripEta}>
                  {formatLegEtaLine(activeTrip?.etaToPickup) ||
                    (me ? "Getting ETA…" : "ETA when location is on")}
                </Text>
                <Text style={styles.activeTripAddr}>{pickupLabel(activeTrip)}</Text>
                {dropoffLabel(activeTrip) ? (
                  <Text style={styles.activeTripAddrSecondary}>Then · {dropoffLabel(activeTrip)}</Text>
                ) : null}
                {activeTrip.status === "accepted" && Platform.OS !== "web" && !activeTrip.driverArrivedAtPickupAt ? (
                  <Pressable
                    style={[styles.primaryNavBtn, styles.primaryNavBtnSpaced]}
                    onPress={() => void openInAppNavigatePickupFor(activeTrip)}
                  >
                    <Text style={styles.primaryNavBtnText}>Head to pickup</Text>
                  </Pressable>
                ) : null}
                {activeTrip.status === "accepted" && activeTrip.driverArrivedAtPickupAt ? (
                  <Pressable
                    style={[styles.primaryActionBtn, styles.primaryNavBtnSpaced, busy && styles.btnDisabled]}
                    onPress={startRide}
                    disabled={busy}
                  >
                    <Text style={styles.primaryNavBtnText}>{busy ? "Working…" : "Start trip"}</Text>
                  </Pressable>
                ) : null}
                {activeTrip.status === "accepted" && !activeTrip.driverArrivedAtPickupAt ? (
                  <Pressable
                    style={[
                      Platform.OS === "web" ? styles.primaryActionBtn : styles.secondaryTripBtn,
                      Platform.OS === "web" ? styles.primaryNavBtnSpaced : { marginTop: 10 },
                      (busy || arrivedPickupBusy) && styles.btnDisabled,
                    ]}
                    onPress={() => void postDriverArrivedAtPickup(String(activeTrip._id))}
                    disabled={busy || arrivedPickupBusy}
                  >
                    <Text
                      style={
                        Platform.OS === "web" ? styles.primaryNavBtnText : styles.secondaryTripBtnText
                      }
                    >
                      {arrivedPickupBusy ? "Sending…" : "I’ve arrived"}
                    </Text>
                  </Pressable>
                ) : null}
                {activeTrip.status === "accepted" && activeTrip.driverArrivedAtPickupAt && Platform.OS !== "web" ? (
                  <Pressable
                    style={styles.tertiaryNavLink}
                    onPress={() => void openInAppNavigatePickupFor(activeTrip)}
                  >
                    <Text style={styles.tertiaryNavLinkText}>Open pickup navigation again</Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </View>
          <View style={styles.row}>
            <Pressable style={[styles.smallBtn, styles.warn]} onPress={cancelTrip} disabled={busy}>
              <Text style={styles.smallBtnTextLight}>Clear ride</Text>
            </Pressable>
            {activeTrip.status === "in_progress" && !dropoffNavLaunchedThisTrip ? (
              <Pressable style={[styles.smallBtn, styles.danger]} onPress={completeTrip} disabled={busy}>
                <Text style={styles.smallBtnTextLight}>Complete trip</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.smallBtn} onPress={logout}>
              <Text style={styles.smallBtnText}>Log out</Text>
            </Pressable>
          </View>
        </View>
        {inAppNavModal}
        {completingTrip ? (
          <View
            style={styles.completingTripOverlay}
            pointerEvents="auto"
            accessibilityLabel="Finishing trip"
            accessibilityLiveRegion="polite"
          >
            <ActivityIndicator size="large" color="#facc15" />
          </View>
        ) : null}
      </View>
    );
  }

  if (previewTrip && previewRegion) {
    const previewChord =
      previewTrip?.pickup &&
      previewTrip?.dropoff &&
      [previewTrip.pickup.lat, previewTrip.pickup.lng, previewTrip.dropoff.lat, previewTrip.dropoff.lng].every((n) =>
        Number.isFinite(Number(n))
      )
        ? [
            { latitude: previewTrip.pickup.lat, longitude: previewTrip.pickup.lng },
            { latitude: previewTrip.dropoff.lat, longitude: previewTrip.dropoff.lng },
          ]
        : [];
    const previewLineCoords =
      previewDrivingCoords?.length >= 2 ? previewDrivingCoords : previewChord;
    return (
      <View style={styles.container}>
        <StatusBar style="dark" />
        <View style={styles.mapStyleBar} pointerEvents="box-none">
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
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_GOOGLE}
          customMapStyle={activeMapStyle || undefined}
          initialRegion={previewRegion}
        >
          {previewLineCoords.length >= 2 ? (
            <Polyline coordinates={previewLineCoords} strokeColor="#7c3aed" strokeWidth={4} />
          ) : null}
          <PickupBeaconMarker
            coordinate={{
              latitude: previewTrip.pickup.lat,
              longitude: previewTrip.pickup.lng,
            }}
            title="Rider pickup"
          />
          {previewTrip.dropoff?.lat != null && previewTrip.dropoff?.lng != null ? (
            <DropoffBeaconMarker
              coordinate={{
                latitude: previewTrip.dropoff.lat,
                longitude: previewTrip.dropoff.lng,
              }}
              title="Dropoff"
            />
          ) : null}
        </MapView>
        <View style={styles.overlay}>
          <Text style={styles.banner}>
            Trip preview. Green P pin = pickup, purple D pin = dropoff.
            {`\nPickup: ${pickupLabel(previewTrip)}`}
            {dropoffLabel(previewTrip) ? `\nDropoff: ${dropoffLabel(previewTrip)}` : "\nNo dropoff set on this request."}
            {`\n${tripRequestMadeLabel(previewTrip) || "Requested —"}`}
            {tripPickupByLabel(previewTrip) ? `\n${tripPickupByLabel(previewTrip)}` : "\nPickup: Now"}
            {previewTrip.fareEstimate?.total != null
              ? `\nEst. fare: $${Number(previewTrip.fareEstimate.total).toFixed(2)}`
              : ""}
            {previewTrip.riderPhone ? `\nRider phone: ${previewTrip.riderPhone}` : ""}
          </Text>
          <View style={styles.row}>
            {Platform.OS !== "web" ? (
              <>
                <Pressable style={styles.smallBtn} onPress={() => void openInAppNavigatePickupFor(previewTrip)}>
                  <Text style={styles.smallBtnText}>Navigate: pickup</Text>
                </Pressable>
                {previewTrip.dropoff?.lat != null && previewTrip.dropoff?.lng != null ? (
                  <Pressable style={styles.smallBtn} onPress={() => void openInAppNavigateDropoffFor(previewTrip)}>
                    <Text style={styles.smallBtnText}>Navigate: dropoff</Text>
                  </Pressable>
                ) : null}
              </>
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
          {sessionUser?.isAdmin ? (
            <Pressable
              style={[styles.smallBtn, styles.adminCancelOpenBtn]}
              onPress={() => confirmAdminCancelTrip(previewTrip._id, "Cancel this open request for everyone?")}
              disabled={busy}
            >
              <Text style={styles.smallBtnTextLight}>Admin: cancel request</Text>
            </Pressable>
          ) : null}
        </View>
        {inAppNavModal}
      </View>
    );
  }

  const pub = sessionUser?.driverPublic;
  const signedInLine = pub
    ? `Signed in as ${pub.firstName}${pub.lastInitial ? ` ${pub.lastInitial}` : ""}${
        pub.vehicle?.color && pub.vehicle?.model ? ` · ${pub.vehicle.color} ${pub.vehicle.model}` : ""
      }`
    : sessionUser?.email
      ? `Signed in as ${sessionUser.email}`
      : "";

  return (
    <View style={styles.listWrap}>
      <StatusBar style="dark" />
      <Text style={styles.listTitle}>Open requests</Text>
      {signedInLine ? <Text style={styles.signedInLine}>{signedInLine}</Text> : null}
      {sessionUser?.isAdmin ? (
        <View style={styles.adminEntry}>
          <Pressable style={styles.adminEntryBtn} onPress={() => setRiderAdminOpen(true)}>
            <Text style={styles.adminEntryBtnText}>Rider app settings</Text>
            <Text style={styles.adminEntryChevron}>›</Text>
          </Pressable>
          {adminRiderCfg ? (
            <Text style={styles.adminEntryHint} numberOfLines={2}>
              {adminRiderCfg.driversAvailable === false ? "Requests closed" : "Accepting requests"}
              {adminRiderCfg.fareFreeEnabled === true ? " · Free rides" : ""}
              {typeof adminRiderCfg.fareAdjustmentPercent === "number" &&
              adminRiderCfg.fareAdjustmentPercent !== 100 &&
              adminRiderCfg.fareFreeEnabled !== true
                ? ` · Fare ${adminRiderCfg.fareAdjustmentPercent}%`
                : ""}
            </Text>
          ) : (
            <Text style={styles.adminEntryHint}>Loading…</Text>
          )}
        </View>
      ) : null}
      <Modal
        visible={riderAdminOpen}
        animationType="slide"
        onRequestClose={() => setRiderAdminOpen(false)}
        {...(Platform.OS === "ios" ? { presentationStyle: "pageSheet" } : {})}
      >
        <View style={styles.adminModalRoot}>
          <View style={styles.adminModalHeader}>
            <Pressable style={styles.adminModalBack} onPress={() => setRiderAdminOpen(false)} hitSlop={12}>
              <Text style={styles.adminModalBackText}>← Back</Text>
            </Pressable>
            <Text style={styles.adminModalTitle}>Rider app (admin)</Text>
            <View style={styles.adminModalHeaderSpacer} />
          </View>
          <ScrollView
            style={styles.adminModalScroll}
            contentContainerStyle={styles.adminModalScrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {!adminRiderCfg ? (
              <ActivityIndicator style={{ marginVertical: 24 }} color="#5b21b6" />
            ) : (
              <View style={styles.adminModalCard}>
                <View style={styles.adminRow}>
                  <Text style={styles.adminLabel}>Accepting new ride requests</Text>
                  <Switch
                    value={adminRiderCfg.driversAvailable !== false}
                    onValueChange={(v) => patchAdminRiderService({ driversAvailable: v })}
                  />
                </View>
                <Text style={styles.adminHint}>
                  When off, riders see your message and cannot start a new request. Open trips are unchanged.
                </Text>
                <Text style={styles.adminLabel}>Message when closed</Text>
                <TextInput
                  style={styles.adminInput}
                  value={adminClosedMsgDraft}
                  onChangeText={setAdminClosedMsgDraft}
                  placeholder="e.g. No drivers available — come back soon."
                  onSubmitEditing={() => patchAdminRiderService({ closedMessage: adminClosedMsgDraft })}
                  returnKeyType="done"
                />
                <Pressable
                  style={styles.adminSaveMsg}
                  onPress={() => patchAdminRiderService({ closedMessage: adminClosedMsgDraft })}
                >
                  <Text style={styles.adminSaveMsgText}>Save message</Text>
                </Pressable>
                <View style={styles.adminFreeRidePanel}>
                  <Text style={[styles.adminLabel, styles.adminLabelBlock]}>Free rides (locals / testing)</Text>
                  <Pressable
                    style={[
                      styles.adminFreeRideBtn,
                      adminRiderCfg.fareFreeEnabled === true && styles.adminFreeRideBtnOn,
                    ]}
                    onPress={() =>
                      patchAdminRiderService({ fareFreeEnabled: adminRiderCfg.fareFreeEnabled !== true })
                    }
                  >
                    <Text
                      style={[
                        styles.adminFreeRideBtnText,
                        adminRiderCfg.fareFreeEnabled === true && styles.adminFreeRideBtnTextOn,
                      ]}
                    >
                      {adminRiderCfg.fareFreeEnabled === true
                        ? "Free rides ON — tap to charge fares again"
                        : "Free rides — tap to waive all fares ($0)"}
                    </Text>
                  </Pressable>
                  <Text style={styles.adminHint}>
                    Riders see a green banner, $0 quotes, and a &quot;Why?&quot; button. The fare multiplier below is
                    ignored while this is on.
                  </Text>
                  <Text style={[styles.adminLabel, styles.adminLabelBlock]}>“Why?” message for riders</Text>
                  <TextInput
                    style={styles.adminInputMultiline}
                    value={adminFreeExplanationDraft}
                    onChangeText={setAdminFreeExplanationDraft}
                    placeholder="Leave blank to use the default explanation, or describe your pilot here."
                    multiline
                    textAlignVertical="top"
                  />
                  <Pressable
                    style={styles.adminSaveMsg}
                    onPress={() =>
                      patchAdminRiderService({ fareFreeRiderExplanation: adminFreeExplanationDraft })
                    }
                  >
                    <Text style={styles.adminSaveMsgText}>Save “Why?” message</Text>
                  </Pressable>
                </View>
                <View style={styles.adminFarePanel}>
                  <Text style={[styles.adminLabel, styles.adminLabelBlock]}>Quoted fare vs calculated</Text>
                  <View style={styles.fareAdjSummaryPill}>
                    <Text style={styles.fareAdjSummaryText}>
                      {fareAdjustmentSummary(adminFareAdjustmentDraft)}
                    </Text>
                  </View>
                  <View style={styles.fareAdjScaleRow}>
                    <Text style={styles.fareAdjScaleEdge}>50%</Text>
                    <Text style={styles.fareAdjScaleMid}>100% baseline</Text>
                    <Text style={styles.fareAdjScaleEdge}>150%</Text>
                  </View>
                  <FarePercentSlider
                    style={[styles.adminSlider, adminRiderCfg.fareFreeEnabled === true && styles.adminSliderDisabled]}
                    minimumValue={50}
                    maximumValue={150}
                    step={1}
                    value={adminFareAdjustmentDraft}
                    onValueChange={setAdminFareAdjustmentDraft}
                    onSlidingComplete={(v) => {
                      if (adminRiderCfg.fareFreeEnabled === true) return;
                      patchAdminRiderService({ fareAdjustmentPercent: Math.round(Number(v)) });
                    }}
                    disabled={adminRiderCfg.fareFreeEnabled === true}
                    minimumTrackTintColor={fareAdjustmentTrackColor(adminFareAdjustmentDraft)}
                    maximumTrackTintColor="#e2e8f0"
                    thumbTintColor={Platform.OS === "ios" ? "#fff" : "#5b21b6"}
                  />
                  <Text style={styles.adminHint}>
                    Multiplier applies to the calculated fare (including the usual minimum on that total). Final quotes
                    are not raised back to the minimum after a discount.
                  </Text>
                  <View style={styles.fareAdjPresetsRow}>
                    {FARE_ADJUSTMENT_PRESETS.map((p) => {
                      const active = Math.round(adminFareAdjustmentDraft) === p;
                      const freeOn = adminRiderCfg.fareFreeEnabled === true;
                      return (
                        <Pressable
                          key={p}
                          style={[
                            styles.fareAdjChip,
                            active && styles.fareAdjChipActive,
                            freeOn && styles.fareAdjChipDisabled,
                          ]}
                          disabled={freeOn}
                          onPress={() => {
                            setAdminFareAdjustmentDraft(p);
                            patchAdminRiderService({ fareAdjustmentPercent: p });
                          }}
                        >
                          <Text style={[styles.fareAdjChipText, active && styles.fareAdjChipTextActive]}>{p}%</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
      <Pressable style={styles.refresh} onPress={() => token && loadAvailable(token)}>
        <Text style={styles.refreshText}>Refresh</Text>
      </Pressable>
      <FlatList
        data={available}
        extraData={requestRelativeTick}
        keyExtractor={(item, index) =>
          item?._id != null && String(item._id).length > 0 ? String(item._id) : `trip-${index}`
        }
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={
          <Text style={styles.empty}>No open requests. Keep this screen open — new rides appear via socket.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              Trip {String(item?._id != null ? item._id : "").slice(-6) || "—"}
            </Text>
            <Text style={styles.cardMeta}>
              Pickup: {pickupLabel(item)}
            </Text>
            <Text style={styles.cardMeta}>Dropoff: {dropoffLabel(item) || "Not set"}</Text>
            {tripRequestMadeLabel(item) ? (
              <Text style={styles.cardMeta}>{tripRequestMadeLabel(item)}</Text>
            ) : null}
            {tripPickupByLabel(item) ? (
              <Text style={[styles.cardMeta, styles.cardPickupBy]}>{tripPickupByLabel(item)}</Text>
            ) : null}
            {item.fareEstimate?.total != null ? (
              <Text style={styles.cardMeta}>
                Est. fare: ${Number(item.fareEstimate.total).toFixed(2)}
              </Text>
            ) : null}
            {item.riderPhone ? (
              <Text style={styles.cardPhone}>Rider phone: {item.riderPhone}</Text>
            ) : null}
            <View style={styles.cardRow}>
              <Pressable style={[styles.previewBtn, busy && styles.btnDisabled]} onPress={() => setPreviewTrip(item)} disabled={busy}>
                <Text style={styles.previewBtnText}>Preview</Text>
              </Pressable>
              <Pressable style={[styles.acceptBtn, busy && styles.btnDisabled]} onPress={() => accept(item._id)} disabled={busy}>
                <Text style={styles.acceptBtnText}>Accept</Text>
              </Pressable>
            </View>
            {sessionUser?.isAdmin ? (
              <Pressable
                style={[styles.adminCancelOpenBtnFull, busy && styles.btnDisabled]}
                onPress={() =>
                  confirmAdminCancelTrip(item._id, "Cancel this open request? The rider will need to request again.")
                }
                disabled={busy}
              >
                <Text style={styles.adminCancelOpenBtnText}>Admin: cancel request</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      />
      <Pressable style={styles.footerBtn} onPress={logout}>
        <Text style={styles.footerBtnText}>Log out</Text>
      </Pressable>
      {inAppNavModal}
      {completingTrip ? (
        <View
          style={styles.completingTripOverlay}
          pointerEvents="auto"
          accessibilityLabel="Finishing trip"
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator size="large" color="#facc15" />
        </View>
      ) : null}
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
  authKeyboardRoot: { flex: 1, backgroundColor: "#f8fafc" },
  authPicker: { flex: 1, backgroundColor: "#f8fafc", paddingTop: 56, paddingHorizontal: 16 },
  landingBlock: { flex: 1, paddingTop: 8 },
  landingSubtitle: { fontSize: 14, ...pj.r, color: "#475569", lineHeight: 21, marginBottom: 20 },
  landingPrimaryBtn: {
    backgroundColor: "#7c3aed",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 12,
  },
  landingPrimaryBtnText: { fontSize: 17, ...pj.b, color: "#fff" },
  landingSecondaryBtn: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#c4b5fd",
  },
  landingSecondaryBtnText: { fontSize: 17, ...pj.sb, color: "#5b21b6" },
  landingDevBtn: {
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 16,
  },
  landingDevBtnText: { fontSize: 15, ...pj.sb, color: "#2563eb", textDecorationLine: "underline" },
  landingFinePrint: { fontSize: 12, ...pj.r, color: "#94a3b8", lineHeight: 17 },
  signInWrap: { flex: 1, paddingTop: 4 },
  signInTitle: { fontSize: 20, ...pj.b, color: "#0f172a", marginBottom: 12 },
  authBackRow: { alignSelf: "flex-start", paddingVertical: 8, marginBottom: 4 },
  authBackText: { fontSize: 16, ...pj.sb, color: "#2563eb" },
  useDifferentNumberText: { fontSize: 14, ...pj.r, color: "#64748b" },
  otpModalOuter: { flex: 1 },
  otpModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15, 23, 42, 0.5)",
  },
  otpModalKb: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  otpModalCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  otpModalTitle: { fontSize: 20, ...pj.b, color: "#0f172a", marginBottom: 8, textAlign: "center" },
  otpModalSubtitle: { fontSize: 14, ...pj.r, color: "#64748b", textAlign: "center", marginBottom: 20 },
  otpModalInput: {
    borderWidth: 2,
    borderColor: "#c4b5fd",
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    fontSize: 28,
    ...pj.b,
    letterSpacing: 12,
    textAlign: "center",
    color: "#0f172a",
    backgroundColor: "#faf5ff",
  },
  otpModalSpinner: { marginTop: 16 },
  otpModalErr: { fontSize: 13, ...pj.r, color: "#b91c1c", textAlign: "center", marginTop: 12 },
  otpModalActions: { marginTop: 20, gap: 10 },
  otpModalSecondaryBtn: {
    backgroundColor: "#f5f3ff",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd6fe",
  },
  otpModalSecondaryBtnText: { fontSize: 16, ...pj.sb, color: "#5b21b6" },
  otpModalCancelBtn: { paddingVertical: 12, alignItems: "center" },
  otpModalCancelText: { fontSize: 16, ...pj.sb, color: "#64748b" },
  authModeRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  authModeBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    alignItems: "center",
  },
  authModeBtnOn: { borderColor: "#7c3aed", backgroundColor: "#f5f3ff" },
  authModeBtnText: { fontSize: 15, ...pj.sb, color: "#64748b" },
  authModeBtnTextOn: { color: "#5b21b6" },
  regScrollContent: { paddingBottom: 40 },
  regHint: { fontSize: 13, color: "#475569", lineHeight: 19, marginBottom: 12 },
  regSectionTitle: { fontSize: 15, ...pj.b, color: "#0f172a", marginTop: 8, marginBottom: 6 },
  regLabel: { fontSize: 12, ...pj.sb, color: "#64748b", marginBottom: 4, marginTop: 8 },
  regInput: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 12 : 10,
    fontSize: 16,
    ...pj.r,
    backgroundColor: "#fff",
    color: "#0f172a",
  },
  regSubmitBtn: {
    marginTop: 20,
    backgroundColor: "#7c3aed",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  regSubmitBtnText: { fontSize: 16, ...pj.b, color: "#fff" },
  pickerHint: { fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 18 },
  errText: { fontSize: 13, color: "#b91c1c", marginBottom: 12 },
  driverListContent: { paddingBottom: 32, flexGrow: 1 },
  driverPickRow: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  driverPickName: { fontSize: 17, ...pj.b, color: "#0f172a" },
  driverPickVeh: { fontSize: 14, ...pj.r, color: "#64748b", marginTop: 4 },
  driverPickEmail: { fontSize: 12, ...pj.r, color: "#94a3b8", marginTop: 6 },
  pickerSpinner: { marginVertical: 12 },
  title: { fontSize: 24, ...pj.b, marginBottom: 8 },
  apiHint: { fontSize: 11, ...pj.r, color: "#64748b", marginBottom: 12 },
  apiHealthLine: { fontSize: 12, ...pj.r, color: "#64748b", marginBottom: 10 },
  apiHealthOk: { fontSize: 12, ...pj.sb, color: "#15803d", marginBottom: 10 },
  apiHealthBlock: { marginBottom: 12, gap: 6 },
  apiHealthErr: { fontSize: 12, ...pj.r, color: "#b91c1c", lineHeight: 17 },
  apiHealthRetry: { alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 4 },
  apiHealthRetryText: { fontSize: 13, ...pj.sb, color: "#2563eb" },
  container: { flex: 1 },
  completingTripOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 200,
  },
  listWrap: { flex: 1, paddingTop: 56, paddingHorizontal: 16, backgroundColor: "#f8fafc" },
  signedInLine: { fontSize: 13, ...pj.r, color: "#475569", marginBottom: 10 },
  adminEntry: { marginBottom: 12 },
  adminEntryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#c4b5fd",
  },
  adminEntryBtnText: { fontSize: 16, ...pj.b, color: "#5b21b6" },
  adminEntryChevron: { fontSize: 22, ...pj.r, color: "#7c3aed", marginTop: -2 },
  adminEntryHint: { fontSize: 12, ...pj.r, color: "#64748b", marginTop: 6, marginLeft: 4, lineHeight: 17 },
  adminModalRoot: {
    flex: 1,
    backgroundColor: "#f8fafc",
    paddingTop: Platform.OS === "ios" ? 6 : 12,
  },
  adminModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  adminModalBack: { minWidth: 76, paddingVertical: 6, paddingHorizontal: 8 },
  adminModalBackText: { fontSize: 17, ...pj.sb, color: "#2563eb" },
  adminModalTitle: {
    flex: 1,
    fontSize: 17,
    ...pj.b,
    color: "#0f172a",
    textAlign: "center",
  },
  adminModalHeaderSpacer: { minWidth: 76 },
  adminModalScroll: { flex: 1 },
  adminModalScrollContent: { padding: 16, paddingBottom: 40 },
  adminModalCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#c4b5fd",
  },
  adminRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  adminLabel: { fontSize: 14, ...pj.sb, color: "#0f172a", flex: 1, marginRight: 8 },
  adminLabelBlock: { flex: 0, marginRight: 0, marginTop: 14 },
  adminHint: { fontSize: 12, ...pj.r, color: "#64748b", marginBottom: 12, lineHeight: 17 },
  adminInput: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    ...pj.r,
    backgroundColor: "#f8fafc",
    marginBottom: 8,
  },
  adminSaveMsg: { alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 12 },
  adminSaveMsgText: { color: "#059669", ...pj.b, fontSize: 14 },
  adminSlider: { width: "100%", height: 40, marginBottom: 4 },
  adminFreeRidePanel: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#e9d5ff",
  },
  adminFreeRideBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#059669",
    backgroundColor: "#fff",
    marginBottom: 8,
  },
  adminFreeRideBtnOn: {
    backgroundColor: "#059669",
    borderColor: "#047857",
  },
  adminFreeRideBtnText: {
    textAlign: "center",
    fontSize: 14,
    ...pj.xb,
    color: "#059669",
  },
  adminFreeRideBtnTextOn: { color: "#fff" },
  adminInputMultiline: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    ...pj.r,
    backgroundColor: "#f8fafc",
    marginBottom: 8,
    minHeight: 88,
  },
  adminSliderDisabled: { opacity: 0.5 },
  adminFarePanel: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#e9d5ff",
  },
  fareAdjSummaryPill: {
    alignSelf: "flex-start",
    backgroundColor: "#f5f3ff",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginBottom: 10,
    maxWidth: "100%",
  },
  fareAdjSummaryText: { fontSize: 13, ...pj.sb, color: "#4c1d95", lineHeight: 18 },
  fareAdjScaleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  fareAdjScaleEdge: { fontSize: 11, ...pj.sb, color: "#64748b" },
  fareAdjScaleMid: { fontSize: 11, ...pj.b, color: "#5b21b6", flex: 1, textAlign: "center" },
  fareAdjPresetsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  fareAdjChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  fareAdjChipActive: {
    backgroundColor: "#5b21b6",
    borderColor: "#5b21b6",
  },
  fareAdjChipText: { fontSize: 13, ...pj.b, color: "#475569" },
  fareAdjChipTextActive: { color: "#fff" },
  fareAdjChipDisabled: { opacity: 0.45 },
  listTitle: { fontSize: 22, ...pj.b, marginBottom: 8 },
  refresh: { alignSelf: "flex-start", marginBottom: 12 },
  refreshText: { color: "#059669", ...pj.sb },
  empty: { color: "#64748b", marginTop: 24, fontSize: 14, ...pj.r },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  cardTitle: { fontSize: 16, ...pj.b },
  cardMeta: { color: "#64748b", marginTop: 4, marginBottom: 4, fontSize: 14, ...pj.r },
  cardPickupBy: { ...pj.m, color: "#1d4ed8" },
  cardPhone: { fontSize: 14, ...pj.sb, color: "#0f172a", marginBottom: 12 },
  cardRow: { flexDirection: "row", gap: 8 },
  previewBtn: {
    backgroundColor: "#0f172a",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    flex: 1,
  },
  previewBtnText: { color: "#fff", ...pj.b },
  acceptBtn: {
    backgroundColor: "#059669",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    flex: 1,
  },
  acceptBtnText: { color: "#fff", ...pj.b },
  adminCancelOpenBtnFull: {
    marginTop: 10,
    backgroundColor: "#b91c1c",
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  adminCancelOpenBtnText: { color: "#fff", ...pj.sb, fontSize: 14 },
  adminCancelOpenBtn: {
    marginTop: 8,
    alignSelf: "stretch",
    backgroundColor: "#b91c1c",
  },
  btnDisabled: { opacity: 0.6 },
  footerBtn: { padding: 16, alignItems: "center" },
  footerBtnText: { color: "#64748b", ...pj.sb },
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
  driverMapTopChrome: {
    position: "absolute",
    top: 56,
    left: 12,
    right: 12,
    zIndex: 18,
    gap: 8,
  },
  driverTripPhasePillRow: { alignItems: "center" },
  driverTripPhasePill: {
    alignSelf: "center",
    maxWidth: "100%",
    backgroundColor: "#0f172a",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  driverTripPhasePillText: { fontSize: 14, ...pj.sb, color: "#fff", textAlign: "center" },
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
  mapStyleChipText: { color: "#0f172a", fontSize: 12, ...pj.b },
  mapStyleChipTextActive: { color: "#fff" },
  banner: {
    backgroundColor: "rgba(255,255,255,0.95)",
    padding: 12,
    borderRadius: 12,
    fontSize: 14,
    ...pj.r,
  },
  activeTripCard: {
    backgroundColor: "rgba(255,255,255,0.97)",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(226,232,240,0.9)",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  activeTripLegLabel: {
    fontSize: 12,
    ...pj.sb,
    color: "#64748b",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  activeTripEta: {
    fontSize: 28,
    ...pj.b,
    color: "#0f172a",
    marginBottom: 10,
    lineHeight: 34,
  },
  activeTripAddrLabel: { fontSize: 12, ...pj.sb, color: "#64748b", marginBottom: 2 },
  activeTripAddrLabelSpaced: { marginTop: 10 },
  activeTripAddr: { fontSize: 15, ...pj.r, color: "#334155", lineHeight: 22 },
  activeTripAddrSecondary: {
    fontSize: 13,
    ...pj.r,
    color: "#64748b",
    marginTop: 6,
    lineHeight: 18,
  },
  activeTripWaitTitle: { fontSize: 17, ...pj.b, color: "#0f172a", marginBottom: 4 },
  activeTripSub: { fontSize: 13, ...pj.r, color: "#64748b", lineHeight: 18, marginBottom: 12 },
  primaryNavBtn: {
    backgroundColor: "#5b21b6",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    alignSelf: "stretch",
  },
  primaryNavBtnSpaced: { marginTop: 12 },
  primaryNavBtnText: { fontSize: 17, ...pj.b, color: "#fff" },
  primaryActionBtn: {
    backgroundColor: "#059669",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    alignSelf: "stretch",
  },
  primaryCompleteTripBtn: {
    backgroundColor: "#dc2626",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    alignSelf: "stretch",
  },
  secondaryTripBtn: {
    marginTop: 10,
    alignSelf: "stretch",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#047857",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  secondaryTripBtnText: { fontSize: 16, ...pj.sb, color: "#047857" },
  tertiaryNavLink: { marginTop: 10, alignSelf: "center", paddingVertical: 6, paddingHorizontal: 8 },
  tertiaryNavLinkText: { fontSize: 14, ...pj.sb, color: "#5b21b6" },
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
  arrivedPickupBtn: { backgroundColor: "#15803d" },
  smallBtnText: { ...pj.sb, color: "#0f172a" },
  smallBtnTextLight: { ...pj.sb, color: "#fff" },
});
