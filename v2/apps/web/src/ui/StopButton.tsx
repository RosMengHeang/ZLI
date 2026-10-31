import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { cx } from "./Button.js";

type StopButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** The accessible name, and the tooltip unless one is given. */
  label: string;
  tooltip?: string | undefined;
  size?: "xs" | "sm" | "md";
  /** Shown next to the glyph; without it the button is round and icon-only. */
  children?: ReactNode;
  /** The work is running right now, so the ring turns. An idle agent can still be stopped, with a still ring. */
  working?: boolean | undefined;
  /** The stop was sent and the work has not ended yet. */
  stopping?: boolean | undefined;
  ref?: Ref<HTMLButtonElement>;
};

/** Ends running work: an agent, a chat turn, or a device that is still booting. */
export function StopButton({
  label,
  tooltip,
  size = "sm",
  children,
  working = true,
  stopping = false,
  className,
  type = "button",
  disabled,
  ref,
  ...rest
}: StopButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "stop-btn",
        size !== "sm" && `stop-btn-${size}`,
        children ? "has-label" : "is-icon",
        !working && "is-idle",
        className,
      )}
      aria-label={label}
      data-tooltip={tooltip ?? label}
      aria-busy={stopping || undefined}
      disabled={disabled || stopping}
      {...rest}
    >
      <span className="stop-btn-glyph" aria-hidden="true">
        <span className="stop-btn-square" />
      </span>
      {children ? <span className="stop-btn-label">{children}</span> : null}
    </button>
  );
}
