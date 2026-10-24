import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { Icon, type IconName } from "./Icon.js";
import { ariaShortcut, shortcutText } from "./shortcuts.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

type BaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shown in the tooltip and announced through aria-keyshortcuts, for example "Mod+N". */
  shortcut?: string | undefined;
  ref?: Ref<HTMLButtonElement>;
};

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

const iconSizes: Record<ButtonSize, number> = { xs: 12, sm: 13, md: 14, lg: 15 };

/** A text button. Its shortcut shows in the tooltip, never as key caps inside the button. */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  shortcut,
  loading = false,
  tooltip,
  className,
  type = "button",
  disabled,
  children,
  ref,
  ...rest
}: BaseProps & {
  icon?: IconName | undefined;
  /** Replaces the icon with a spinner and blocks clicks while an action runs. */
  loading?: boolean;
  tooltip?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, className)}
      data-tooltip={tooltip}
      data-shortcut={shortcut ? shortcutText(shortcut) : undefined}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span className="spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={iconSizes[size]} />
      ) : null}
      {children}
    </button>
  );
}

/** An icon-only button. The label is its accessible name and its tooltip. */
export function IconButton({
  label,
  icon,
  size = "md",
  iconSize,
  tooltip,
  shortcut,
  pressed,
  tone,
  className,
  type = "button",
  ref,
  ...rest
}: BaseProps & {
  label: string;
  icon: IconName;
  iconSize?: number;
  /** Tooltip text when it should say more than the accessible name. */
  tooltip?: string | undefined;
  pressed?: boolean | undefined;
  tone?: "danger";
}) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "btn btn-ghost btn-icon",
        size !== "md" && `btn-${size}`,
        tone === "danger" && "is-danger",
        className,
      )}
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={tooltip ?? label}
      data-shortcut={shortcut ? shortcutText(shortcut) : undefined}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? iconSizes[size]} />
    </button>
  );
}
