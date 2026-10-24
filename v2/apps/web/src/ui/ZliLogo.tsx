import { useId } from "react";

/** The ZLI app icon (a white Z on the blue tile). It matches branding/zli-icon-square.svg. */
export function ZliLogo({ size = 20, className }: { size?: number; className?: string }) {
  const id = `zli-logo-${useId().replace(/:/gu, "")}`;
  return (
    <svg aria-hidden="true" focusable={false} width={size} height={size} viewBox="0 0 1024 1024" className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4F7CFF" />
          <stop offset="1" stopColor="#2D4CE0" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="230" fill={`url(#${id})`} />
      <polygon
        points="283.3 303.8 740.7 303.8 740.7 325.9 363.9 698.1 740.7 698.1 740.7 720.2 283.3 720.2 283.3 698.1 660.1 325.9 283.3 325.9"
        fill="#FFFFFF"
        stroke="#FFFFFF"
        strokeWidth={116}
        strokeLinejoin="round"
      />
    </svg>
  );
}
