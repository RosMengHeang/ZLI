import { useId } from "react";

/** An on/off setting: the label and optional hint on the left, the switch on the right. */
export function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  const hintId = useId();
  return (
    <label className={`switch-row${disabled ? " is-disabled" : ""}`}>
      <span className="switch-copy">
        <span className="switch-label">{label}</span>
        {hint ? (
          <span className="switch-hint" id={hintId}>
            {hint}
          </span>
        ) : null}
      </span>
      <input
        className="switch"
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
