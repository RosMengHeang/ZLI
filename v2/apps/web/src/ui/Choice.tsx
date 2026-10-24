import type { ProviderDiscovery } from "@zli-v2/contracts";
import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";
import { ProviderMark } from "./ProviderMark.js";

/** One block of a dialog form: the label sits above its control and the hint below it. */
export function FormSection({
  label,
  htmlFor,
  hint,
  hintTone,
  className,
  children,
}: {
  label: string;
  htmlFor?: string | undefined;
  hint?: ReactNode;
  hintTone?: "warning" | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`form-section${className ? ` ${className}` : ""}`}>
      {htmlFor ? (
        <label className="form-section-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="form-section-label">{label}</span>
      )}
      {children}
      {hint ? <p className={`form-section-hint${hintTone ? ` is-${hintTone}` : ""}`}>{hint}</p> : null}
    </div>
  );
}

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconName;
  title?: string | undefined;
};

/** Mutually exclusive choices drawn as one segmented control, kept as real radio buttons for the keyboard. */
export function ChoiceSegmented<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange(value: T): void;
}) {
  return (
    <div className="choice-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label className="choice-segment" key={option.value} title={option.title}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.icon ? <Icon name={option.icon} size={14} /> : null}
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Agent CLIs as a grid of selectable cards with their mark and installed version. */
export function ProviderOptions({
  name,
  entries,
  value,
  onChange,
}: {
  name: string;
  entries: readonly ProviderDiscovery[];
  value: string | undefined;
  onChange(provider: ProviderDiscovery["provider"]): void;
}) {
  return (
    <div className="provider-options" role="radiogroup" aria-label="Agent">
      {entries.map((entry) => {
        const found = entry.status === "found";
        return (
          <label
            className="provider-option"
            key={entry.provider}
            title={
              found
                ? entry.version
                  ? `${entry.path} (${entry.version})`
                  : entry.path
                : `Not installed. ${entry.reason ?? ""}`.trim()
            }
          >
            <input
              type="radio"
              name={name}
              value={entry.provider}
              checked={value === entry.provider}
              disabled={entry.status === "missing"}
              onChange={() => onChange(entry.provider)}
            />
            <ProviderMark provider={entry.provider} size={18} />
            <span className="provider-option-copy">
              <span className="provider-option-name">{entry.displayName}</span>
              <span className="provider-option-meta">{found ? (entry.version ?? "Installed") : "Not installed"}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
