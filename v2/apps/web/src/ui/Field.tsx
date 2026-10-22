import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from "react";

import { Icon } from "./Icon.js";

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
