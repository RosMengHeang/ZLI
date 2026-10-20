import type { ReactNode, SelectHTMLAttributes } from "react";

import { Icon } from "./Icon.js";

/** A labelled form control with an optional hint underneath. */
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
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child.
    <label className={`field${className ? ` ${className}` : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className={`field-hint${hintTone ? ` is-${hintTone}` : ""}`}>{hint}</span> : null}
    </label>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap">
      <select className={`select${className ? ` ${className}` : ""}`} {...rest}>
        {children}
      </select>
      <Icon name="chevronDown" size={14} />
    </span>
  );
}
