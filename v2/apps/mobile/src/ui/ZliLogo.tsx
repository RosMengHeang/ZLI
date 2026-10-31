import { useId } from "react";
import Svg, { Defs, LinearGradient, Polygon, Rect, Stop } from "react-native-svg";

/** The ZLI app icon (a white Z on the blue tile). It matches branding/zli-icon-square.svg. */
export function ZliLogo({ size = 40 }: { size?: number }) {
  const id = `zli-logo-${useId().replace(/[^a-zA-Z0-9]/gu, "")}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#4F7CFF" />
          <Stop offset="1" stopColor="#2D4CE0" />
        </LinearGradient>
      </Defs>
      <Rect width="1024" height="1024" rx="230" fill={`url(#${id})`} />
      <Polygon
        points="283.3 303.8 740.7 303.8 740.7 325.9 363.9 698.1 740.7 698.1 740.7 720.2 283.3 720.2 283.3 698.1 660.1 325.9 283.3 325.9"
        fill="#FFFFFF"
        stroke="#FFFFFF"
        strokeWidth={116}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
