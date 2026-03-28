import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
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
import { DropoffBeaconMarker, PickupBeaconMarker, FONT_FAMILY } from "@tnc/shared";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io } from "socket.io-client";
import { StatusBar } from "expo-status-bar";
import Slider from "@react-native-community/slider";
import { getApiUrl } from "./lib/config";
import DriverInAppNavigationModal from "./DriverInAppNavigationModal";

const TOKEN_KEY = "tnc_token_driver";

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
      setInAppNavTarget({ lat: la, lng: lo, title: pickupLabel(t) || "Pickup", key: Date.now() });
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
      setInAppNavTarget({ lat: la, lng: lo, title: dropoffLabel(t) || "Dropoff", key: Date.now() });
    },
    [dropoffLabel]
  );

  const closeInAppNav = useCallback(() => setInAppNavTarget(null), []);

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
    } catch (e) {
      const msg = String(e?.message || e);
      setDevDrivers([]);
      const looks404 = /\b404\b/i.test(msg) || /not found/i.test(msg);
      setDevListErr(
        looks404
          ? "Dev sign-in is disabled. Set TNC_DEV_AUTH=1 on the API and restart."
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
    try {
      const data = await api(`/trips/${activeTrip._id}/complete`, {
        method: "POST",
        token,
      });
      const t = data?.trip;
      if (t && t.status === "awaiting_rider_checkout") {
        setActiveTrip((prev) => {
          if (!prev || String(prev._id) !== String(t._id)) return t;
          return { ...prev, ...t };
        });
      } else {
        setActiveTrip(null);
        setMe(null);
        await loadAvailable(token);
      }
    } catch (e) {
      Alert.alert("Complete failed", String(e));
    } finally {
      setBusy(false);
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
      setActiveTrip((prev) => {
        if (!prev || String(prev._id) !== String(trip._id)) return trip;
        const merged = { ...prev, ...trip };
        if (prev.dropoff?.lat != null && (trip.dropoff == null || trip.dropoff?.lat == null)) {
          merged.dropoff = prev.dropoff;
        }
        if (prev.driverProfile && !trip.driverProfile) merged.driverProfile = prev.driverProfile;
        return merged;
      });
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
      destinationTitle={inAppNavTarget?.title}
      lat={inAppNavTarget?.lat}
      lng={inAppNavTarget?.lng}
    />
  );

  if (!token) {
    return (
      <View style={styles.authPicker}>
        <StatusBar style="dark" />
        <Text style={styles.title}>TNC Driver</Text>
        <Text style={styles.apiHint} selectable>
          API: {getApiUrl()}
        </Text>
        <Text style={styles.pickerHint}>
          Choose which driver you are (dev only). Seed accounts appear when the API runs with TNC_DEV_AUTH=1.
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
                No drivers yet. Start the API with TNC_DEV_AUTH=1 to create demo drivers, then pull to refresh.
              </Text>
            )
          }
        />
        {busy ? <ActivityIndicator style={styles.pickerSpinner} /> : null}
        {inAppNavModal}
      </View>
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
          <Text style={styles.banner}>
            {activeTrip.status === "awaiting_rider_checkout"
              ? `Waiting for rider to confirm tip & payment in their app.\nPickup: ${pickupLabel(activeTrip)}${dropoffLabel(activeTrip) ? `\nDropoff: ${dropoffLabel(activeTrip)}` : ""}`
              : enRouteDropoff
                ? "En route to dropoff — map shows you and the destination only. Purple line: remaining leg."
                : "En route to pickup — map shows you and the rider pickup (dropoff is not used to frame the map). Purple line shows your pickup approach."}
            {activeTrip.status === "awaiting_rider_checkout"
              ? ""
              : `\nPickup: ${pickupLabel(activeTrip)}${dropoffLabel(activeTrip) ? `\nDropoff: ${dropoffLabel(activeTrip)}` : ""}`}
            {activeTrip.status === "awaiting_rider_checkout"
              ? ""
              : !enRouteDropoff && activeTrip?.etaToPickup
                ? `\nETA to pickup: ${activeTrip.etaToPickup.durationText || `~${activeTrip.etaToPickup.summaryMinutes} min`}${activeTrip.etaToPickup.distanceText ? ` · ${activeTrip.etaToPickup.distanceText}` : ""}${activeTrip.etaToPickup.usesTraffic ? " (traffic)" : ""}`
                : !enRouteDropoff && me
                  ? "\nETA to pickup: updating…"
                  : ""}
            {activeTrip.status === "awaiting_rider_checkout"
              ? ""
              : enRouteDropoff && activeTrip?.etaToDropoff
                ? `\nETA to dropoff: ${activeTrip.etaToDropoff.durationText || `~${activeTrip.etaToDropoff.summaryMinutes} min`}${activeTrip.etaToDropoff.distanceText ? ` · ${activeTrip.etaToDropoff.distanceText}` : ""}${activeTrip.etaToDropoff.usesTraffic ? " (traffic)" : ""}`
                : enRouteDropoff && me
                  ? "\nETA to dropoff: updating…"
                  : ""}
          </Text>
          <View style={styles.row}>
            {!enRouteDropoff ? (
              <Pressable style={styles.smallBtn} onPress={() => openNavigatePickupFor(activeTrip)}>
                <Text style={styles.smallBtnText}>Nav: pickup</Text>
              </Pressable>
            ) : null}
            {enRouteDropoff && hasDrop ? (
              <Pressable style={styles.smallBtn} onPress={() => openNavigateDropoffFor(activeTrip)}>
                <Text style={styles.smallBtnText}>Nav: dropoff</Text>
              </Pressable>
            ) : null}
            {Platform.OS !== "web" ? (
              <>
                {!enRouteDropoff ? (
                  <Pressable style={styles.smallBtn} onPress={() => void openInAppNavigatePickupFor(activeTrip)}>
                    <Text style={styles.smallBtnText}>In-app: pickup</Text>
                  </Pressable>
                ) : null}
                {enRouteDropoff && hasDrop ? (
                  <Pressable style={styles.smallBtn} onPress={() => void openInAppNavigateDropoffFor(activeTrip)}>
                    <Text style={styles.smallBtnText}>In-app: dropoff</Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}
          </View>
          {activeTrip.status === "accepted" ? (
            <View style={styles.row}>
              <Pressable style={[styles.smallBtn, styles.acceptSmall]} onPress={startRide} disabled={busy}>
                <Text style={styles.smallBtnTextLight}>{busy ? "Working…" : "Picked up rider"}</Text>
              </Pressable>
            </View>
          ) : null}
          <View style={styles.row}>
            <Pressable style={[styles.smallBtn, styles.warn]} onPress={cancelTrip} disabled={busy}>
              <Text style={styles.smallBtnTextLight}>Clear ride</Text>
            </Pressable>
            <Pressable
              style={[styles.smallBtn, styles.danger]}
              onPress={completeTrip}
              disabled={busy || activeTrip.status === "awaiting_rider_checkout"}
            >
              <Text style={styles.smallBtnTextLight}>Complete trip</Text>
            </Pressable>
            <Pressable style={styles.smallBtn} onPress={logout}>
              <Text style={styles.smallBtnText}>Log out</Text>
            </Pressable>
          </View>
        </View>
        {inAppNavModal}
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
            <Pressable style={styles.smallBtn} onPress={() => openNavigatePickupFor(previewTrip)}>
              <Text style={styles.smallBtnText}>Nav: pickup</Text>
            </Pressable>
            {previewTrip.dropoff?.lat != null && previewTrip.dropoff?.lng != null ? (
              <Pressable style={styles.smallBtn} onPress={() => openNavigateDropoffFor(previewTrip)}>
                <Text style={styles.smallBtnText}>Nav: dropoff</Text>
              </Pressable>
            ) : null}
            {Platform.OS !== "web" ? (
              <>
                <Pressable style={styles.smallBtn} onPress={() => void openInAppNavigatePickupFor(previewTrip)}>
                  <Text style={styles.smallBtnText}>In-app: pickup</Text>
                </Pressable>
                {previewTrip.dropoff?.lat != null && previewTrip.dropoff?.lng != null ? (
                  <Pressable style={styles.smallBtn} onPress={() => void openInAppNavigateDropoffFor(previewTrip)}>
                    <Text style={styles.smallBtnText}>In-app: dropoff</Text>
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
                  <Slider
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
  authPicker: { flex: 1, backgroundColor: "#f8fafc", paddingTop: 56, paddingHorizontal: 16 },
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
  container: { flex: 1 },
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
  smallBtnText: { ...pj.sb, color: "#0f172a" },
  smallBtnTextLight: { ...pj.sb, color: "#fff" },
});
