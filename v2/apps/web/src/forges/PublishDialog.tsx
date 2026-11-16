import { type ForgeKind, ProjectPublishResult, type WorktreeProjection } from "@zli-v2/contracts";
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

import { openExternalLink } from "../review/links.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { ConnectorLogo } from "../settings/connectorLogos.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { Switch } from "../ui/Switch.js";
import "./forges.css";

const FORGES: readonly { value: ForgeKind; label: string; cli: string }[] = [
  { value: "github", label: "GitHub", cli: "gh" },
  { value: "gitlab", label: "GitLab", cli: "glab" },
  { value: "gitea", label: "Gitea", cli: "tea" },
];

/** A repository name from a folder: what forges accept, from the folder's own name. */
export function repositoryName(path: string): string {
  const folder =
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? "";
  return folder.replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "repository";
}

/** Publish: creates a repository on the picked forge, adds it as origin, and pushes the current branch. */
export function PublishDialog({
  worktree,
  onClose,
  onPublished,
}: {
  worktree: WorktreeProjection;
  onClose(): void;
  onPublished(url: string): void;
}) {
  const { bridge, dispatch } = useRuntime();
  // Named after the project's folder, not the worktree's, which is usually named after its branch.
  const projectPath = useRuntimeSelector(
    (projection) => projection?.projects.find((project) => project.projectId === worktree.projectId)?.path,
  );
  const [forge, setForge] = useState<ForgeKind>("github");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState(() => repositoryName(projectPath ?? worktree.path));
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [url, setUrl] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);
  const picked = FORGES.find((entry) => entry.value === forge) ?? FORGES[0];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "project.publish",
          worktreeId: worktree.worktreeId,
          forge,
          name: name.trim(),
          private: isPrivate,
          ...(owner.trim() ? { owner: owner.trim() } : {}),
        },
      });
      if (!response) throw new Error("ZLI is not connected to its runtime.");
      if (!response.accepted) throw new Error(response.error.message);
      const published = ProjectPublishResult.parse(response.result).url;
      setUrl(published);
      onPublished(published);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Publishing failed.");
    } finally {
      setBusy(false);
    }
  };

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) onClose();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside the dialog closes it.
    <div onKeyDown={closeOnEscape}>
      <Dialog
        label="Publish repository"
        title={url ? "Published" : "Publish repository"}
        subtitle={url ? undefined : "Creates the repository on a forge, adds it as origin, and pushes this branch."}
        size="md"
        initialFocusRef={nameRef}
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        {url ? (
          <>
            <div className="dialog-body">
              <p className="pr-result" role="status">
                <Icon name="check" size={14} />
                {worktree.branch} is on {picked?.label}.
              </p>
              <a className="pr-url" href={url} onClick={(event) => event.preventDefault()}>
                {url}
              </a>
            </div>
            <div className="dialog-footer">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" icon="externalLink" onClick={() => void openExternalLink(bridge, url)}>
                Open in browser
              </Button>
            </div>
          </>
        ) : (
          <form className="clone-form" onSubmit={(event) => void submit(event)}>
            <div className="dialog-body">
              <fieldset className="clone-field publish-fieldset">
                <legend className="clone-label">Forge</legend>
                <div className="publish-forges">
                  {FORGES.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      aria-pressed={forge === entry.value}
                      className={`publish-forge${forge === entry.value ? " is-on" : ""}`}
                      disabled={busy}
                      onClick={() => setForge(entry.value)}
                    >
                      <ConnectorLogo id={entry.value} title={entry.label} size={20} />
                      {entry.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="publish-names">
                <label className="clone-field">
                  <span className="clone-label">Owner or group</span>
                  <input
                    className="input"
                    value={owner}
                    placeholder="Your account"
                    spellCheck={false}
                    disabled={busy}
                    onChange={(event) => setOwner(event.target.value)}
                  />
                </label>
                <label className="clone-field">
                  <span className="clone-label">Name</span>
                  <input
                    ref={nameRef}
                    className="input"
                    value={name}
                    maxLength={100}
                    spellCheck={false}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              </div>
              <Switch
                label="Private"
                hint="Only people you add can see it."
                checked={isPrivate}
                onChange={setPrivate}
              />
              {error ? (
                <p className="inline-error" role="alert">
                  <Icon name="alert" size={13} />
                  {error}
                </p>
              ) : null}
            </div>
            <div className="dialog-footer">
              <span className="dialog-footer-note">Uses {picked?.cli}, signed in with your account.</span>
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" loading={busy} disabled={!name.trim()}>
                {busy ? "Publishing" : `Publish to ${picked?.label}`}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
