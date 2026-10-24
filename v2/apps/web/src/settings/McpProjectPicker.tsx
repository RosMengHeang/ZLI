import type { ProjectProjection, RuntimeProjection } from "@zli-v2/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { Icon } from "../ui/Icon.js";
import { PROJECT_LIMIT_NOTE, pathName, projectCountText, projectNames, sameProjectPath } from "./mcpServers.js";

const NO_PROJECTS: readonly ProjectProjection[] = [];
const selectProjects = (projection: RuntimeProjection | undefined) => projection?.projects ?? NO_PROJECTS;

/** The projects ZLI knows, by name and path. */
export function useKnownProjects(): readonly ProjectProjection[] {
  return useRuntimeSelector(selectProjects);
}

type ProjectOption = { name: string; path: string };

/** Known projects, then saved paths ZLI no longer lists, so they can still be turned off. */
function projectOptions(known: readonly ProjectProjection[], selected: readonly string[]): ProjectOption[] {
  const options: ProjectOption[] = known.map((project) => ({ name: project.name, path: project.path }));
  for (const path of selected) {
    if (!options.some((option) => sameProjectPath(option.path, path))) options.push({ name: pathName(path), path });
  }
  return options;
}

function toggled(selected: readonly string[], path: string, on: boolean): string[] {
  const rest = selected.filter((entry) => !sameProjectPath(entry, path));
  return on ? [...rest, path] : rest;
}

function ProjectChecks({
  options,
  selected,
  disabled,
  onChange,
}: {
  options: readonly ProjectOption[];
  selected: readonly string[];
  disabled?: boolean | undefined;
  onChange(next: string[]): void;
}) {
  return (
    <ul className="mcp-project-list">
      {options.map((option) => (
        <li key={option.path}>
          <label className="mcp-project">
            <input
              type="checkbox"
              checked={selected.some((path) => sameProjectPath(path, option.path))}
              disabled={disabled}
              aria-label={option.name}
              onChange={(event) => onChange(toggled(selected, option.path, event.target.checked))}
            />
            <span className="mcp-project-copy">
              <span className="mcp-project-name">{option.name}</span>
              <span className="mcp-project-path" title={option.path}>
                {option.path}
              </span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** "All projects" or "Only these projects" with a checkbox per project, for the server form. */
export function McpProjectsField({
  limit,
  selected,
  onChange,
}: {
  limit: boolean;
  selected: readonly string[];
  onChange(patch: { limitProjects?: boolean; projects?: string[] }): void;
}) {
  const known = useKnownProjects();
  const name = useId();
  const options = projectOptions(known, selected);
  return (
    <fieldset className="field mcp-projects">
      <legend className="field-label">Projects</legend>
      <label className="mcp-choice">
        <input type="radio" name={name} checked={!limit} onChange={() => onChange({ limitProjects: false })} />
        All projects
      </label>
      <label className="mcp-choice">
        <input type="radio" name={name} checked={limit} onChange={() => onChange({ limitProjects: true })} />
        Only these projects
      </label>
      {limit ? (
        options.length > 0 ? (
          <ProjectChecks options={options} selected={selected} onChange={(projects) => onChange({ projects })} />
        ) : (
          <p className="settings-empty">No projects yet. Add one to ZLI first.</p>
        )
      ) : null}
      <span className="field-hint">{PROJECT_LIMIT_NOTE}</span>
    </fieldset>
  );
}

/** A small "All projects" button on connector cards that opens the same choice in a popover. */
export function McpProjectsButton({
  title,
  selected,
  disabled,
  onChange,
}: {
  title: string;
  selected: readonly string[];
  disabled?: boolean | undefined;
  onChange(next: string[]): void;
}) {
  const known = useKnownProjects();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (known.length === 0 && selected.length === 0) return null;
  const options = projectOptions(known, selected);
  const label = selected.length === 0 ? "All projects" : projectCountText(selected.length);
  return (
    <span className="mcp-projects-picker" ref={ref}>
      <button
        type="button"
        className="mcp-projects-button"
        aria-label={`Projects for ${title}: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        data-tooltip={selected.length > 0 ? projectNames(selected, known).join(", ") : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <Icon name="chevronDown" size={11} />
      </button>
      {open ? (
        <div className="mcp-projects-popover" role="dialog" aria-label={`Projects for ${title}`} id={popoverId}>
          <label className="mcp-project">
            <input
              type="checkbox"
              checked={selected.length === 0}
              disabled={disabled || selected.length === 0}
              aria-label="All projects"
              onChange={() => onChange([])}
            />
            <span className="mcp-project-copy">
              <span className="mcp-project-name">All projects</span>
            </span>
          </label>
          <ProjectChecks options={options} selected={selected} disabled={disabled} onChange={onChange} />
          <p className="mcp-projects-note">{PROJECT_LIMIT_NOTE}</p>
        </div>
      ) : null}
    </span>
  );
}
