import {
  type FoundSkill,
  PROJECT_SKILLS_DIR,
  type RuntimeProjection,
  type SkillInstallPreview,
  type SkillScope,
  type SkillSummary,
} from "@zli-v2/contracts";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";

import { providerDisplayName } from "../agent/providers.js";
import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { SettingsPageHeader } from "./SettingsLayout.js";
import {
  agentNames,
  deleteSkill,
  EMPTY_SKILL_DRAFT,
  formatBytes,
  foundLabel,
  installSkills,
  previewSkillInstall,
  projectSkillGaps,
  readersLabel,
  readSkill,
  type SkillEditorDraft,
  saveSkill,
  setSkillEnabled,
  skillFromDraft,
  skillMatches,
  skillReaders,
  skillSyncProblems,
  useSkills,
} from "./skills.js";
import "./skills.css";

type ScopeKind = "user" | "project";
type SkillTab = ScopeKind | "found";
type Editing = { scope: ScopeKind; previousName?: string; draft: SkillEditorDraft; files: string[] };
type Installing = { source: string; scope: ScopeKind; preview?: SkillInstallPreview; selected: string[] };

/** Past this many skills, counting the ones found on this computer, the page gets a search box. */
const SEARCH_FROM = 7;

/** A starting point for someone who has never written a skill. */
const EXAMPLE_SKILL: SkillEditorDraft = {
  name: "commit-message",
  description:
    "Writes commit messages in this repository's style. Use when committing changes or when asked for a commit message.",
  instructions: [
    "# Commit messages",
    "",
    "1. Run `git log -n 20 --oneline` and match the style you see.",
    '2. Keep the subject under 72 characters and in the imperative ("Add", "Fix").',
    "3. Say why in the body when the diff does not make it obvious.",
    "",
  ].join("\n"),
};
const EXAMPLE_SOURCE = "https://github.com/anthropics/skills";

