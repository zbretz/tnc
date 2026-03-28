import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import {
  MapColorScheme,
  NavigationInitErrorCode,
  NavigationView,
  RouteStatus,
  TravelMode,
  useNavigation,
} from "@googlemaps/react-native-navigation-sdk";
import { FONT_FAMILY } from "@tnc/shared";

const pj = {
  sb: { fontFamily: FONT_FAMILY.plusJakartaSemiBold, fontWeight: "normal" },
};

const NAV_READY_MS = 60000;
/** Simulator / first fix can be slow; SDK requires a location before route calc. */
const FIRST_FIX_MS = 20000;
const ROUTE_WAIT_MS = 45000;

function navigationInitErrorMessage(code) {
  const map = {
    [NavigationInitErrorCode.NOT_AUTHORIZED]: "API key not authorized for Navigation SDK.",
    [NavigationInitErrorCode.TERMS_NOT_ACCEPTED]: "Navigation terms were not accepted.",
    [NavigationInitErrorCode.NETWORK_ERROR]: "Network error during navigation setup.",
    [NavigationInitErrorCode.LOCATION_PERMISSION_MISSING]: "Location permission is required.",
  };
  return map[code] || "Could not start navigation.";
}

/**
 * Full-screen in-app turn-by-turn (Google Navigation SDK).
 * Requires {@link NavigationProvider} above the tree (see index.native.js).
 *
 * Arrival handling:
 * - Manual: driver taps "Arrived" (stops guidance, then {@link onArrived} and {@link onClose}).
 * - Automatic: SDK {@link NavigationCallbacks.onArrival} when the vehicle reaches the final waypoint.
 * - Alternative not wired here: distance-to-destination in {@link onLocationChanged} (custom geofence).
 *
 * @param {{ onArrived?: (detail: { source: 'manual' | 'sdk' }) => void }} props
 */
