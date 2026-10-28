import "./limits.css";

const RING_RADIUS = 5.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** How much of one limit window is used, as a ring that fills clockwise from the top. */
export function LimitRing({ percent, className }: { percent: number; className?: string }) {
  return (
    <svg
      className={`limit-ring${className ? ` ${className}` : ""}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <circle className="limit-ring-track" cx="8" cy="8" r={RING_RADIUS} />
      <circle
        className="limit-ring-fill"
        cx="8"
        cy="8"
        r={RING_RADIUS}
        strokeDasharray={`${(percent / 100) * RING_LENGTH} ${RING_LENGTH}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
