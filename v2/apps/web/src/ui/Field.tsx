import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from "react";

import { Picker, type PickerOption } from "./Picker.js";

/**
 * A labelled form control with an optional hint underneath. The hint sits outside the label so it
 * describes the control without becoming part of its accessible name.
 */
export function Field({
  label,
  hint,
  hintTone,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  hintTone?: "warning";
  className?: string;
  children: ReactNode;
}) {
  const hintId = useId();
  const control =
    hint && isValidElement(children)
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": hintId })
      : children;
  return (
    <div className={`field${className ? ` ${className}` : ""}`}>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child. */}
      <label className="field-control">
        <span className="field-label">{label}</span>
        {control}
      </label>
      {hint ? (
        <span className={`field-hint${hintTone ? ` is-${hintTone}` : ""}`} id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A form select that opens the app's dark list instead of the operating system's light one. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  id,
  disabled = false,
  className,
}: {
  label: string;
  value: T;
  options: readonly PickerOption<T>[];
  onChange(value: T): void;
  id?: string | undefined;
  disabled?: boolean;
  className?: string | undefined;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Picker
      variant="field"
      id={id}
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      className={className}
    >
      {current?.icon}
      <span className="picker-trigger-label">{current?.label ?? value}</span>
    </Picker>
  );
}
