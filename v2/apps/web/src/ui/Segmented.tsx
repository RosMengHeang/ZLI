import { Icon, type IconName } from "./Icon.js";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconName;
  /** Accessible name when the visible label can be hidden at narrow widths. */
  ariaLabel?: string;
  tooltip?: string;
};

/** A small set of mutually exclusive choices, shown as a group of pressed buttons. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange(value: T): void;
  className?: string;
}) {
  return (
    <fieldset className={`segmented${className ? ` ${className}` : ""}`} aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          className="segmented-item"
          type="button"
          aria-pressed={option.value === value}
          aria-label={option.ariaLabel}
          data-tooltip={option.tooltip}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={12} /> : null}
          <span className="segmented-label">{option.label}</span>
        </button>
      ))}
    </fieldset>
  );
}
