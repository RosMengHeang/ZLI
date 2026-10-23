import type { PermissionMode, RuntimeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";

import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { permissionLabel } from "../chat/Composer.js";
import type { NotificationSettings } from "../runtime/bridge.js";
import { LaunchRow } from "../sessions/NewAgentDialog.js";
import type { SessionMode } from "../sessions/sessions.js";
import { defaultShortcut, shortcutActions, shortcutFromEvent, shortcutProblem } from "../shell/keybindings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
import { Kbd } from "../ui/Kbd.js";
import { Switch } from "../ui/Switch.js";
import { shortcutText } from "../ui/shortcuts.js";
import {
  type AppSettings,
  branchFromTemplate,
  DEFAULT_BRANCH_TEMPLATE,
  type LaunchDefaults,
  MAX_BRANCH_TEMPLATE,
  type ShortcutId,
  updateAppSettings,
  useAppSettings,
} from "./appSettings.js";
import { McpServersSection } from "./McpServersSection.js";
import { SectionHeader } from "./SectionHeader.js";
import "./settings.css";

export type SettingsSection = "agents" | "projects" | "worktrees" | "mcp" | "shortcuts" | "notifications";

const sections: { id: SettingsSection; label: string }[] = [
  { id: "agents", label: "New agents" },
  { id: "projects", label: "Projects" },
  { id: "worktrees", label: "Worktrees" },
  { id: "mcp", label: "MCP servers" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "notifications", label: "Notifications" },
];

const modeLabel: Record<SessionMode, string> = { terminal: "Terminal", chat: "Chat" };

const permissionHint: Record<PermissionMode, string> = {
  "full-access": "Edits files and runs commands without asking.",
  supervised: "Asks before risky commands where the agent supports it.",
};

type Props = {
  projection: RuntimeProjection | undefined;
  initialProjectId?: string | undefined;
  initialSection?: SettingsSection;
  notifications: { settings: NotificationSettings | undefined; update(patch: Partial<NotificationSettings>): void };
  onClose(): void;
};

export function SettingsDialog({
  projection,
  initialProjectId,
  initialSection = "agents",
  notifications,
  onClose,
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const tabsId = useId();
  const tabRefs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = sections.findIndex((entry) => entry.id === section);
    const next = sections[(index + step + sections.length) % sections.length];
    if (!next) return;
    setSection(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <Dialog
      label="Settings"
      title="Settings"
      size="lg"
      className="settings-dialog"
      scrimLabel="Close settings"
      onClose={onClose}
    >
      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          onKeyDown={onTabKey}
        >
          {sections.map((entry) => (
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
              tabIndex={section === entry.id ? 0 : -1}
              onClick={() => setSection(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <section
          className="settings-panel"
          role="tabpanel"
          id={`${tabsId}-panel`}
          aria-labelledby={`${tabsId}-${section}`}
        >
          {section === "agents" ? <AgentDefaults projection={projection} /> : null}
          {section === "projects" ? (
            <ProjectDefaults projection={projection} initialProjectId={initialProjectId} />
          ) : null}
          {section === "worktrees" ? <WorktreeSettings projection={projection} /> : null}
          {section === "mcp" ? <McpServersSection /> : null}
          {section === "shortcuts" ? <ShortcutSettings /> : null}
          {section === "notifications" ? <NotificationSection {...notifications} /> : null}
        </section>
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
  const listed = useMemo(() => listedDiscoveries(projection?.providers), [projection?.providers]);
  const choices = listed.filter((entry) => entry.status === "found" || entry.provider === value.provider);
  const discovery = listed.find((entry) => entry.provider === value.provider);
  const models = discovery?.status === "found" ? (discovery.models ?? []) : [];
  const set = (patch: Partial<Record<keyof LaunchDefaults, string>>) => {
    const next: Record<string, string | undefined> = { ...value, ...patch };
    for (const key of Object.keys(next)) if (!next[key]) delete next[key];
    onChange(next as LaunchDefaults);
  };
  return (
    <div className="launch-rows">
      <LaunchRow label="Agent">
        <Select
          className="input-sm"
          aria-label="Agent"
          value={value.provider ?? ""}
          onChange={(event) => set({ provider: event.target.value, model: "" })}
        >
          <option value="">{inheritLabel}</option>
          {choices.map((entry) => (
            <option key={entry.provider} value={entry.provider}>
              {entry.displayName}
              {entry.status === "found" ? "" : " (not installed)"}
            </option>
          ))}
        </Select>
      </LaunchRow>
      {value.provider && models.length > 0 ? (
        <LaunchRow label="Model">
          <Select
            className="input-sm"
            aria-label="Model"
            value={value.model ?? ""}
            onChange={(event) => set({ model: event.target.value })}
          >
            <option value="">Default model</option>
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </LaunchRow>
      ) : null}
      <LaunchRow label="Work in">
        <Select
          className="input-sm"
          aria-label="Work in"
          value={value.mode ?? ""}
          onChange={(event) => set({ mode: event.target.value })}
        >
          <option value="">{inheritLabel}</option>
          {(Object.keys(modeLabel) as SessionMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {modeLabel[mode]}
            </option>
          ))}
        </Select>
      </LaunchRow>
      <LaunchRow label="Permissions" hint={value.permissionMode ? permissionHint[value.permissionMode] : undefined}>
        <Select
          className="input-sm"
          aria-label="Permissions"
          value={value.permissionMode ?? ""}
          onChange={(event) => set({ permissionMode: event.target.value })}
        >
          <option value="">{inheritLabel}</option>
          {(Object.keys(permissionLabel) as PermissionMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {permissionLabel[mode]}
            </option>
          ))}
        </Select>
      </LaunchRow>
    </div>
  );
}

function AgentDefaults({ projection }: { projection: RuntimeProjection | undefined }) {
  const settings = useAppSettings();
  return (
    <>
      <SectionHeader title="New agents">
        New agent opens with these choices. Fields left on Last used keep whatever you picked the time before.
      </SectionHeader>
      <LaunchFields
        projection={projection}
        value={settings.defaults}
        inheritLabel="Last used"
        onChange={(defaults) => updateAppSettings((current) => ({ ...current, defaults }))}
      />
    </>
  );
}

function ProjectDefaults({
  projection,
  initialProjectId,
}: {
  projection: RuntimeProjection | undefined;
  initialProjectId: string | undefined;
}) {
  const settings = useAppSettings();
  const projects = projection?.projects ?? [];
  const [projectId, setProjectId] = useState(
    projects.find((project) => project.projectId === initialProjectId)?.projectId ?? projects[0]?.projectId,
  );
  const project = projects.find((candidate) => candidate.projectId === projectId);
  if (!project) {
    return (
      <>
        <SectionHeader title="Projects" />
        <p className="settings-empty">Add a project to give it its own agent and permission choices.</p>
      </>
    );
  }
  const override = settings.projects[project.projectId] ?? {};
  const setOverride = (next: LaunchDefaults) =>
    updateAppSettings((current) => {
      const { [project.projectId]: _previous, ...others } = current.projects;
      return { ...current, projects: Object.keys(next).length > 0 ? { ...others, [project.projectId]: next } : others };
    });
  return (
    <>
      <SectionHeader title="Projects">
        Choices made here win over New agents whenever an agent starts in this project.
      </SectionHeader>
      <div className="launch-rows">
        <LaunchRow label="Project">
          {projects.length > 1 ? (
            <Select
              className="input-sm"
              aria-label="Project"
              value={project.projectId}
              onChange={(event) => setProjectId(event.target.value as typeof projectId)}
            >
              {projects.map((candidate) => (
                <option key={candidate.projectId} value={candidate.projectId}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          ) : (
            <span className="settings-value" title={project.path}>
              {project.name}
            </span>
          )}
        </LaunchRow>
      </div>
      <LaunchFields
        key={project.projectId}
        projection={projection}
        value={override}
        inheritLabel="Same as New agents"
        onChange={setOverride}
      />
      {Object.keys(override).length > 0 ? (
        <div className="settings-actions">
          <Button size="sm" variant="ghost" onClick={() => setOverride({})}>
            Clear {project.name} settings
          </Button>
        </div>
      ) : null}
    </>
  );
}

function WorktreeSettings({ projection }: { projection: RuntimeProjection | undefined }) {
  const settings = useAppSettings();
  const [draft, setDraft] = useState(settings.branchTemplate);
  const inputId = useId();
  const hintId = useId();
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
      <SectionHeader title="Worktrees">Names for the branch each new worktree starts on.</SectionHeader>
      <div className="launch-rows">
        <LaunchRow label="Branch name">
          <div className="launch-inline">
            <input
              id={inputId}
              className="input input-sm is-mono settings-template"
              aria-label="Branch name template"
              aria-describedby={hintId}
              value={draft}
              maxLength={MAX_BRANCH_TEMPLATE}
              spellCheck={false}
              onChange={(event) => save(event.target.value)}
              onBlur={() => {
                if (!draft.trim()) setDraft(settings.branchTemplate);
              }}
            />
            {settings.branchTemplate !== DEFAULT_BRANCH_TEMPLATE ? (
              <Button size="sm" variant="ghost" onClick={() => save(DEFAULT_BRANCH_TEMPLATE)}>
                Reset
              </Button>
            ) : null}
          </div>
          <span className="launch-hint" id={hintId}>
            <code>{"{agent}"}</code> is the agent name, <code>{"{random}"}</code> four random characters, and{" "}
            <code>{"{date}"}</code> today as YYYYMMDD.
          </span>
        </LaunchRow>
        <LaunchRow label="Example">
          <span className="settings-value is-mono">{preview}</span>
          {template.includes("{random}") ? null : (
            <span className="launch-hint is-warning">
              Without {"{random}"} every new branch gets the same name, so you will rename it each time.
            </span>
          )}
        </LaunchRow>
      </div>
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
        Click a shortcut, then press the new keys. Esc cancels. Ctrl and Cmd both count as the first key.
      </SectionHeader>
      <ul className="shortcut-list">
        {shortcutActions.map((action) => {
          const current = settings.shortcuts[action.id] ?? action.shortcut;
          const isRecording = recording === action.id;
          const changed = settings.shortcuts[action.id] !== undefined;
          return (
            <li className="shortcut-row" key={action.id}>
              <span className="shortcut-label">{action.label}</span>
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
        <p className="settings-empty">Notifications are only available in the ZLI desktop app.</p>
      </>
    );
  }
  return (
    <>
      <SectionHeader title="Notifications">
        Agents already on screen do not notify while the ZLI window has focus.
      </SectionHeader>
      <div className="settings-switches">
        <Switch
          label="Notify when an agent finishes or needs you"
          hint="Also shows the count of waiting agents on the taskbar or dock icon."
          checked={settings.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        <Switch
          label="Play a sound"
          checked={settings.sound}
          disabled={!settings.enabled}
          onChange={(sound) => update({ sound })}
        />
      </div>
    </>
  );
}