export default function DriverInAppNavigationModal({ visible, onClose, onArrived, destinationTitle, lat, lng }) {
  const { navigationController, addListeners, removeListeners } = useNavigation();
  const guidanceStartedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onArrivedRef = useRef(onArrived);
  onArrivedRef.current = onArrived;
  const arrivalFinalizingRef = useRef(false);
  /** Wait for native Navigation map surface before init/session so views can attach (non-zero bounds). */
  const [navMapSurfaceReady, setNavMapSurfaceReady] = useState(false);

  const navigationViewControllerRef = useRef(null);

  /** SDK 0.13 requires these when the native NavView attaches; enable navigation chrome on the map. */
  const onNavigationViewControllerCreated = useCallback((controller) => {
    navigationViewControllerRef.current = controller;
    try {
      controller?.setNavigationUIEnabled?.(true);
    } catch {
      /* ignore */
    }
  }, []);
  const onMapViewControllerCreated = useCallback(() => {}, []);

  const mapViewCallbacks = useMemo(
    () => ({
      onMapReady: () => {
        setNavMapSurfaceReady(true);
      },
    }),
    []
  );

  const stopGuidanceOnly = useCallback(async () => {
    try {
      if (guidanceStartedRef.current) {
        await navigationController.stopGuidance();
      }
    } catch {
      /* ignore */
    }
    guidanceStartedRef.current = false;
  }, [navigationController]);

  const handleClose = useCallback(async () => {
    await stopGuidanceOnly();
    onCloseRef.current();
  }, [stopGuidanceOnly]);

  const finalizeArrival = useCallback(async (source) => {
    if (arrivalFinalizingRef.current) return;
    arrivalFinalizingRef.current = true;
    try {
      await stopGuidanceOnly();
      onArrivedRef.current?.({ source });
    } finally {
      onCloseRef.current();
      arrivalFinalizingRef.current = false;
    }
  }, [stopGuidanceOnly]);

  useEffect(() => {
    if (!visible) {
      setNavMapSurfaceReady(false);
      navigationViewControllerRef.current = null;
      arrivalFinalizingRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (
      !visible ||
      !navMapSurfaceReady ||
      lat == null ||
      lng == null ||
      !Number.isFinite(Number(lat)) ||
      !Number.isFinite(Number(lng))
    ) {
      return undefined;
    }

    let cancelled = false;
    /** @type {(() => void) | null} */
    let resolveNavReady = null;
    /** @type {((e: Error) => void) | null} */
    let rejectNavReady = null;
    const navReadyPromise = new Promise((res, rej) => {
      resolveNavReady = res;
      rejectNavReady = rej;
    });

    const onNavigationReady = () => {
      if (!cancelled) resolveNavReady?.();
    };

    const onNavigationInitError = (errorCode) => {
      if (cancelled) return;
      rejectNavReady?.(new Error(navigationInitErrorMessage(errorCode)));
    };

    /** @type {{ onLocationChanged?: (loc: unknown) => void; onRouteStatusResult?: (status: RouteStatus) => void }} */
    const extraListeners = {};

    const detachAllNavigationListeners = () => {
      removeListeners({
        onNavigationReady,
        onNavigationInitError,
      });
      if (extraListeners.onLocationChanged) {
        removeListeners({ onLocationChanged: extraListeners.onLocationChanged });
        delete extraListeners.onLocationChanged;
      }
      if (extraListeners.onRouteStatusResult) {
        removeListeners({ onRouteStatusResult: extraListeners.onRouteStatusResult });
        delete extraListeners.onRouteStatusResult;
      }
      if (extraListeners.onArrival) {
        removeListeners({ onArrival: extraListeners.onArrival });
        delete extraListeners.onArrival;
      }
    };

    addListeners({
      onNavigationReady,
      onNavigationInitError,
    });

    const fail = (msg) => {
      void (async () => {
        await stopGuidanceOnly();
        if (cancelled) return;
        Alert.alert("Navigation", msg);
        onCloseRef.current();
      })();
    };

    (async () => {
      try {
        await navigationController.init();

        await Promise.race([
          navReadyPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error("Navigation did not become ready in time.")), NAV_READY_MS)),
        ]);

        if (cancelled) return;

        removeListeners({
          onNavigationReady,
          onNavigationInitError,
        });
        resolveNavReady = null;
        rejectNavReady = null;

        navigationController.startUpdatingLocation();
        if (Platform.OS === "ios") {
          navigationController.setBackgroundLocationUpdatesEnabled(false);
        }

        let locationResolved = false;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (!locationResolved) {
              reject(
                new Error(
                  "No GPS fix yet. The Navigation SDK needs your location before it can compute a route. Try outdoors, enable Location for this app, or use a simulator location."
                )
              );
            }
          }, FIRST_FIX_MS);

          const onLocationChanged = (loc) => {
            if (cancelled || locationResolved || !loc) return;
            locationResolved = true;
            clearTimeout(timeout);
            removeListeners({ onLocationChanged });
            delete extraListeners.onLocationChanged;
            resolve();
          };

          extraListeners.onLocationChanged = onLocationChanged;
          addListeners({ onLocationChanged });
        });

        if (cancelled) return;

        const waypoint = {
          title: destinationTitle || "Destination",
          position: { lat: Number(lat), lng: Number(lng) },
        };
        const routingOptions = {
          travelMode: TravelMode.DRIVING,
          avoidFerries: false,
          avoidTolls: false,
        };
        const displayOptions = {
          showDestinationMarkers: true,
          showStopSigns: true,
          showTrafficLights: true,
        };

        const routeStatus = await new Promise((resolve, reject) => {
          let settled = false;
          const onRouteStatusResult = (status) => {
            if (cancelled || settled) return;
            settled = true;
            clearTimeout(routeTimeout);
            removeListeners({ onRouteStatusResult });
            delete extraListeners.onRouteStatusResult;
            resolve(status);
          };

          const routeTimeout = setTimeout(() => {
            if (cancelled || settled) return;
            settled = true;
            removeListeners({ onRouteStatusResult });
            delete extraListeners.onRouteStatusResult;
            reject(new Error("Route calculation timed out."));
          }, ROUTE_WAIT_MS);

          extraListeners.onRouteStatusResult = onRouteStatusResult;
          addListeners({ onRouteStatusResult });

          navigationController
            .setDestinations([waypoint], {
              routingOptions,
              displayOptions,
            })
            .catch((e) => {
              if (cancelled || settled) return;
              settled = true;
              clearTimeout(routeTimeout);
              removeListeners({ onRouteStatusResult });
              delete extraListeners.onRouteStatusResult;
              reject(e);
            });
        });

        if (cancelled) return;

        if (routeStatus !== RouteStatus.OK) {
          fail(
            routeStatus === RouteStatus.LOCATION_DISABLED
              ? "Waiting for GPS took too long. Try again outdoors or check location settings."
              : `Could not build a route (${routeStatus}).`
          );
          return;
        }

        await navigationController.startGuidance();
        if (cancelled) return;
        guidanceStartedRef.current = true;

        const onArrival = (event) => {
          if (cancelled) return;
          if (event?.isFinalDestination === false) return;
          removeListeners({ onArrival });
          delete extraListeners.onArrival;
          void finalizeArrival("sdk");
        };
        extraListeners.onArrival = onArrival;
        addListeners({ onArrival });
      } catch (e) {
        detachAllNavigationListeners();
        if (!cancelled) fail(e?.message ? String(e.message) : String(e));
      }
    })();

    return () => {
      cancelled = true;
      resolveNavReady = null;
      rejectNavReady = null;
      detachAllNavigationListeners();
      void (async () => {
        await stopGuidanceOnly();
      })();
    };
  }, [
    visible,
    navMapSurfaceReady,
    lat,
    lng,
    destinationTitle,
    navigationController,
    addListeners,
    removeListeners,
    stopGuidanceOnly,
    finalizeArrival,
  ]);

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => void handleClose()}>
      <View style={styles.root}>
        <View style={styles.chrome}>
          <Pressable
            style={styles.closeBtn}
            onPress={() => void handleClose()}
            accessibilityRole="button"
            accessibilityLabel="Close navigation"
          >
            <Text style={styles.closeBtnText}>Close</Text>
          </Pressable>
          <Pressable
            style={styles.arrivedBtn}
            onPress={() => void finalizeArrival("manual")}
            accessibilityRole="button"
            accessibilityLabel="Mark arrived at destination"
          >
            <Text style={styles.arrivedBtnText}>Arrived</Text>
          </Pressable>
        </View>
        <NavigationView
          style={styles.navView}
          mapColorScheme={MapColorScheme.FOLLOW_SYSTEM}
          mapViewCallbacks={mapViewCallbacks}
          onNavigationViewControllerCreated={onNavigationViewControllerCreated}
          onMapViewControllerCreated={onMapViewControllerCreated}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  chrome: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 52,
    paddingHorizontal: 12,
    paddingBottom: 8,
    backgroundColor: "#0f172a",
  },
  closeBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: "#334155",
    borderRadius: 10,
  },
  closeBtnText: { fontSize: 16, ...pj.sb, color: "#fff" },
  arrivedBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: "#15803d",
    borderRadius: 10,
  },
  arrivedBtnText: { fontSize: 16, ...pj.sb, color: "#fff" },
  navView: { flex: 1 },
});