export function SkillsSection({
  projection,
  initialProjectId,
}: {
  projection: RuntimeProjection | undefined;
  initialProjectId?: string | undefined;
}) {
  const projects = projection?.projects ?? [];
  const [projectId, setProjectId] = useState(
    projects.find((project) => project.projectId === initialProjectId)?.projectId ?? projects[0]?.projectId,
  );
  const project = projects.find((candidate) => candidate.projectId === projectId) ?? projects[0];
  const { state, reload, dispatch, apply } = useSkills(project?.projectId);
  const [editing, setEditing] = useState<Editing>();
  const [installing, setInstalling] = useState<Installing>();
  const [problem, setProblem] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SkillTab>("user");
  const nameRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);

  const header = (
    <SettingsPageHeader title="Skills">
      Instructions an agent loads on its own when a skill's description fits the task. To use one on purpose, ask for it
      by name or type $ in the message box.
    </SettingsPageHeader>
  );

  if (state.status === "loading") {
    return (
      <>
        {header}
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading skills
        </p>
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        {header}
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {state.message}
        </p>
        <div className="settings-actions">
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const result = state.result;
  const searching = result.skills.length + result.found.length >= SEARCH_FROM && query.trim() !== "";
  const shown = (skill: SkillSummary) => !searching || skillMatches(skill, query);
  const userSkills = result.skills.filter((skill) => skill.scope === "user");
  const projectSkills = result.skills.filter((skill) => skill.scope === "project");
  const syncProblems = skillSyncProblems(result.sync.outcomes);
  const listProject = project?.projectId;
  const scopeOf = (kind: ScopeKind): SkillScope =>
    kind === "project" && project ? { kind: "project", projectId: project.projectId } : { kind: "user" };
  const scopeOptions = [
    { value: "user" as const, label: "Yours, every project" },
    ...(project ? [{ value: "project" as const, label: `${project.name}, in ${PROJECT_SKILLS_DIR}` }] : []),
  ];

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const mutate = (work: Parameters<typeof apply>[0]) => run(() => apply(work));

  const closeForms = () => {
    setEditing(undefined);
    setInstalling(undefined);
    setProblem(undefined);
    setError(undefined);
    setConfirmDelete(undefined);
  };

  const startNew = (draft: SkillEditorDraft = EMPTY_SKILL_DRAFT) => {
    closeForms();
    flushSync(() => setEditing({ scope: "user", draft: { ...draft }, files: [] }));
    nameRef.current?.focus();
  };

  const startEdit = (skill: SkillSummary) =>
    run(async () => {
      closeForms();
      const document = await readSkill(dispatch, scopeOf(skill.scope), skill.name);
      flushSync(() =>
        setEditing({
          scope: skill.scope,
          previousName: skill.name,
          draft: { name: document.name, description: document.description, instructions: document.instructions },
          files: document.files,
        }),
      );
      nameRef.current?.focus();
    });

  const submit = async () => {
    if (!editing) return;
    const applied = skillFromDraft(editing.draft);
    if ("problem" in applied) {
      setProblem(applied.problem);
      return;
    }
    setProblem(undefined);
    const saved = await mutate((send) =>
      saveSkill(send, {
        scope: scopeOf(editing.scope),
        previousName: editing.previousName,
        skill: applied.skill,
        projectId: listProject,
      }),
    );
    if (saved) setEditing(undefined);
  };

  const setDraft = (patch: Partial<SkillEditorDraft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  const startInstall = (source = "") => {
    closeForms();
    flushSync(() => setInstalling({ source, scope: "user", selected: [] }));
    sourceRef.current?.focus();
  };

  const lookUp = () =>
    run(async () => {
      if (!installing) return;
      const preview = await previewSkillInstall(dispatch, installing.source, scopeOf(installing.scope));
      const selected = preview.candidates.filter((candidate) => !candidate.problem).map((candidate) => candidate.name);
      setInstalling((current) => (current ? { ...current, preview, selected } : current));
    });

  const install = async () => {
    if (!installing?.preview) return;
    const { source, scope, selected } = installing;
    const done = await mutate((send) =>
      installSkills(send, { source, scope: scopeOf(scope), names: selected, projectId: listProject }),
    );
    if (done) setInstalling(undefined);
  };

  const deleteKey = (skill: SkillSummary) => `${skill.scope}:${skill.name}`;

  const card = (skill: SkillSummary) => (
    <SkillCard
      key={deleteKey(skill)}
      skill={skill}
      syncEnabled={result.sync.enabled}
      busy={busy}
      confirming={confirmDelete === deleteKey(skill)}
      onToggle={(enabled) => void mutate((send) => setSkillEnabled(send, skill.name, enabled, listProject))}
      onEdit={() => void startEdit(skill)}
      onAskDelete={() => setConfirmDelete(deleteKey(skill))}
      onKeep={() => setConfirmDelete(undefined)}
      onDelete={async () => {
        if (await mutate((send) => deleteSkill(send, scopeOf(skill.scope), skill.name, listProject))) {
          setConfirmDelete(undefined);
          if (editing?.previousName === skill.name && editing.scope === skill.scope) setEditing(undefined);
        }
      }}
    />
  );

  const formOpen = editing !== undefined || installing !== undefined;

  const errorLine =
    error && !formOpen ? (
      <p className="inline-error" role="alert">
        <Icon name="alert" size={13} />
        {error}
      </p>
    ) : null;

  const editForm = editing ? (
    <form
      className="mcp-editor skill-form"
      aria-label={editing.previousName === undefined ? "New skill" : "Edit skill"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h5 className="skill-form-title">
        {editing.previousName === undefined ? "Write a skill" : `Edit ${editing.previousName}`}
      </h5>
      {editing.previousName === undefined && project ? (
        <div className="field">
          <span className="field-label">Save to</span>
          <Segmented<ScopeKind>
            label="Save to"
            value={editing.scope}
            options={scopeOptions}
            onChange={(scope) => setEditing((current) => (current ? { ...current, scope } : current))}
          />
        </div>
      ) : null}
      <div className="skill-form-pair">
        <Field label="Name" hint="Lowercase letters, digits, and hyphens.">
          <input
            ref={nameRef}
            className="input input-sm is-mono"
            value={editing.draft.name}
            maxLength={64}
            spellCheck={false}
            placeholder="commit-message"
            onChange={(event) => setDraft({ name: event.target.value.toLowerCase().replace(/[\s_]+/gu, "-") })}
          />
        </Field>
        <Field label="Description" hint="What it does and when to use it. Agents read this to decide.">
          <textarea
            className="textarea"
            rows={2}
            maxLength={1024}
            value={editing.draft.description}
            onChange={(event) => setDraft({ description: event.target.value })}
          />
        </Field>
      </div>
      <Field
        label="Instructions"
        hint={
          editing.files.length > 0
            ? `Markdown. The other files in the folder stay as they are: ${editing.files.join(", ")}.`
            : "Markdown the agent follows when it uses the skill."
        }
      >
        <textarea
          className="textarea is-mono skill-form-instructions"
          rows={14}
          value={editing.draft.instructions}
          spellCheck={false}
          onChange={(event) => setDraft({ instructions: event.target.value })}
        />
      </Field>
      {problem || error ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {problem ?? error}
        </p>
      ) : null}
      <div className="mcp-editor-actions">
        <Button size="sm" onClick={closeForms}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy}>
          {editing.previousName === undefined ? "Add skill" : "Save changes"}
        </Button>
      </div>
    </form>
  ) : installing ? (
    <form
      className="mcp-editor skill-form"
      aria-label="Install from GitHub"
      onSubmit={(event) => {
        event.preventDefault();
        void lookUp();
      }}
    >
      <h5 className="skill-form-title">Install from GitHub</h5>
      <Field
        label="GitHub folder"
        hint={
          <>
            A link or owner/repo. ZLI copies every folder in it that has a SKILL.md.
            {installing.source.trim() === "" ? (
              <>
                {" "}
                <button
                  type="button"
                  className="connector-link text-link"
                  onClick={() =>
                    setInstalling((current) => (current ? { ...current, source: EXAMPLE_SOURCE } : current))
                  }
                >
                  Try anthropics/skills
                </button>
              </>
            ) : null}
          </>
        }
      >
        <input
          ref={sourceRef}
          className="input input-sm is-mono"
          value={installing.source}
          spellCheck={false}
          placeholder="owner/repo"
          onChange={(event) => {
            const source = event.target.value;
            setInstalling((current) => (current ? { source, scope: current.scope, selected: [] } : current));
          }}
        />
      </Field>
      {project ? (
        <div className="field">
          <span className="field-label">Install to</span>
          <Segmented<ScopeKind>
            label="Install to"
            value={installing.scope}
            options={scopeOptions}
            onChange={(scope) =>
              setInstalling((current) => (current ? { source: current.source, scope, selected: [] } : current))
            }
          />
        </div>
      ) : null}
      {installing.preview ? (
        <InstallChoices
          preview={installing.preview}
          selected={installing.selected}
          onChange={(selected) => setInstalling((current) => (current ? { ...current, selected } : current))}
        />
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {error}
        </p>
      ) : null}
      <div className="mcp-editor-actions">
        <Button size="sm" onClick={closeForms}>
          Cancel
        </Button>
        {installing.preview ? (
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={installing.selected.length === 0}
            onClick={() => void install()}
          >
            {installing.selected.length === 1 ? "Install 1 skill" : `Install ${installing.selected.length} skills`}
          </Button>
        ) : (
          <Button size="sm" variant="primary" type="submit" loading={busy} disabled={!installing.source.trim()}>
            Look up
          </Button>
        )}
      </div>
    </form>
  ) : null;

  const visibleUser = userSkills.filter(shown);
  const visibleProject = projectSkills.filter(shown);
  const visibleFound = result.found.filter((skill) => !searching || skillMatches(skill, query));
  const noMatch = <p className="skill-list-empty">Nothing matches “{query.trim()}”.</p>;
  const tabs: Array<{ id: SkillTab; label: string; count: number }> = [
    { id: "user", label: "Yours", count: userSkills.length },
    ...(project ? [{ id: "project" as const, label: "Project", count: projectSkills.length }] : []),
    ...(result.found.length > 0
      ? [{ id: "found" as const, label: "On this computer", count: result.found.length }]
      : []),
  ];
  const current: SkillTab = tabs.some((entry) => entry.id === tab) ? tab : "user";
  const rows = (skills: readonly SkillSummary[]) => <ul className="skill-list">{skills.map(card)}</ul>;

  return (
    <>
      {header}
      {result.problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {result.problem} Saving a change starts them over.
        </p>
      ) : null}

      {/* One bar for everything: where to look on the left, what to do on the right. */}
      <div className="skill-bar">
        <div className="skill-tabs" role="tablist" aria-label="Skills">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={current === entry.id}
              className="skill-tab"
              onClick={() => {
                closeForms();
                setTab(entry.id);
              }}
            >
              {entry.label}
              <span className="skill-count">{entry.count}</span>
            </button>
          ))}
        </div>
        <div className="skill-bar-actions">
          {result.skills.length + result.found.length >= SEARCH_FROM ? (
            <div className="settings-search skill-search">
              <Icon name="search" size={13} />
              <input
                className="input input-sm"
                type="search"
                aria-label="Search skills"
                placeholder="Search"
                value={query}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
            </div>
          ) : null}
          <Button size="sm" icon="download" disabled={busy} onClick={() => startInstall()}>
            Install from GitHub
          </Button>
          <Button size="sm" variant="primary" icon="plus" disabled={busy} onClick={() => startNew()}>
            Write a skill
          </Button>
        </div>
      </div>

      {formOpen ? <div className="skill-form-slot">{editForm}</div> : null}
      {errorLine}

      {current === "user" ? (
        <section className="skill-panel" aria-label="Your skills">
          {userSkills.length === 0 && !formOpen ? (
            <SkillsEmpty onExample={() => startNew(EXAMPLE_SKILL)} onBrowse={() => startInstall(EXAMPLE_SOURCE)} />
          ) : visibleUser.length > 0 ? (
            rows(visibleUser)
          ) : searching ? (
            noMatch
          ) : null}
          <p className="skill-note">
            {result.sync.enabled
              ? "Every project. ZLI copies the ones that are on into each worktree it starts an agent in, keeps them out of git, and removes them when it quits."
              : `Every project. Kept in ${result.libraryPath}; ZLI does not copy them anywhere.`}
          </p>
        </section>
      ) : null}

      {current === "project" && project ? (
        <section className="skill-panel" aria-label={`Project skills in ${project.name}`}>
          <div className="skill-panel-head">
            {projects.length > 1 ? (
              <Select<string>
                className="input-sm"
                label="Project"
                value={project.projectId}
                options={projects.map((candidate) => ({
                  value: candidate.projectId,
                  label: candidate.name,
                  icon: <Icon name="folder" size={15} />,
                }))}
                onChange={(next) => {
                  closeForms();
                  setProjectId(next as typeof projectId);
                }}
              />
            ) : (
              <span className="skill-panel-project">
                <Icon name="folder" size={14} />
                {project.name}
              </span>
            )}
          </div>
          {visibleProject.length > 0 ? (
            rows(visibleProject)
          ) : searching ? (
            noMatch
          ) : (
            <div className="skill-list-empty">
              <span>No skills in {project.name} yet.</span>
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                onClick={() => {
                  startNew();
                  setEditing((editing) => (editing ? { ...editing, scope: "project" } : editing));
                }}
              >
                Write one for this project
              </Button>
            </div>
          )}
          <p className="skill-note">
            Saved in {result.project?.skillsPath ?? PROJECT_SKILLS_DIR}. Commit the folder and your team gets them too.
            {projectSkillGaps().map(
              ({ agent, dirs }) => ` ${providerDisplayName(agent, undefined)} reads only ${dirs.join(", ")}.`,
            )}
          </p>
        </section>
      ) : null}

      {current === "found" ? (
        <section className="skill-panel" aria-label="On this computer">
          {visibleFound.length > 0 ? (
            <ul className="skill-list">
              {visibleFound.map((skill) => (
                <FoundRow key={skill.path} skill={skill} />
              ))}
            </ul>
          ) : (
            noMatch
          )}
          <p className="skill-note">
            Agents already read these from their own folders, and ZLI leaves them as they are. To turn one on and off
            here, move its folder into {result.libraryPath}.
          </p>
        </section>
      ) : null}

      {syncProblems.length > 0 ? (
        <ul className="mcp-settings-problems">
          {syncProblems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** What a skill is, with one to start from, for someone who has none yet. */
function SkillsEmpty({ onExample, onBrowse }: { onExample(): void; onBrowse(): void }) {
  return (
    <div className="skill-empty">
      <span className="skill-empty-icon" aria-hidden="true">
        <Icon name="sparkle" size={18} />
      </span>
      <p className="skill-empty-lead">No skills yet.</p>
      <p className="skill-empty-copy">
        A skill teaches an agent one job. <code>commit-message</code>, for example, could make every agent write commit
        messages the way this repository does.
      </p>
      <div className="skill-empty-actions">
        <Button size="sm" icon="pencil" onClick={onExample}>
          Start from this example
        </Button>
        <Button size="sm" icon="download" onClick={onBrowse}>
          Browse anthropics/skills
        </Button>
      </div>
    </div>
  );
}

/** One skill as a row: name and what it does on the left, who reads it and its switch on the right. */
function SkillCard({
  skill,
  syncEnabled,
  busy,
  confirming,
  onToggle,
  onEdit,
  onAskDelete,
  onKeep,
  onDelete,
}: {
  skill: SkillSummary;
  syncEnabled: boolean;
  busy: boolean;
  confirming: boolean;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onAskDelete(): void;
  onKeep(): void;
  onDelete(): void;
}) {
  const readers = skill.scope === "project" || syncEnabled ? skillReaders(skill.scope) : [];
  const missing =
    skill.scope === "project" ? projectSkillGaps().map(({ agent }) => providerDisplayName(agent, undefined)) : [];
  const readersTitle = [
    readers.length > 0 ? `Read by ${agentNames(readers)}.` : "",
    missing.length > 0 ? `${missing.join(" and ")} does not read ${PROJECT_SKILLS_DIR}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const notes = [
    skill.problem,
    skill.conflicts?.length
      ? `Not copied to ${skill.conflicts.join(", ")}: a skill with the same name is already there.`
      : undefined,
  ].filter(Boolean);
  return (
    <li className={`skill-card${skill.enabled ? "" : " is-off"}`}>
      <span className="skill-card-avatar" aria-hidden="true">
        {skill.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="skill-card-main">
        <span className="skill-card-line">
          <strong className="skill-card-name" title={skill.name}>
            {skill.name}
          </strong>
          <span className="skill-card-chips">
            <span className="account-chip">{skill.scope === "user" ? "Yours" : "Project"}</span>
            {readers.length > 0 ? (
              <span className="account-chip" title={readersTitle}>
                {readersLabel(readers)}
              </span>
            ) : null}
            {!skill.enabled ? <span className="account-chip">Off</span> : null}
          </span>
        </span>
        <span className="skill-card-description" title={skill.description || undefined}>
          {skill.description || "No description."}
        </span>
        {notes.map((note) => (
          <span key={note} className="skill-card-note is-warning">
            {note}
          </span>
        ))}
        {skill.source ? (
          <span className="skill-card-path" title={skill.source}>
            {skill.source}
          </span>
        ) : null}
      </span>
      <span className="skill-card-actions">
        {confirming ? (
          <>
            <span className="skill-card-ask">Delete {skill.name}?</span>
            <Button variant="ghost" size="xs" className="is-danger" disabled={busy} onClick={onDelete}>
              Delete
            </Button>
            <Button variant="ghost" size="xs" onClick={onKeep}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <span className="skill-card-menu">
              <IconButton
                label={`Edit ${skill.name}`}
                icon="pencil"
                size="xs"
                iconSize={12}
                disabled={busy}
                onClick={onEdit}
              />
              <IconButton
                label={`Delete ${skill.name}`}
                icon="trash"
                size="xs"
                iconSize={12}
                disabled={busy}
                onClick={onAskDelete}
              />
            </span>
            {skill.scope === "user" ? (
              <input
                className="switch"
                type="checkbox"
                role="switch"
                checked={skill.enabled}
                aria-checked={skill.enabled}
                aria-label={`Give agents ${skill.name}`}
                disabled={busy}
                onChange={(event) => onToggle(event.target.checked)}
              />
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}

function InstallChoices({
  preview,
  selected,
  onChange,
}: {
  preview: SkillInstallPreview;
  selected: readonly string[];
  onChange(selected: string[]): void;
}) {
  return (
    <fieldset className="skill-candidates">
      <legend className="field-label">
        Found in {preview.owner}/{preview.repo}
        {preview.path ? `/${preview.path}` : ""}
      </legend>
      {preview.candidates.map((candidate) => {
        const checked = selected.includes(candidate.name);
        return (
          <label className={`skill-candidate${candidate.problem ? " is-off" : ""}`} key={candidate.path}>
            <input
              type="checkbox"
              checked={checked}
              disabled={candidate.problem !== undefined}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, candidate.name]
                    : selected.filter((name) => name !== candidate.name),
                )
              }
            />
            <span className="skill-candidate-copy">
              <strong>{candidate.name}</strong>
              <span className="skill-candidate-detail">{candidate.description || "No description."}</span>
              <span className="skill-card-path">
                {candidate.path}, {candidate.files === 1 ? "1 file" : `${candidate.files} files`},{" "}
                {formatBytes(candidate.bytes)}
              </span>
              {candidate.problem ? <span className="skill-card-note is-warning">{candidate.problem}</span> : null}
              {!candidate.problem && candidate.exists ? (
                <span className="skill-card-note is-warning">Replaces the skill with this name.</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** A skill an agent already reads from its own folder; ZLI only lists it. */
function FoundRow({ skill }: { skill: FoundSkill }) {
  return (
    <li className="skill-card is-found">
      <span className="skill-card-avatar" aria-hidden="true">
        {skill.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="skill-card-main">
        <span className="skill-card-line">
          <strong className="skill-card-name" title={skill.name}>
            {skill.name}
          </strong>
          <span className="skill-card-chips">
            <Badge tone="info" title={skill.agents.length > 0 ? `Read by ${agentNames(skill.agents)}` : skill.dir}>
              {foundLabel(skill)}
            </Badge>
          </span>
        </span>
        <span className="skill-card-description" title={skill.description || undefined}>
          {skill.description || "No description."}
        </span>
        {skill.problem ? <span className="skill-card-note is-warning">{skill.problem}</span> : null}
        <span className="skill-card-path" title={skill.path}>
          {skill.path}
        </span>
      </span>
    </li>
  );
}
