import type { Account, ProjectProjection, RuntimeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { permissionHint, permissionOptions } from "../chat/permissions.js";
import type { NotificationSettings } from "../runtime/bridge.js";
import { samePath } from "../sessions/launch.js";
import { deriveSessions, type SessionMode, sessionStopCommands } from "../sessions/sessions.js";
import { defaultShortcut, shortcutActions, shortcutFromEvent, shortcutProblem } from "../shell/keybindings.js";
import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { modelOptions } from "../ui/ModelMark.js";
import type { PickerOption } from "../ui/Picker.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Switch } from "../ui/Switch.js";
import { shortcutText } from "../ui/shortcuts.js";
import { UpdatesSection } from "../updates/UpdatesSection.js";
import type { Updates } from "../updates/useUpdates.js";
import { AccountsSection } from "./AccountsSection.js";
import { AgentMessagesSection } from "./AgentMessagesSection.js";
import {
  type AppSettings,
  branchFromTemplate,
  DEFAULT_BRANCH_TEMPLATE,
  type FileTreePosition,
  type LaunchDefaults,
  MAX_BRANCH_TEMPLATE,
  type ShortcutId,
  updateAppSettings,
  useAppSettings,
} from "./appSettings.js";
import { IntegrationsSection, type IntegrationsView } from "./IntegrationsSection.js";
import { IssuesSection } from "./IssuesSection.js";
import { MobileSection } from "./MobileSection.js";
import { SectionHeader, SettingGroup, SettingRow } from "./SectionHeader.js";
import { SkillsSection } from "./SkillsSection.js";
import { UsageSection } from "./UsageSection.js";
import "./settings.css";

export type SettingsSection =
  | "agents"
  | "agentMessages"
  | "accounts"
  | "usage"
  | "projects"
  | "worktrees"
  | "files"
  | "integrations"
  | "skills"
  | "issues"
  | "mobile"
  | "shortcuts"
  | "notifications"
  | "updates";

type SectionGroup = "Agents" | "Workspace" | "Tools" | "App";

type SectionEntry = {
  id: SettingsSection;
  label: string;
  icon: IconName;
  group: SectionGroup;
  /** Words people may search for that the label does not contain. */
  keywords: string;
};

const sections: readonly SectionEntry[] = [
  {
    id: "agents",
    label: "New agents",
    icon: "squarePen",
    group: "Agents",
    keywords: "defaults model view permissions",
  },
  {
    id: "agentMessages",
    label: "Agent messages",
    icon: "message",
    group: "Agents",
    keywords: "zli other agents projects reach cross-project talk send",
  },
  { id: "accounts", label: "Accounts", icon: "user", group: "Agents", keywords: "sign in api key login" },
  { id: "usage", label: "Usage", icon: "gauge", group: "Agents", keywords: "plan limits sidebar quota subscription" },
  { id: "skills", label: "Skills", icon: "sparkle", group: "Agents", keywords: "prompts instructions" },
  { id: "projects", label: "Projects", icon: "folder", group: "Workspace", keywords: "folders remove" },
  { id: "worktrees", label: "Worktrees", icon: "branch", group: "Workspace", keywords: "branch name template" },
  { id: "files", label: "Files", icon: "fileText", group: "Workspace", keywords: "tree position editor" },
  {
    id: "integrations",
    label: "Integrations",
    icon: "puzzle",
    group: "Tools",
    keywords: "mcp servers connectors plugins",
  },
  { id: "issues", label: "Issues", icon: "issue", group: "Tools", keywords: "github linear" },
  {
    id: "mobile",
    label: "Mobile",
    icon: "smartphone",
    group: "Tools",
    keywords: "phone android emulator iphone simulator device frame sdk avd",
  },
  { id: "shortcuts", label: "Shortcuts", icon: "command", group: "App", keywords: "keys keyboard bindings" },
  { id: "notifications", label: "Notifications", icon: "bell", group: "App", keywords: "sound alerts" },
  { id: "updates", label: "Updates", icon: "download", group: "App", keywords: "version channel" },
];

const groups: readonly SectionGroup[] = ["Agents", "Workspace", "Tools", "App"];

/** The sections whose label, group, or keywords contain every typed word. */
export function matchingSections(query: string): readonly SectionEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sections;
  return sections.filter((entry) => {
    const haystack = `${entry.label} ${entry.group} ${entry.keywords}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const modeOptions: readonly PickerOption<SessionMode>[] = [
  { value: "terminal", label: "Terminal", icon: <Icon name="terminal" size={15} /> },
  { value: "chat", label: "Chat", icon: <Icon name="message" size={15} /> },
];

type Props = {
  projection: RuntimeProjection | undefined;
  initialProjectId?: string | undefined;
  initialSection?: SettingsSection;
  /** The Integrations tab to open on. */
  integrationsView?: IntegrationsView | undefined;
  /** A catalog id the Integrations Browse tab opens on. */
  focusConnector?: string | undefined;
  notifications: { settings: NotificationSettings | undefined; update(patch: Partial<NotificationSettings>): void };
  updates?: Updates | undefined;
  onRestartToUpdate?(): void;
  /** Opens a terminal that runs the agent's sign-in for a sign-in account. */
  onSignIn?(account: Account): Promise<string | undefined>;
  onAddProject?(): void;
  /** Removes a project from ZLI and resolves with a problem to show, if any. */
  onRemoveProject?(projectId: string): Promise<string | undefined>;
  onClose(): void;
};

export function SettingsDialog({
  projection,
  initialProjectId,
  initialSection = "agents",
  integrationsView,
  focusConnector,
  notifications,
  updates,
  onRestartToUpdate = () => undefined,
  onSignIn,
  onAddProject,
  onRemoveProject,
  onClose,
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [query, setQuery] = useState("");
  const tabsId = useId();
  const tabRefs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const panelRef = useRef<HTMLElement>(null);
  const visible = matchingSections(query);
  const current = sections.find((entry) => entry.id === section) ?? sections[0];
  // While a search hides the open section, the first match takes its place in the tab order.
  const focusable = visible.some((entry) => entry.id === section) ? section : visible[0]?.id;

  const select = (next: SettingsSection) => {
    setSection(next);
    if (panelRef.current) panelRef.current.scrollTop = 0;
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return;
    const index = visible.findIndex((entry) => entry.id === section);
    const next =
      event.key === "ArrowDown"
        ? visible[(index + 1) % visible.length]
        : event.key === "ArrowUp"
          ? visible[(index - 1 + visible.length) % visible.length]
          : event.key === "Home"
            ? visible[0]
            : event.key === "End"
              ? visible[visible.length - 1]
              : undefined;
    if (!next) return;
    event.preventDefault();
    select(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <Dialog label="Settings" size="lg" className="settings-dialog" scrimLabel="Close settings" onClose={onClose}>
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <h2 className="settings-title">Settings</h2>
          <div className="settings-search">
            <Icon name="search" size={13} />
            <input
              className="input input-sm"
              type="search"
              aria-label="Search settings"
              placeholder="Search"
              value={query}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  // Escape clears the search first, and closes Settings only once the field is empty.
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                } else if (event.key === "Enter" && visible[0]) {
                  event.preventDefault();
                  select(visible[0].id);
                }
              }}
            />
          </div>
          <div
            className="settings-nav"
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            onKeyDown={onTabKey}
          >
            {groups.map((group) => {
              const entries = visible.filter((entry) => entry.group === group);
              if (entries.length === 0) return null;
              return (
                <div key={group} className="settings-nav-group" role="presentation">
                  <span className="settings-nav-heading" aria-hidden="true">
                    {group}
                  </span>
                  {entries.map((entry) => (
                    <button
                      key={entry.id}
                      ref={(element) => {
                        tabRefs.current[entry.id] = element;
                      }}
                      className="settings-tab"
                      type="button"
                      role="tab"
                      id={`${tabsId}-${entry.id}`}
                      aria-selected={section === entry.id}
                      aria-controls={`${tabsId}-panel`}
                      tabIndex={focusable === entry.id ? 0 : -1}
                      onClick={() => select(entry.id)}
                    >
                      <Icon name={entry.icon} size={14} />
                      <span>{entry.label}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            {visible.length === 0 ? (
              <p className="settings-nav-empty" role="status">
                Nothing matches {query.trim()}.
              </p>
            ) : null}
          </div>
        </aside>
        <div className="settings-main">
          <header className="settings-crumbs">
            <span className="settings-crumb">{current?.group}</span>
            <Icon name="chevronRight" size={12} />
            <span className="settings-crumb is-current">{current?.label}</span>
            <IconButton label="Close" icon="x" size="sm" className="settings-close" onClick={onClose} />
          </header>
          <section
            ref={panelRef}
            className="settings-panel"
            role="tabpanel"
            id={`${tabsId}-panel`}
            aria-labelledby={`${tabsId}-${section}`}
          >
            {section === "agents" ? <AgentDefaults projection={projection} /> : null}
            {section === "agentMessages" ? <AgentMessagesSection /> : null}
            {section === "accounts" ? (
              <AccountsSection projection={projection} {...(onSignIn ? { onSignIn } : {})} />
            ) : null}
            {section === "usage" ? <UsageSection projection={projection} /> : null}
            {section === "projects" ? (
              <ProjectsSection
                projection={projection}
                initialProjectId={initialProjectId}
                onAddProject={onAddProject}
                onRemoveProject={onRemoveProject}
              />
            ) : null}
            {section === "worktrees" ? <WorktreeSettings projection={projection} /> : null}
            {section === "files" ? <FilesSettings /> : null}
            {section === "integrations" ? (
              <IntegrationsSection
                initialView={integrationsView}
                focusConnector={focusConnector}
                onAgentMessages={() => select("agentMessages")}
              />
            ) : null}
            {section === "skills" ? (
              <SkillsSection projection={projection} initialProjectId={initialProjectId} />
            ) : null}
            {section === "issues" ? <IssuesSection /> : null}
            {section === "shortcuts" ? <ShortcutSettings /> : null}
            {section === "notifications" ? <NotificationSection {...notifications} /> : null}
            {section === "mobile" ? <MobileSection /> : null}
            {section === "updates" ? <UpdatesSection updates={updates} onRestart={onRestartToUpdate} /> : null}
          </section>
        </div>
      </div>
    </Dialog>
  );
}

/** The agent, view, permission, and model rows shared by the general defaults and project overrides. */
function LaunchFields({
  projection,
  value,
  inheritLabel,
  onChange,
}: {
  projection: RuntimeProjection | undefined;
  value: LaunchDefaults;
  inheritLabel: string;
  onChange(next: LaunchDefaults): void;
}) {
  const ids = useId();
  const listed = useMemo(() => listedDiscoveries(projection?.providers), [projection?.providers]);
  const choices = listed.filter((entry) => entry.status === "found" || entry.provider === value.provider);
  const discovery = listed.find((entry) => entry.provider === value.provider);
  const models = discovery?.status === "found" ? (discovery.models ?? []) : [];
  const inherit: PickerOption<string> = { value: "", label: inheritLabel };
  const set = (patch: Partial<Record<keyof LaunchDefaults, string>>) => {
    const next: Record<string, string | undefined> = { ...value, ...patch };
    for (const key of Object.keys(next)) if (!next[key]) delete next[key];
    onChange(next as LaunchDefaults);
  };
  return (
    <>
      <SettingRow label="Agent" description="The CLI selected when the dialog opens." htmlFor={`${ids}-agent`}>
        <Select
          id={`${ids}-agent`}
          label="Agent"
          value={value.provider ?? ""}
          options={[
            inherit,
            ...choices.map((entry) => ({
              value: entry.provider,
              label: `${entry.displayName}${entry.status === "found" ? "" : " (not installed)"}`,
              icon: <ProviderMark provider={entry.provider} size={15} />,
            })),
          ]}
          onChange={(provider) => set({ provider, model: "" })}
        />
      </SettingRow>
      {value.provider && models.length > 0 ? (
        <SettingRow label="Model" description="Used when the agent lets you choose one." htmlFor={`${ids}-model`}>
          <Select
            id={`${ids}-model`}
            label="Model"
            value={value.model ?? ""}
            options={modelOptions(models, value.model, value.provider)}
            onChange={(model) => set({ model })}
          />
        </SettingRow>
      ) : null}
      <SettingRow
        label="View"
        description="Terminal runs the agent's CLI. Chat shows messages and changes."
        htmlFor={`${ids}-view`}
      >
        <Select<string>
          id={`${ids}-view`}
          label="View"
          value={value.mode ?? ""}
          options={[inherit, ...modeOptions]}
          onChange={(mode) => set({ mode })}
        />
      </SettingRow>
      <SettingRow
        label="Permissions"
        description={
          value.permissionMode ? permissionHint[value.permissionMode] : "What the agent may do without asking."
        }
        htmlFor={`${ids}-permissions`}
      >
        <Select<string>
          id={`${ids}-permissions`}
          label="Permissions"
          value={value.permissionMode ?? ""}
          options={[inherit, ...permissionOptions]}
          onChange={(permissionMode) => set({ permissionMode })}
        />
      </SettingRow>
    </>
  );
}

function AgentDefaults({ projection }: { projection: RuntimeProjection | undefined }) {
  const settings = useAppSettings();
  return (
    <>
      <SectionHeader title="New agents">
        What the New agent dialog starts with. Fields set to Last used repeat your previous choice.
      </SectionHeader>
      <SettingGroup title="Defaults">
        <LaunchFields
          projection={projection}
          value={settings.defaults}
          inheritLabel="Last used"
          onChange={(defaults) => updateAppSettings((current) => ({ ...current, defaults }))}
        />
      </SettingGroup>
    </>
  );
}

function ProjectsSection({
  projection,
  initialProjectId,
  onAddProject,
  onRemoveProject,
}: {
  projection: RuntimeProjection | undefined;
  initialProjectId: string | undefined;
  onAddProject?: (() => void) | undefined;
  onRemoveProject?: ((projectId: string) => Promise<string | undefined>) | undefined;
}) {
  const settings = useAppSettings();
  const projects = projection?.projects ?? [];
  const [projectId, setProjectId] = useState(
    projects.find((project) => project.projectId === initialProjectId)?.projectId ?? projects[0]?.projectId,
  );
  const [confirmId, setConfirmId] = useState<string>();
  const [removed, setRemoved] = useState<string>();
  // A project removed from here, or from elsewhere while Settings is open, falls back to the first one left.
  const project = projects.find((candidate) => candidate.projectId === projectId) ?? projects[0];

  const addButton = onAddProject ? (
    <div className="settings-actions">
      <Button size="sm" icon="folderPlus" onClick={onAddProject}>
        Add project
      </Button>
    </div>
  ) : null;
  const removedNote = removed ? (
    <p className="settings-done" role="status">
      <Icon name="check" size={14} />
      <span>Removed {removed} from ZLI. Its folder is still on disk.</span>
    </p>
  ) : null;

  if (!project) {
    return (
      <>
        <SectionHeader title="Projects">Folders you added to ZLI. Agents start in one of them.</SectionHeader>
        {removedNote}
        <div className="project-empty">
          <span className="project-tile" aria-hidden="true">
            <Icon name="folder" size={16} />
          </span>
          <p className="settings-empty">No projects yet. Add a folder to start agents in it.</p>
        </div>
        {addButton}
      </>
    );
  }

  const remove = async (target: ProjectProjection) => {
    const problem = await onRemoveProject?.(target.projectId);
    if (!problem) {
      setConfirmId(undefined);
      setRemoved(target.name);
    }
    return problem;
  };
  const override = settings.projects[project.projectId] ?? {};
  const setOverride = (next: LaunchDefaults) =>
    updateAppSettings((current) => {
      const { [project.projectId]: _previous, ...others } = current.projects;
      return { ...current, projects: Object.keys(next).length > 0 ? { ...others, [project.projectId]: next } : others };
    });

  return (
    <>
      <SectionHeader title="Projects">
        Folders you added to ZLI. Select one to give it its own agent defaults.
      </SectionHeader>
      {removedNote}
      <section className="accounts-provider" aria-label="Project folders">
        <h3 className="mcp-subhead accounts-subhead">
          Folders
          <span className="mcp-chip">{projects.length}</span>
        </h3>
        <ul className="project-list" aria-label="Projects">
          {projects.map((candidate) => (
            <ProjectRow
              key={candidate.projectId}
              projection={projection}
              project={candidate}
              selected={candidate.projectId === project.projectId}
              confirming={confirmId === candidate.projectId}
              canRemove={onRemoveProject !== undefined}
              onSelect={() => {
                setRemoved(undefined);
                setProjectId(candidate.projectId);
              }}
              onAsk={() => {
                setRemoved(undefined);
                setConfirmId(candidate.projectId);
              }}
              onCancel={() => setConfirmId(undefined)}
              onRemove={() => remove(candidate)}
            />
          ))}
        </ul>
        {addButton}
      </section>
      <section className="accounts-provider" aria-label={`Defaults for ${project.name}`}>
        <h3 className="mcp-subhead accounts-subhead">Defaults for {project.name}</h3>
        <div className="setting-list">
          <LaunchFields
            key={project.projectId}
            projection={projection}
            value={override}
            inheritLabel="Same as New agents"
            onChange={setOverride}
          />
        </div>
        {Object.keys(override).length > 0 ? (
          <div className="settings-actions">
            <Button size="sm" variant="ghost" icon="rotate" onClick={() => setOverride({})}>
              Reset {project.name} to New agents
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

type ProjectStats = { agents: number; running: number; worktrees: number };

function projectStats(projection: RuntimeProjection | undefined, project: ProjectProjection): ProjectStats {
  const worktrees = (projection?.worktrees ?? []).filter((worktree) => worktree.projectId === project.projectId);
  const worktreeIds = new Set<string>(worktrees.map((worktree) => worktree.worktreeId));
  const agents = projection ? deriveSessions(projection).filter((session) => worktreeIds.has(session.worktreeId)) : [];
  return {
    agents: agents.length,
    running: agents.filter((session) => sessionStopCommands(session).length > 0).length,
    worktrees: worktrees.filter((worktree) => worktree.kind !== "checkout" && !samePath(worktree.path, project.path))
      .length,
  };
}

/** What removing the project takes with it, so the confirmation can say so. */
function removalDetail(stats: ProjectStats): string {
  const parts: string[] = [];
  if (stats.running > 0) parts.push(`${plural(stats.running, "running agent")} will be stopped.`);
  if (stats.agents === 1) parts.push("1 agent and its chat are deleted from ZLI.");
  if (stats.agents > 1) parts.push(`${stats.agents} agents and their chats are deleted from ZLI.`);
  parts.push(
    stats.worktrees > 0
      ? `The folder and its ${plural(stats.worktrees, "worktree")} stay on disk.`
      : "The folder and its files stay on disk.",
  );
  return parts.join(" ");
}

/** Removing takes two clicks on purpose: the trash button only asks, so a stray click removes nothing. */
function ProjectRow({
  projection,
  project,
  selected,
  confirming,
  canRemove,
  onSelect,
  onAsk,
  onCancel,
  onRemove,
}: {
  projection: RuntimeProjection | undefined;
  project: ProjectProjection;
  selected: boolean;
  confirming: boolean;
  canRemove: boolean;
  onSelect(): void;
  onAsk(): void;
  onCancel(): void;
  onRemove(): Promise<string | undefined>;
}) {
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const keepRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const stats = projectStats(projection, project);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) askRef.current?.focus();
    if (!confirming) setProblem(undefined);
    wasConfirming.current = confirming;
  }, [confirming]);

  const remove = async () => {
    setRemoving(true);
    setProblem(undefined);
    const message = await onRemove();
    setRemoving(false);
    if (message) setProblem(message);
  };

  return (
    <li className={`project-row${selected ? " is-selected" : ""}${confirming ? " is-confirming" : ""}`}>
      <div className="project-row-main">
        <button type="button" className="project-pick" aria-current={selected ? "true" : undefined} onClick={onSelect}>
          <span className="project-tile" aria-hidden="true">
            <Icon name="folder" size={16} />
          </span>
          <span className="project-pick-copy">
            <span className="project-pick-title">
              <strong>{project.name}</strong>
              {stats.running > 0 ? (
                <Badge tone="success" dot>
                  {stats.running} running
                </Badge>
              ) : null}
              {stats.agents > 0 ? <span className="mcp-chip">{plural(stats.agents, "agent")}</span> : null}
              {stats.worktrees > 0 ? <span className="mcp-chip">{plural(stats.worktrees, "worktree")}</span> : null}
            </span>
            <span className="project-pick-path">{project.path}</span>
          </span>
        </button>
        {canRemove && !confirming ? (
          <span className="project-row-actions">
            <IconButton
              ref={askRef}
              label={`Remove ${project.name}`}
              tooltip="Remove from ZLI. The folder stays on disk."
              icon="trash"
              size="sm"
              iconSize={14}
              tone="danger"
              onClick={onAsk}
            />
          </span>
        ) : null}
      </div>
      {confirming ? (
        <div className="project-remove">
          <span className="project-remove-mark" aria-hidden="true">
            <Icon name="alert" size={15} />
          </span>
          <div className="project-remove-copy">
            <p className="project-remove-title">Remove {project.name} from ZLI?</p>
            <p className="project-remove-detail">{removalDetail(stats)}</p>
            {problem ? (
              <p className="project-remove-problem" role="alert">
                {problem}
              </p>
            ) : null}
          </div>
          <div className="project-remove-actions">
            <Button ref={keepRef} size="sm" variant="ghost" disabled={removing} onClick={onCancel}>
              Keep
            </Button>
            <Button size="sm" variant="danger" icon="trash" loading={removing} onClick={() => void remove()}>
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
function WorktreeSettings({ projection }: { projection: RuntimeProjection | undefined }) {
  const settings = useAppSettings();
  const [draft, setDraft] = useState(settings.branchTemplate);
  const inputId = useId();
  const provider = useMemo(() => {
    const listed = listedDiscoveries(projection?.providers);
    return settings.defaults.provider ?? preferredProvider(listed);
  }, [projection?.providers, settings.defaults.provider]);
  const template = draft.trim() || settings.branchTemplate;
  const preview = branchFromTemplate(template, provider, new Date(), () => "k3f9");
  const save = (value: string) => {
    setDraft(value);
    if (value.trim()) updateAppSettings((current) => ({ ...current, branchTemplate: value }));
  };
  return (
    <>
      <SectionHeader title="Worktrees">How ZLI names the branch for each new worktree.</SectionHeader>
      <SettingGroup title="Branch names">
        <SettingRow
          label="Branch name"
          htmlFor={inputId}
          description={
            <>
              <code>{"{agent}"}</code> is the agent, <code>{"{random}"}</code> four random characters, and{" "}
              <code>{"{date}"}</code> today as YYYYMMDD. Agents started from an issue get a name like
              issue-123-fix-login, placed at <code>{"{issue}"}</code> if the template has it.
            </>
          }
        >
          <div className="setting-inline">
            <input
              id={inputId}
              className="input is-mono"
              aria-label="Branch name template"
              value={draft}
              maxLength={MAX_BRANCH_TEMPLATE}
              spellCheck={false}
              onChange={(event) => save(event.target.value)}
              onBlur={() => {
                if (!draft.trim()) setDraft(settings.branchTemplate);
              }}
            />
            {settings.branchTemplate !== DEFAULT_BRANCH_TEMPLATE ? (
              <IconButton
                label="Reset branch name"
                tooltip="Reset to the default"
                icon="rotate"
                size="sm"
                onClick={() => save(DEFAULT_BRANCH_TEMPLATE)}
              />
            ) : null}
          </div>
        </SettingRow>
        <SettingRow
          label="Preview"
          description={
            template.includes("{random}")
              ? "The next new worktree gets a name like this."
              : "Without {random}, every new branch gets the same name."
          }
          descriptionTone={template.includes("{random}") ? undefined : "warning"}
        >
          <span className="settings-value is-mono">{preview}</span>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

const treePositionOptions: readonly PickerOption<FileTreePosition>[] = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
];

function FilesSettings() {
  const settings = useAppSettings();
  const selectId = useId();
  return (
    <>
      <SectionHeader title="Files">
        Layout of the Files panel when it is wide enough for the tree and a file.
      </SectionHeader>
      <SettingGroup title="Layout">
        <SettingRow label="Tree position" description="The open file takes the other side." htmlFor={selectId}>
          <Select
            id={selectId}
            label="File tree position"
            value={settings.fileTreePosition}
            options={treePositionOptions}
            onChange={(fileTreePosition) => updateAppSettings((current) => ({ ...current, fileTreePosition }))}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

function ShortcutSettings() {
  const settings = useAppSettings();
  const [recording, setRecording] = useState<ShortcutId>();
  const [problem, setProblem] = useState<{ id: ShortcutId; message: string }>();
  const customized = Object.keys(settings.shortcuts).length > 0;

  const assign = (id: ShortcutId, shortcut: string | undefined) =>
    updateAppSettings((current) => {
      const { [id]: _previous, ...others } = current.shortcuts;
      return {
        ...current,
        shortcuts: shortcut && shortcut !== defaultShortcut(id) ? { ...others, [id]: shortcut } : others,
      };
    });

  const onRecordKey = (id: ShortcutId, event: KeyboardEvent<HTMLButtonElement>) => {
    // Keys pressed while recording must not also run the shortcut they currently trigger.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(undefined);
      return;
    }
    const shortcut = shortcutFromEvent(event.nativeEvent);
    if (!shortcut) return;
    const message = shortcutProblem(settings.shortcuts, id, shortcut);
    if (message) {
      setProblem({ id, message: `${shortcutText(shortcut)}: ${message}` });
      return;
    }
    setProblem(undefined);
    setRecording(undefined);
    assign(id, shortcut);
  };

  return (
    <>
      <SectionHeader title="Shortcuts">
        Select a shortcut, then press the new keys. Esc cancels. Ctrl and Cmd count as the same key.
      </SectionHeader>
      <ul className="setting-list shortcut-list">
        {shortcutActions.map((action) => {
          const current = settings.shortcuts[action.id] ?? action.shortcut;
          const isRecording = recording === action.id;
          const changed = settings.shortcuts[action.id] !== undefined;
          return (
            <li className="shortcut-row" key={action.id}>
              <span className="shortcut-label">{action.label}</span>
              <span className="shortcut-reset">
                {changed ? (
                  <IconButton
                    label={`Reset ${action.label} to ${shortcutText(action.shortcut)}`}
                    tooltip={`Reset to ${shortcutText(action.shortcut)}`}
                    icon="rotate"
                    size="xs"
                    iconSize={12}
                    onClick={() => {
                      setProblem(undefined);
                      assign(action.id, undefined);
                    }}
                  />
                ) : null}
              </span>
              <button
                className={`shortcut-key${isRecording ? " is-recording" : ""}`}
                type="button"
                aria-label={
                  isRecording
                    ? `Press the new keys for ${action.label}`
                    : `${action.label}, ${shortcutText(current)}. Change shortcut`
                }
                onClick={() => {
                  setProblem(undefined);
                  setRecording(isRecording ? undefined : action.id);
                }}
                onKeyDown={isRecording ? (event) => onRecordKey(action.id, event) : undefined}
                onBlur={() => {
                  if (isRecording) setRecording(undefined);
                }}
              >
                {isRecording ? <span className="shortcut-waiting">Press keys</span> : <Kbd shortcut={current} />}
              </button>
              {problem?.id === action.id ? (
                <p className="shortcut-problem" role="alert">
                  {problem.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {customized ? (
        <div className="settings-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="rotate"
            onClick={() => {
              setProblem(undefined);
              updateAppSettings((current: AppSettings) => ({ ...current, shortcuts: {} }));
            }}
          >
            Reset all shortcuts
          </Button>
        </div>
      ) : null}
    </>
  );
}

function NotificationSection({
  settings,
  update,
}: {
  settings: NotificationSettings | undefined;
  update(patch: Partial<NotificationSettings>): void;
}) {
  if (!settings) {
    return (
      <>
        <SectionHeader title="Notifications" />
        <p className="settings-empty">Notifications are available in the ZLI desktop app only.</p>
      </>
    );
  }
  return (
    <>
      <SectionHeader title="Notifications">
        Agents already on screen stay quiet while the ZLI window has focus.
      </SectionHeader>
      <SettingGroup title="Alerts">
        <Switch
          label="Desktop notifications"
          hint="Notify when an agent finishes or needs input, and badge the taskbar or dock icon."
          checked={settings.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        <Switch
          label="Sound"
          hint="Play a sound with each notification."
          checked={settings.sound}
          disabled={!settings.enabled}
          onChange={(sound) => update({ sound })}
        />
      </SettingGroup>
    </>
  );
}
