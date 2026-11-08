const FILLED: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 3,
  max: 3,
};

/** How many of the meter's three bars a level fills. A level ZLI does not know, or none, reads as the middle. */
export function reasoningBars(level: string | undefined): number {
  return level ? (FILLED[level.toLowerCase()] ?? 2) : 2;
}

/**
 * Three rising bars filled up to the level, so the chip and each menu row show how hard the model thinks.
 * Drawn on a 14px grid and shown at 14px, so every bar edge lands on a whole pixel.
 */
export function ReasoningMeter({ level }: { level: string | undefined }) {
  const filled = reasoningBars(level);
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      aria-hidden="true"
      focusable="false"
      className="reasoning-meter"
      data-bars={filled}
    >
      {[4, 7, 10].map((height, index) => (
        <rect
          key={height}
          className={index < filled ? undefined : "reasoning-meter-off"}
          x={2 + index * 4}
          y={12 - height}
          width={2}
          height={height}
          rx={1}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
