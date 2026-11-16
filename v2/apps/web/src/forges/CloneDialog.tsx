import { type ForgeKind, ProjectCloneResult } from "@zli-v2/contracts";
import { type FormEvent, useRef, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { ConnectorLogo } from "../settings/connectorLogos.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import "./forges.css";

const PARENT_KEY = "zli.clone.parent";
const FORGES: readonly { value: ForgeKind; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "gitea", label: "Gitea" },
];

/** owner/repo with no host: the forge has to be picked. */
export function isShortName(source: string): boolean {
  return /^[\w.-]+\/[\w./-]+$/u.test(source.trim()) && !source.includes(":");
}

/** The folder a clone gets, guessed from what was pasted; the runtime decides for real. */
export function folderName(source: string): string {
  const path = source
    .trim()
    .replace(/^[\w.-]+@[\w.-]+:/u, "")
    .replace(/^[a-z]+:\/\/[^/]+\//iu, "")
    .split("/-/")[0];
  const parts = (path ?? "").split("/").filter(Boolean);
  const isGitLab = /gitlab/iu.test(source);
  const repo = isGitLab ? parts.at(-1) : (parts[1] ?? parts.at(-1));
  return (repo ?? "").replace(/\.git$/u, "");
}

/** The forge a pasted link is on, for its logo; undefined for owner/repo and unknown hosts. */
function forgeOfLink(source: string): ForgeKind | undefined {
  const value = source.toLowerCase();
  if (value.includes("github.")) return "github";
  if (value.includes("gitlab.")) return "gitlab";
  if (value.includes("codeberg.org") || value.includes("gitea.")) return "gitea";
  return undefined;
}

function storedParent(fallback: string | undefined): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? fallback ?? "";
  } catch {
    return fallback ?? "";
  }
}

/** The folder that holds `path`, for the default place to clone into. */
function parentOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.replace(/[\\/]+$/u, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : undefined;
}

/**
 * Clone repository: paste a clone URL, a forge page link, or owner/repo, pick where it goes, and ZLI clones it
 * with git and adds it as a project.
 */
export function CloneDialog({
  nearProject,
  onClose,
  onCloned,
}: {
  /** A project path whose folder is the first place offered to clone into. */
  nearProject?: string | undefined;
  onClose(): void;
  onCloned(path: string): Promise<void> | void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [source, setSource] = useState("");
  const [forge, setForge] = useState<ForgeKind>("github");
  const [parent, setParent] = useState(() => storedParent(parentOf(nearProject)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sourceRef = useRef<HTMLInputElement>(null);
  const short = isShortName(source);
  const name = folderName(source);
  const logo = short ? forge : forgeOfLink(source);
  const separator = parent.includes("\\") ? "\\" : "/";

  const choose = async () => {
    const picked = await bridge?.dialog.openProject();
    if (picked) setParent(picked);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!source.trim() || !parent || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: { type: "project.clone", source: source.trim(), parent, ...(short ? { forge } : {}) },
      });
      if (!response) throw new Error("ZLI is not connected to its runtime.");
      if (!response.accepted) throw new Error(response.error.message);
      const { path } = ProjectCloneResult.parse(response.result);
      try {
        localStorage.setItem(PARENT_KEY, parent);
      } catch {
        // Remembering the folder is a convenience.
      }
      await onCloned(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The clone failed.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      label="Clone repository"
      title="Clone repository"
      subtitle="From GitHub, GitLab, Gitea, or any Git URL."
      size="md"
      initialFocusRef={sourceRef}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="clone-form" onSubmit={(event) => void submit(event)}>
        <div className="dialog-body">
          <label className="clone-field">
            <span className="clone-label">Repository</span>
            <span className="clone-source">
              {logo ? (
                <ConnectorLogo id={logo} title={logo} size={16} />
              ) : (
                <Icon name="globe" size={14} aria-hidden="true" />
              )}
              <input
                ref={sourceRef}
                className="input"
                value={source}
                placeholder="https://github.com/owner/repo, or owner/repo"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setSource(event.target.value)}
              />
            </span>
          </label>
          {short ? (
            <div className="clone-field">
              <span className="clone-label">Forge</span>
              <Segmented<ForgeKind> label="Forge" value={forge} options={FORGES} onChange={setForge} />
            </div>
          ) : null}
          <div className="clone-field">
            <span className="clone-label">Clone into</span>
            <span className="clone-parent">
              <span className="clone-path" title={parent}>
                {parent ? (
                  <>
                    {parent}
                    {name ? (
                      <span className="clone-path-name">
                        {separator}
                        {name}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="clone-path-empty">Choose a folder</span>
                )}
              </span>
              <Button size="sm" disabled={busy || !bridge} onClick={() => void choose()}>
                Choose…
              </Button>
            </span>
          </div>
          {error ? (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={13} />
              {error}
            </p>
          ) : null}
        </div>
        <div className="dialog-footer">
          <span className="dialog-footer-note">Runs git clone, then adds the folder as a project.</span>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!source.trim() || !parent}>
            {busy ? "Cloning" : "Clone"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
