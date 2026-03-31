import { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, View } from "react-native";

const THUMB = 28;

/**
 * JS-only range control: @react-native-community/slider v5 is Fabric-only (RNCSlider),
 * but the driver app keeps New Architecture off for Google Navigation SDK.
 */
export default function FarePercentSlider({
  style,
  minimumValue,
  maximumValue,
  step,
  value,
  onValueChange,
  onSlidingComplete,
  disabled,
  minimumTrackTintColor,
  maximumTrackTintColor,
  thumbTintColor,
}) {
  const trackW = useRef(0);
  const [trackWidth, setTrackWidth] = useState(0);
  const lastRef = useRef(value);
  const disabledRef = useRef(disabled);
  const onValueChangeRef = useRef(onValueChange);
  const onSlidingCompleteRef = useRef(onSlidingComplete);
  const minRef = useRef(minimumValue);
  const maxRef = useRef(maximumValue);
  const stepRef = useRef(step);
  disabledRef.current = disabled;
  onValueChangeRef.current = onValueChange;
  onSlidingCompleteRef.current = onSlidingComplete;
  minRef.current = minimumValue;
  maxRef.current = maximumValue;
  stepRef.current = step;

  const panResponder = useMemo(() => {
    const xToValue = (x) => {
      const w = trackW.current;
      if (w <= 0) return lastRef.current;
      const min = minRef.current;
      const max = maxRef.current;
      const st = stepRef.current;
      const t = Math.max(0, Math.min(1, x / w));
      let v = min + t * (max - min);
      if (st > 0) {
        v = Math.round(v / st) * st;
      }
      return Math.max(min, Math.min(max, v));
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !disabledRef.current,
      onMoveShouldSetPanResponder: () => !disabledRef.current,
      onPanResponderGrant: (e) => {
        if (disabledRef.current) return;
        const v = xToValue(e.nativeEvent.locationX);
        lastRef.current = v;
        onValueChangeRef.current?.(v);
      },
      onPanResponderMove: (e) => {
        if (disabledRef.current) return;
        const v = xToValue(e.nativeEvent.locationX);
        lastRef.current = v;
        onValueChangeRef.current?.(v);
      },
      onPanResponderRelease: () => {
        if (disabledRef.current) return;
        onSlidingCompleteRef.current?.(lastRef.current);
      },
      onPanResponderTerminate: () => {
        if (disabledRef.current) return;
        onSlidingCompleteRef.current?.(lastRef.current);
      },
    });
  }, []);

  const range = maximumValue - minimumValue || 1;
  const pct = ((value - minimumValue) / range) * 100;
  const thumbLeft =
    trackWidth > 0 ? Math.max(0, Math.min(trackWidth - THUMB, (pct / 100) * trackWidth - THUMB / 2)) : 0;

  return (
    <View
      style={[styles.wrap, style]}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        trackW.current = w;
        setTrackWidth(w);
      }}
      {...panResponder.panHandlers}
    >
      <View style={[styles.track, { backgroundColor: maximumTrackTintColor }]}>
        <View
          style={[
            styles.fill,
            {
              width: `${pct}%`,
              backgroundColor: minimumTrackTintColor,
            },
          ]}
        />
      </View>
      <View
        style={[
          styles.thumb,
          {
            left: thumbLeft,
            backgroundColor: thumbTintColor,
            borderColor: minimumTrackTintColor,
            opacity: disabled ? 0.45 : 1,
          },
        ]}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: 40,
    justifyContent: "center",
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 3,
  },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
    top: "50%",
    marginTop: -THUMB / 2,
  },
});
