import {
  type FoundSkill,
  PROJECT_SKILLS_DIR,
  type RuntimeProjection,
  type SkillInstallPreview,
  type SkillListResult,
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
import { SectionHeader } from "./SectionHeader.js";
import {
  agentNames,
  deleteSkill,
  EMPTY_SKILL_DRAFT,
  formatBytes,
  foundLabel,
  installSkills,
  previewSkillInstall,
  projectSkillGaps,
  readSkill,
  type SkillEditorDraft,
  saveSkill,
  setSkillEnabled,
  skillFromDraft,
  skillSyncProblems,
  useSkills,
} from "./skills.js";

type ScopeKind = "user" | "project";
type Editing = { scope: ScopeKind; previousName?: string; draft: SkillEditorDraft; files: string[] };
type Installing = { source: string; scope: ScopeKind; preview?: SkillInstallPreview; selected: string[] };

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
  const nameRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);

  const header = (
    <SectionHeader title="Skills">
      Instructions agents load when a task calls for them. Your skills reach every agent ZLI can find. Project skills
      live in the repository for the whole team.
    </SectionHeader>
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
  const userSkills = result.skills.filter((skill) => skill.scope === "user");
  const projectSkills = result.skills.filter((skill) => skill.scope === "project");
  const syncProblems = skillSyncProblems(result.sync.outcomes);
  const listProject = project?.projectId;
  const scopeOf = (kind: ScopeKind): SkillScope =>
    kind === "project" && project ? { kind: "project", projectId: project.projectId } : { kind: "user" };
  const scopeOptions = [
    { value: "user" as const, label: "Your skills, every project" },
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

  const startNew = () => {
    closeForms();
    flushSync(() => setEditing({ scope: "user", draft: { ...EMPTY_SKILL_DRAFT }, files: [] }));
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

  const startInstall = () => {
    closeForms();
    flushSync(() => setInstalling({ source: "", scope: "user", selected: [] }));
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

  const skillRow = (skill: SkillSummary) => (
    <li className={`mcp-row${skill.enabled ? "" : " is-off"}`} key={deleteKey(skill)}>
      {skill.scope === "user" ? (
        <input
          className="switch"
          type="checkbox"
          role="switch"
          checked={skill.enabled}
          aria-checked={skill.enabled}
          aria-label={`Give agents ${skill.name}`}
          disabled={busy}
          onChange={(event) =>
            void mutate((send) => setSkillEnabled(send, skill.name, event.target.checked, listProject))
          }
        />
      ) : null}
      <span className="mcp-row-copy">
        <span className="skill-row-title">
          <strong>{skill.name}</strong>
          <Badge>{skill.scope === "user" ? "User" : "Project"}</Badge>
        </span>
        <span className="mcp-row-detail">{skill.description || "No description."}</span>
        {skill.problem ? <span className="skill-row-problem">{skill.problem}</span> : null}
        {skill.conflicts?.length ? (
          <span className="skill-row-problem">
            Not copied to {skill.conflicts.join(", ")}: a skill with the same name is already there.
          </span>
        ) : null}
        {skill.source ? (
          <span className="mcp-row-command" title={skill.source}>
            {skill.source}
          </span>
        ) : null}
      </span>
      {confirmDelete === deleteKey(skill) ? (
        <>
          <Button
            variant="ghost"
            size="xs"
            className="is-danger"
            disabled={busy}
            onClick={async () => {
              if (await mutate((send) => deleteSkill(send, scopeOf(skill.scope), skill.name, listProject))) {
                setConfirmDelete(undefined);
                if (editing?.previousName === skill.name && editing.scope === skill.scope) setEditing(undefined);
              }
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(undefined)}>
            Keep
          </Button>
        </>
      ) : (
        <>
          <IconButton
            label={`Edit ${skill.name}`}
            icon="pencil"
            size="xs"
            iconSize={12}
            disabled={busy}
            onClick={() => void startEdit(skill)}
          />
          <IconButton
            label={`Delete ${skill.name}`}
            icon="trash"
            size="xs"
            iconSize={12}
            disabled={busy}
            onClick={() => setConfirmDelete(deleteKey(skill))}
          />
        </>
      )}
    </li>
  );

  const errorLine =
    error && !editing && !installing ? (
      <p className="inline-error" role="alert">
        <Icon name="alert" size={13} />
        {error}
      </p>
    ) : null;

  return (
    <>
      {header}
      {result.problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {result.problem} Saving a change starts them over.
        </p>
      ) : null}
      {projects.length > 1 && project ? (
        <div className="skill-project-picker">
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
        </div>
      ) : null}

      <h3 className="mcp-subhead">Your skills</h3>
      {userSkills.length > 0 ? (
        <ul className="mcp-rows">{userSkills.map(skillRow)}</ul>
      ) : (
        <p className="settings-empty">No skills yet. Write one here or install one from GitHub.</p>
      )}

      {project ? (
        <>
          <h3 className="mcp-subhead">Project skills in {project.name}</h3>
          {projectSkills.length > 0 ? (
            <ul className="mcp-rows">{projectSkills.map(skillRow)}</ul>
          ) : (
            <p className="settings-empty">No skills in {PROJECT_SKILLS_DIR} yet.</p>
          )}
        </>
      ) : null}

      {errorLine}

      {editing ? (
        <form
          className="mcp-editor"
          aria-label={editing.previousName === undefined ? "New skill" : "Edit skill"}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {editing.previousName === undefined && project ? (
            <div className="field">
              <span className="field-label">Save to</span>
              <Select<ScopeKind>
                className="input-sm"
                label="Save to"
                value={editing.scope}
                options={scopeOptions}
                onChange={(scope) => setEditing((current) => (current ? { ...current, scope } : current))}
              />
            </div>
          ) : null}
          <Field label="Name" hint="Lowercase letters, digits, and hyphens. Agents show it as the skill's name.">
            <input
              ref={nameRef}
              className="input input-sm is-mono"
              value={editing.draft.name}
              maxLength={64}
              spellCheck={false}
              placeholder="code-review"
              onChange={(event) => setDraft({ name: event.target.value.toLowerCase().replace(/[\s_]+/gu, "-") })}
            />
          </Field>
          <Field label="Description" hint="What the skill does and when to use it. Agents read this to decide.">
            <textarea
              className="textarea"
              rows={2}
              maxLength={1024}
              value={editing.draft.description}
              onChange={(event) => setDraft({ description: event.target.value })}
            />
          </Field>
          <Field
            label="Instructions"
            hint={
              editing.files.length > 0
                ? `Markdown. The other files in the folder stay as they are: ${editing.files.join(", ")}.`
                : "Markdown the agent follows when it uses the skill."
            }
          >
            <textarea
              className="textarea is-mono"
              rows={10}
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
          className="mcp-editor"
          aria-label="Install from GitHub"
          onSubmit={(event) => {
            event.preventDefault();
            void lookUp();
          }}
        >
          <Field
            label="GitHub folder"
            hint="A link such as https://github.com/anthropics/skills/tree/main/skills, or owner/repo. ZLI copies every folder with a SKILL.md."
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
              <Select<ScopeKind>
                className="input-sm"
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
      ) : (
        <div className="settings-actions skill-actions">
          <Button size="sm" icon="plus" disabled={busy} onClick={startNew}>
            New skill
          </Button>
          <Button size="sm" icon="download" disabled={busy} onClick={startInstall}>
            Install from GitHub
          </Button>
        </div>
      )}

      {result.found.length > 0 ? (
        <>
          <h3 className="mcp-subhead">Already in agent folders</h3>
          <ul className="mcp-rows">
            {result.found.map((skill) => (
              <FoundRow key={skill.path} skill={skill} />
            ))}
          </ul>
        </>
      ) : null}

      <SyncFootnote result={result} />
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
            <span className="mcp-row-copy">
              <strong>{candidate.name}</strong>
              <span className="mcp-row-detail">{candidate.description || "No description."}</span>
              <span className="mcp-row-command">
                {candidate.path}, {candidate.files === 1 ? "1 file" : `${candidate.files} files`},{" "}
                {formatBytes(candidate.bytes)}
              </span>
              {candidate.problem ? <span className="skill-row-problem">{candidate.problem}</span> : null}
              {!candidate.problem && candidate.exists ? (
                <span className="skill-row-problem">Replaces the skill with this name.</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function FoundRow({ skill }: { skill: FoundSkill }) {
  return (
    <li className="mcp-row">
      <span className="mcp-row-copy">
        <span className="skill-row-title">
          <strong>{skill.name}</strong>
          <Badge tone="info" title={skill.agents.length > 0 ? `Read by ${agentNames(skill.agents)}` : skill.dir}>
            {foundLabel(skill)}
          </Badge>
        </span>
        <span className="mcp-row-detail">{skill.description || "No description."}</span>
        {skill.problem ? <span className="skill-row-problem">{skill.problem}</span> : null}
        <span className="mcp-row-command" title={skill.path}>
          {skill.path}
        </span>
      </span>
    </li>
  );
}

function SyncFootnote({ result }: { result: SkillListResult }) {
  const gaps = projectSkillGaps();
  return (
    <>
      {result.project ? (
        <p className="settings-footnote">
          Project skills are saved in {result.project.skillsPath}. Commit them so new worktrees and your team get them.
          {gaps.map(
            ({ agent, dirs }) =>
              ` ${providerDisplayName(agent, undefined)} reads project skills only from ${dirs.join(", ")}, so it does not see these.`,
          )}
        </p>
      ) : null}
      <p className="settings-footnote">
        {result.sync.enabled
          ? "ZLI gives your enabled skills only to agents it starts. It copies them into each worktree's .agents/skills, which most agents read, and .claude/skills for Claude Code, hides the copies from git, and deletes them when ZLI quits."
          : `ZLI keeps your skills in ${result.libraryPath} and does not copy them anywhere.`}
      </p>
    </>
  );
}
