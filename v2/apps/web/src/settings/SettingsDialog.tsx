import { type Account, ProjectConfigResult, type ProjectProjection, type RuntimeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { listedDiscoveries, preferredProvider } from "../agent/providers.js";
import { permissionHint, permissionOptions } from "../chat/permissions.js";
import {
  clearCustomSound,
  DEFAULT_NOTIFICATION_TONE,
  isNotificationTone,
  NOTIFICATION_TONES,
  type NotificationTone,
  playNotificationTone,
  saveCustomSound,
  useCustomSound,
} from "../notifications/sounds.js";
import type { NotificationSettings } from "../runtime/bridge.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { samePath } from "../sessions/launch.js";
import { deriveSessions, sessionStopCommands } from "../sessions/sessions.js";
import { defaultShortcut, shortcutActions, shortcutFromEvent, shortcutProblem } from "../shell/keybindings.js";
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
import { AgentsSection } from "./AgentsSection.js";
import { AppearanceSection } from "./AppearanceSection.js";
import {
  type AppSettings,
  branchFromTemplate,
  DEFAULT_BRANCH_TEMPLATE,
  type FileTreePosition,
  type LaunchDefaults,
  MAX_BRANCH_TEMPLATE,
  parseWorktreePrefs,
  type ShortcutId,
  updateAppSettings,
  useAppSettings,
  type WorkStyle,
  type WorktreePrefs,
  withWorkStyle,
  workStyleOf,
} from "./appSettings.js";
import { ConnectedAppsLock } from "./ConnectedAppsLock.js";
import { ForgesSection } from "./ForgesSection.js";
import { IntegrationsSection, type IntegrationsView } from "./IntegrationsSection.js";
import { MobileAccessSection } from "./MobileAccessSection.js";
import { MobileSection } from "./MobileSection.js";
import { requestSettings } from "./openSettings.js";
import { SettingsGroup, SettingsPageHeader, SettingsRow } from "./SettingsLayout.js";
import { StorageGroup } from "./SidebarUsageSettings.js";
import { SkillsSection } from "./SkillsSection.js";
import { UsageSection } from "./UsageSection.js";
import "./settings.css";

/** The pages in the Settings sidebar. */
export type SettingsPage =
  | "general"
  | "appearance"
  | "shortcuts"
  | "updates"
  | "accounts"
  | "usage"
  | "skills"
  | "agentMessages"
  | "projects"
  | "worktrees"
  | "forges"
  | "integrations"
  | "mobile"
  | "phoneAccess";

/**
 * Where Settings can be asked to open. "agents", "files", and "notifications" were pages of their own before
 * they moved into General, and "issues" before it joined Forges; each still opens its new home, so older links and callers keep working.
 */
export type SettingsSection = SettingsPage | "agents" | "files" | "notifications" | "issues";

const movedPages: Partial<Record<SettingsSection, SettingsPage>> = {
  agents: "general",
  files: "general",
  notifications: "general",
  issues: "forges",
};

/** The page a section id opens. */
export function settingsPageFor(section: SettingsSection): SettingsPage {
  return movedPages[section] ?? (section as SettingsPage);
}

type PageGroup = "App" | "Agents" | "Projects" | "Tools";

type PageEntry = {
  id: SettingsPage;
  label: string;
  icon: IconName;
  group: PageGroup;
  /** Words people may search for that the label does not contain. */
  keywords: string;
};

/** In sidebar order: the settings people change most come first. */
const pages: readonly PageEntry[] = [
  {
    id: "general",
    label: "General",
    icon: "settings",
    group: "App",
    keywords: "new agents defaults model view permissions chats archive notifications sound alerts files tree setup",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: "palette",
    group: "App",
    keywords: "theme colors dark light pink black sidebar project heading tint",
  },
  { id: "shortcuts", label: "Shortcuts", icon: "command", group: "App", keywords: "keys keyboard bindings" },
  { id: "updates", label: "Updates", icon: "download", group: "App", keywords: "version channel" },
  {
    id: "accounts",
    label: "Providers",
    icon: "bot",
    group: "Agents",
    keywords:
      "accounts sign in api key login agents plan limits quota subscription sidebar usage context compact compacting",
  },
  {
    id: "usage",
    label: "Usage",
    icon: "gauge",
    group: "Agents",
    keywords: "tokens cost spend price models daily chart",
  },
  { id: "skills", label: "Skills", icon: "sparkle", group: "Agents", keywords: "prompts instructions" },
  {
    id: "agentMessages",
    label: "Agents",
    icon: "users",
    group: "Agents",
    keywords:
      "buddies team teams primary plan review rounds parallel jobs zli other agents messages projects reach cross-project talk send",
  },
  {
    id: "projects",
    label: "Projects",
    icon: "folder",
    group: "Projects",
    keywords: "folders remove defaults workspace",
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: "branch",
    group: "Projects",
    keywords: "branch name template workspace",
  },
  {
    id: "forges",
    label: "Forges",
    icon: "merge",
    group: "Projects",
    keywords:
      "source control git github gitlab gitea forgejo codeberg gh glab tea pull merge request remote issues linear",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: "puzzle",
    group: "Tools",
    keywords: "mcp servers connectors plugins",
  },
  {
    id: "mobile",
    label: "Mobile",
    icon: "smartphone",
    group: "Tools",
    keywords:
      "phone android emulator iphone simulator device frame sdk avd metro port worktree doctor expo crash build package mac ssh remote",
  },
  {
    id: "phoneAccess",
    label: "Phone access",
    icon: "handoff",
    group: "Tools",
    keywords: "zli remote pair phone qr code mobile access",
  },
];

const pageGroups: readonly PageGroup[] = ["App", "Agents", "Projects", "Tools"];

/** The pages whose label, group, or keywords contain every typed word. */
export function matchingSections(query: string): readonly PageEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return pages;
  return pages.filter((entry) => {
    const haystack = `${entry.label} ${entry.group} ${entry.keywords}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const modeOptions: readonly PickerOption<WorkStyle>[] = [
  { value: "chat", label: "Chat", icon: <Icon name="message" size={15} /> },
  { value: "terminal", label: "Terminal", icon: <Icon name="terminal" size={15} /> },
  { value: "chat-terminal", label: "Chat + terminal", icon: <Icon name="panelBottom" size={15} /> },
];

const workStyleHint: Record<WorkStyle, string> = {
  chat: "Chat only: messages, a work log, and changed files. The terminal stays out of sight.",
  terminal: "The agent's own CLI, as it runs in your shell.",
  "chat-terminal": "Chat, with the terminal drawer open under it for your own commands.",
};

type Props = {
  projection: RuntimeProjection | undefined;
  initialProjectId?: string | undefined;
  initialSection?: SettingsSection;
  /** The Integrations tab to open on. */
  integrationsView?: IntegrationsView | undefined;
  /** A catalog id the Integrations Browse tab opens on. */
  focusConnector?: string | undefined;
  notifications: {
    settings: NotificationSettings | undefined;
    update(patch: Partial<NotificationSettings>): void;
  };
  updates?: Updates | undefined;
  onRestartToUpdate?(): void;
  /** Opens a terminal that runs the agent's sign-in for a sign-in account. */
  onSignIn?(account: Account): Promise<string | undefined>;
  onAddProject?(): void;
  /** Opens the welcome setup again: agents, how new agents open, and projects to add. */
  onRunSetup?(): void;
  /** Removes a project from ZLI and resolves with a problem to show, if any. */
  onRemoveProject?(projectId: string): Promise<string | undefined>;
  onClose(): void;
};

export function SettingsDialog({
  projection,
  initialProjectId,
  initialSection = "general",
  integrationsView,
  focusConnector,
  notifications,
  updates,
  onRestartToUpdate = () => undefined,
  onSignIn,
  onAddProject,
  onRunSetup,
  onRemoveProject,
  onClose,
}: Props) {
  const [page, setPage] = useState<SettingsPage>(() => settingsPageFor(initialSection));
  // A link inside Settings, such as Issues pointing to Forges, asks for another section while the dialog is open.
  useEffect(() => {
    setPage(settingsPageFor(initialSection));
  }, [initialSection]);
  const [query, setQuery] = useState("");
  const tabsId = useId();
  const tabRefs = useRef<Partial<Record<SettingsPage, HTMLButtonElement | null>>>({});
  const panelRef = useRef<HTMLElement>(null);
  const visible = matchingSections(query);
  // While a search hides the open page, the first match takes its place in the tab order.
  const focusable = visible.some((entry) => entry.id === page) ? page : visible[0]?.id;

  const select = (next: SettingsPage) => {
    setPage(next);
    if (panelRef.current) panelRef.current.scrollTop = 0;
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return;
    const index = visible.findIndex((entry) => entry.id === page);
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
            {pageGroups.map((group) => {
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
                      aria-selected={page === entry.id}
                      aria-controls={`${tabsId}-panel`}
                      tabIndex={focusable === entry.id ? 0 : -1}
                      onClick={() => select(entry.id)}
                    >
                      <Icon name={entry.icon} size={16} />
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
          <IconButton label="Close" icon="x" size="sm" className="settings-close" onClick={onClose} />
          <section
            ref={panelRef}
            className="settings-panel"
            role="tabpanel"
            id={`${tabsId}-panel`}
            aria-labelledby={`${tabsId}-${page}`}
          >
            {page === "general" ? (
              <GeneralSettings projection={projection} notifications={notifications} onRunSetup={onRunSetup} />
            ) : null}
            {page === "appearance" ? <AppearanceSection /> : null}
            {page === "shortcuts" ? <ShortcutSettings /> : null}
            {page === "updates" ? <UpdatesSection updates={updates} onRestart={onRestartToUpdate} /> : null}
            {page === "accounts" ? (
              <>
                <AccountsSection projection={projection} {...(onSignIn ? { onSignIn } : {})} />
                <ConnectedAppsLock />
              </>
            ) : null}
            {page === "usage" ? <UsageSection projection={projection} /> : null}
            {page === "skills" ? <SkillsSection projection={projection} initialProjectId={initialProjectId} /> : null}
            {page === "agentMessages" ? <AgentsSection projection={projection} /> : null}
            {page === "projects" ? (
              <ProjectsSection projection={projection} onAddProject={onAddProject} onRemoveProject={onRemoveProject} />
            ) : null}
            {page === "worktrees" ? <WorktreeSettings projection={projection} /> : null}
            {page === "forges" ? <ForgesSection /> : null}
            {page === "integrations" ? (
              <IntegrationsSection
                initialView={integrationsView}
                focusConnector={focusConnector}
                onAgentMessages={() => select("agentMessages")}
              />
            ) : null}
            {page === "mobile" ? <MobileSection /> : null}
            {page === "phoneAccess" ? <MobileAccessSection /> : null}
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
  const style = workStyleOf(value);
  const set = (patch: Partial<Record<keyof LaunchDefaults, string>>) => {
    const next: Record<string, string | boolean | undefined> = { ...value, ...patch };
    for (const key of Object.keys(next)) if (!next[key]) delete next[key];
    onChange(next as LaunchDefaults);
  };
  return (
    <>
      <SettingsRow label="Agent" description="The CLI selected when the dialog opens." htmlFor={`${ids}-agent`}>
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
      </SettingsRow>
      {value.provider && models.length > 0 ? (
        <SettingsRow label="Model" description="Used when the agent lets you choose one." htmlFor={`${ids}-model`}>
          <Select
            id={`${ids}-model`}
            label="Model"
            value={value.model ?? ""}
            options={modelOptions(models, value.model, value.provider)}
            onChange={(model) => set({ model })}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow
        label="View"
        description={style ? workStyleHint[style] : "Chat shows messages and changes. Terminal runs the agent's CLI."}
        htmlFor={`${ids}-view`}
      >
        <Select<string>
          id={`${ids}-view`}
          label="View"
          value={style ?? ""}
          options={[inherit, ...modeOptions]}
          onChange={(next) => onChange(withWorkStyle(value, (next || undefined) as WorkStyle | undefined))}
        />
      </SettingsRow>
      <SettingsRow
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
      </SettingsRow>
    </>
  );
}

/**
 * Which sound notifications make, how loud, and a button to hear it. Every sound, a file the person added
 * included, plays right here.
 */
function NotificationSoundRows({
  alerts,
  notifications,
}: {
  alerts: NotificationSettings;
  notifications: { update(patch: Partial<NotificationSettings>): void };
}) {
  const toneId = useId();
  const tone = alerts.tone && isNotificationTone(alerts.tone) ? alerts.tone : DEFAULT_NOTIFICATION_TONE;
  const volume = alerts.volume ?? 70;
  const off = !alerts.enabled || !alerts.sound;
  const play = () => playNotificationTone(tone, volume);
  const customSound = useCustomSound();
  const fileInput = useRef<HTMLInputElement>(null);
  const [soundError, setSoundError] = useState<string>();
  return (
    <>
      <SettingsRow label="Notification sound" description="Pick a sound, or add your own sound file." htmlFor={toneId}>
        <span className="notification-sound">
          <Select<NotificationTone>
            id={toneId}
            label="Notification sound"
            value={tone}
            disabled={off}
            options={NOTIFICATION_TONES}
            onChange={(next) => {
              notifications.update({ tone: next });
              if (next !== "custom" || customSound) playNotificationTone(next, volume);
            }}
          />
          <Button size="sm" icon="play" disabled={off || (tone === "custom" && !customSound)} onClick={play}>
            Play
          </Button>
        </span>
      </SettingsRow>
      {tone === "custom" ? (
        <SettingsRow
          label="Your sound"
          description={soundError ?? (customSound ? customSound.name : "An MP3, WAV, or OGG file under 1 MB.")}
          descriptionTone={soundError ? "warning" : undefined}
        >
          <span className="notification-sound">
            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                setSoundError(undefined);
                saveCustomSound(file)
                  .then(() => playNotificationTone("custom", volume))
                  .catch((error: unknown) =>
                    setSoundError(error instanceof Error ? error.message : "The sound could not be added."),
                  );
              }}
            />
            <Button size="sm" icon="upload" disabled={off} onClick={() => fileInput.current?.click()}>
              {customSound ? "Replace" : "Choose file"}
            </Button>
            {customSound ? (
              <Button size="sm" variant="ghost" disabled={off} onClick={clearCustomSound}>
                Remove
              </Button>
            ) : null}
          </span>
        </SettingsRow>
      ) : null}
      <SettingsRow label="Volume" description="How loud notifications play.">
        <span className="type-size">
          <input
            className="type-size-range"
            type="range"
            min={0}
            max={100}
            step={5}
            aria-label="Notification volume"
            value={volume}
            disabled={off}
            onChange={(event) => notifications.update({ volume: Number(event.currentTarget.value) })}
            onPointerUp={() => playNotificationTone(tone, volume)}
          />
          <span className="type-size-value">{volume}%</span>
        </span>
      </SettingsRow>
    </>
  );
}

/** The settings people change most: what new agents start with, how chats behave, and alerts. */
function GeneralSettings({
  projection,
  notifications,
  onRunSetup,
}: {
  projection: RuntimeProjection | undefined;
  notifications: {
    settings: NotificationSettings | undefined;
    update(patch: Partial<NotificationSettings>): void;
  };
  onRunSetup?: (() => void) | undefined;
}) {
  const settings = useAppSettings();
  const treeId = useId();
  const alerts = notifications.settings;
  return (
    <>
      <SettingsPageHeader title="General">Defaults for new agents, chats, notifications, and files.</SettingsPageHeader>
      <SettingsGroup
        title="New agents"
        description="What the New agent dialog starts with. Last used repeats your previous choice."
      >
        <LaunchFields
          projection={projection}
          value={settings.defaults}
          inheritLabel="Last used"
          onChange={(defaults) => updateAppSettings((current) => ({ ...current, defaults }))}
        />
      </SettingsGroup>
      <SettingsGroup title="Chats">
        <Switch
          label="Show several chats at once"
          hint="Open chats share the screen side by side. Off shows one chat at a time."
          checked={settings.severalChats}
          onChange={(checked) => updateAppSettings((current) => ({ ...current, severalChats: checked }))}
        />
        <Switch
          label="Archive chats when their pull request merges"
          hint="The chat moves to Archived at the bottom of the sidebar once its pull request merges or closes."
          checked={settings.archiveMergedChats}
          onChange={(checked) => updateAppSettings((current) => ({ ...current, archiveMergedChats: checked }))}
        />
      </SettingsGroup>
      <SettingsGroup
        title="Notifications"
        description={alerts ? "Agents already on screen stay quiet while the ZLI window has focus." : undefined}
      >
        {alerts ? (
          <>
            <Switch
              label="Desktop notifications"
              hint="Notify when an agent finishes or needs input, and badge the taskbar or dock icon."
              checked={alerts.enabled}
              onChange={(enabled) => notifications.update({ enabled })}
            />
            <Switch
              label="Sound"
              hint="Play a sound with each notification."
              checked={alerts.sound}
              disabled={!alerts.enabled}
              onChange={(sound) => notifications.update({ sound })}
            />
            <NotificationSoundRows alerts={alerts} notifications={notifications} />
          </>
        ) : (
          <p className="setting-placeholder">Notifications are available in the ZLI desktop app only.</p>
        )}
      </SettingsGroup>
      <SettingsGroup title="Files">
        <SettingsRow
          label="File tree position"
          description="Where the tree sits when the Files panel is wide enough for the tree and a file."
          htmlFor={treeId}
        >
          <Select
            id={treeId}
            label="File tree position"
            value={settings.fileTreePosition}
            options={treePositionOptions}
            onChange={(fileTreePosition) => updateAppSettings((current) => ({ ...current, fileTreePosition }))}
          />
        </SettingsRow>
      </SettingsGroup>
      <StorageGroup />
      {onRunSetup ? (
        <SettingsGroup title="Setup">
          <SettingsRow
            label="Welcome setup"
            description="Check your agents, pick how new agents open, and add projects from your agent history."
          >
            <Button size="sm" icon="reload" onClick={onRunSetup}>
              Run setup again
            </Button>
          </SettingsRow>
        </SettingsGroup>
      ) : null}
    </>
  );
}

const treePositionOptions: readonly PickerOption<FileTreePosition>[] = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
];

/**
 * Settings → Projects. A plain list of folders; each opens its own page with its name, how new worktrees are set
 * up, the defaults new agents start with there, and Remove.
 */
function ProjectsSection({
  projection,
  onAddProject,
  onRemoveProject,
}: {
  projection: RuntimeProjection | undefined;
  onAddProject?: (() => void) | undefined;
  onRemoveProject?: ((projectId: string) => Promise<string | undefined>) | undefined;
}) {
  const projects = projection?.projects ?? [];
  // Always opens on the list; Settings is often opened while some project is in view, not to change that one.
  const [openId, setOpenId] = useState<string>();
  const [removed, setRemoved] = useState<string>();
  // A project removed from here, or from elsewhere while Settings is open, goes back to the list.
  const open = projects.find((project) => project.projectId === openId);

  if (open) {
    return (
      <ProjectPage
        projection={projection}
        project={open}
        onBack={() => setOpenId(undefined)}
        {...(onRemoveProject
          ? {
              onRemove: async () => {
                const problem = await onRemoveProject(open.projectId);
                if (!problem) {
                  setRemoved(open.name);
                  setOpenId(undefined);
                }
                return problem;
              },
            }
          : {})}
      />
    );
  }

  return (
    <>
      <SettingsPageHeader title="Projects">
        Folders you added to ZLI. Open one to change how it works.
      </SettingsPageHeader>
      {removed ? (
        <p className="settings-done" role="status">
          <Icon name="check" size={14} />
          <span>Removed {removed} from ZLI. Its folder is still on disk.</span>
        </p>
      ) : null}
      <SettingsGroup
        title="Folders"
        actions={
          onAddProject ? (
            <Button size="sm" variant="ghost" icon="folderPlus" onClick={onAddProject}>
              Add project
            </Button>
          ) : undefined
        }
        bare
      >
        {projects.length === 0 ? (
          <p className="settings-empty">No projects yet. Add a folder to start agents in it.</p>
        ) : (
          <ul className="project-list" aria-label="Projects">
            {projects.map((project) => {
              const running = projectStats(projection, project).running;
              return (
                <li key={project.projectId} className="project-row">
                  <button
                    type="button"
                    className="project-open"
                    onClick={() => {
                      setRemoved(undefined);
                      setOpenId(project.projectId);
                    }}
                  >
                    <span className="project-copy">
                      <span className="project-name">{project.name}</span>
                      <span className="project-path">{project.path}</span>
                    </span>
                    {running > 0 ? (
                      <span className="project-running">
                        <span className="project-running-dot" aria-hidden="true" />
                        {running} running
                      </span>
                    ) : null}
                    <Icon name="chevronRight" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>
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

/** The project's zli.json, read fresh each time its page opens. */
function useProjectConfig(projectId: string): ProjectConfigResult | undefined {
  const { dispatch } = useRuntime();
  const [config, setConfig] = useState<ProjectConfigResult>();
  useEffect(() => {
    let cancelled = false;
    setConfig(undefined);
    void dispatch({ protocolVersion: 1, commandId: makeCommandId(), command: { type: "project.config", projectId } })
      .then((response) => {
        if (cancelled || !response || response.accepted === false) return;
        const parsed = ProjectConfigResult.safeParse(response.result);
        if (parsed.success) setConfig(parsed.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dispatch, projectId]);
  return config;
}

/** One project's page: name, new worktrees, agent defaults, and Remove last. */
function ProjectPage({
  projection,
  project,
  onBack,
  onRemove,
}: {
  projection: RuntimeProjection | undefined;
  project: ProjectProjection;
  onBack(): void;
  onRemove?: () => Promise<string | undefined>;
}) {
  const settings = useAppSettings();
  const { dispatch } = useRuntime();
  const ids = useId();
  const [name, setName] = useState(project.name);
  const [renameProblem, setRenameProblem] = useState<string>();
  const config = useProjectConfig(project.projectId);
  const override = settings.projects[project.projectId] ?? {};
  const setOverride = (next: LaunchDefaults) =>
    updateAppSettings((current) => {
      const { [project.projectId]: _previous, ...others } = current.projects;
      return { ...current, projects: Object.keys(next).length > 0 ? { ...others, [project.projectId]: next } : others };
    });

  useEffect(() => setName(project.name), [project.name]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === project.name) {
      setName(project.name);
      return;
    }
    setRenameProblem(undefined);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "project.rename", projectId: project.projectId, name: next },
    });
    if (response?.accepted === false) {
      setRenameProblem(response.error.message);
      setName(project.name);
    }
  };

  const worktree = config?.status === "valid" ? config.config.worktree : undefined;
  const isGit = project.git !== false;

  return (
    <>
      <div className="project-page-back">
        <Button size="sm" variant="ghost" icon="arrowLeft" onClick={onBack}>
          Projects
        </Button>
      </div>
      <SettingsPageHeader title={project.name}>
        <span className="is-mono">{project.path}</span>
      </SettingsPageHeader>

      <SettingsGroup title="Project">
        <SettingsRow
          label="Name"
          description={renameProblem ?? "How it shows in the sidebar. The folder keeps its name."}
          descriptionTone={renameProblem ? "warning" : undefined}
          htmlFor={`${ids}-name`}
        >
          <input
            id={`${ids}-name`}
            className="input"
            value={name}
            maxLength={120}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setName(project.name);
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      {isGit ? (
        <SettingsGroup
          title="New worktrees"
          description={
            <>
              Set in <code>zli.json</code> at the top of the repository, so everyone who clones it gets the same setup.
            </>
          }
        >
          {!config ? (
            <SettingsRow label="zli.json" description="Reading the project file.">
              <span className="spinner" aria-hidden="true" />
            </SettingsRow>
          ) : config.status === "invalid" ? (
            <SettingsRow label="zli.json" description={config.message} descriptionTone="warning">
              <span className="settings-value">Not used</span>
            </SettingsRow>
          ) : (
            <>
              <SettingsRow label="Copied files" description="Brought over from this folder, such as .env.">
                <ConfigList items={worktree?.copy} />
              </SettingsRow>
              <SettingsRow label="Setup commands" description="Run in order inside each new worktree.">
                <ConfigList items={worktree?.setup} />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="Agent defaults"
        description="What a new agent in this project starts with. Default follows General."
        actions={
          Object.keys(override).length > 0 ? (
            <Button size="sm" variant="ghost" icon="rotate" onClick={() => setOverride({})}>
              Reset
            </Button>
          ) : undefined
        }
      >
        <LaunchFields projection={projection} value={override} inheritLabel="Default" onChange={setOverride} />
      </SettingsGroup>

      {onRemove ? <ProjectRemoval projection={projection} project={project} onRemove={onRemove} /> : null}
    </>
  );
}

/** A short list from zli.json, or None. */
function ConfigList({ items }: { items: readonly string[] | undefined }) {
  if (!items || items.length === 0) return <span className="settings-value is-dim">None</span>;
  return (
    <ul className="project-config-list">
      {items.map((item) => (
        <li key={item}>
          <code>{item}</code>
        </li>
      ))}
    </ul>
  );
}

/** Removing takes two clicks on purpose: the first button only asks, so a stray click removes nothing. */
function ProjectRemoval({
  projection,
  project,
  onRemove,
}: {
  projection: RuntimeProjection | undefined;
  project: ProjectProjection;
  onRemove(): Promise<string | undefined>;
}) {
  const [confirming, setConfirming] = useState(false);
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
    <SettingsGroup title="Remove" tone="danger">
      {confirming ? (
        <div className="project-remove">
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
            <Button ref={keepRef} size="sm" variant="ghost" disabled={removing} onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button size="sm" variant="danger" icon="trash" loading={removing} onClick={() => void remove()}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <SettingsRow label="Remove from ZLI" description="Its agents and chats go too. The folder stays on disk.">
          <Button ref={askRef} size="sm" icon="trash" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** A folder path ZLI can use as is: a drive or root on Windows, or a path from / elsewhere. */
function isAbsoluteFolder(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function WorktreeSettings({ projection }: { projection: RuntimeProjection | undefined }) {
  const settings = useAppSettings();
  const { bridge } = useRuntime();
  const prefs = settings.worktrees;
  const [draft, setDraft] = useState(settings.branchTemplate);
  const [location, setLocation] = useState(prefs.location ?? "");
  const ids = useId();
  const provider = useMemo(() => {
    const listed = listedDiscoveries(projection?.providers);
    return settings.defaults.provider ?? preferredProvider(listed);
  }, [projection?.providers, settings.defaults.provider]);
  const template = draft.trim() || settings.branchTemplate;
  const preview = branchFromTemplate(template, provider, new Date(), () => "k3f9");
  const repeats = !template.includes("{random}");
  const locationProblem =
    location.trim() && !isAbsoluteFolder(location.trim()) ? "Use a full path, such as D:\\worktrees." : undefined;

  const setPrefs = (patch: { [Key in keyof WorktreePrefs]?: WorktreePrefs[Key] | undefined }) =>
    updateAppSettings((current) => ({ ...current, worktrees: parseWorktreePrefs({ ...current.worktrees, ...patch }) }));
  const saveLocation = (value: string) => {
    setLocation(value);
    const trimmed = value.trim();
    if (!trimmed || isAbsoluteFolder(trimmed)) setPrefs({ location: trimmed || undefined });
  };
  const browse = async () => {
    const picked = await bridge?.dialog?.openProject();
    if (picked) saveLocation(picked);
  };
  const save = (value: string) => {
    setDraft(value);
    if (value.trim()) updateAppSettings((current) => ({ ...current, branchTemplate: value }));
  };
  const insert = (token: string) => save(`${draft.replace(/[-/]+$/u, "")}-${token}`);

  return (
    <>
      <SettingsPageHeader title="Worktrees">
        Each agent can work on its own copy of the project, on its own branch, so agents never edit the same files.
      </SettingsPageHeader>

      <SettingsGroup title="Creating">
        <SettingsRow
          label="Location"
          htmlFor={`${ids}-location`}
          description={
            locationProblem ??
            (prefs.location
              ? "One folder for every project, with a subfolder per project. Existing worktrees stay where they are."
              : "Empty keeps each project's worktrees in a folder next to it.")
          }
          descriptionTone={locationProblem ? "warning" : undefined}
        >
          <div className="setting-inline">
            <input
              id={`${ids}-location`}
              className="input is-mono"
              value={location}
              placeholder="Next to each project"
              spellCheck={false}
              onChange={(event) => saveLocation(event.target.value)}
            />
            {bridge?.dialog?.openProject ? (
              <IconButton
                icon="folder"
                size="sm"
                label="Choose a folder"
                tooltip="Choose a folder"
                onClick={() => void browse()}
              />
            ) : null}
          </div>
        </SettingsRow>
        <Switch
          label="Start from the remote"
          hint="Fetch the base branch first, then branch from its remote copy, so new work starts from what's pushed. Offline, ZLI uses your local branch."
          checked={prefs.fromRemote}
          onChange={(fromRemote) => setPrefs({ fromRemote })}
        />
        <SettingsRow
          label="Setup"
          description="Files to copy, such as .env, and commands to run live in each project's zli.json."
        >
          <Button size="sm" onClick={() => requestSettings("projects")}>
            Projects
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Branch names">
        <SettingsRow
          label="Template"
          htmlFor={`${ids}-template`}
          description={
            repeats ? (
              "Without {random}, every new branch gets the same name."
            ) : (
              <>
                Next one: <code>{preview}</code>
              </>
            )
          }
          descriptionTone={repeats ? "warning" : undefined}
        >
          <div className="setting-inline">
            <input
              id={`${ids}-template`}
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
        </SettingsRow>
        <SettingsRow
          label="Parts"
          description={
            <>
              <code>{"{agent}"}</code> is the agent, <code>{"{random}"}</code> four random characters,{" "}
              <code>{"{date}"}</code> today, and <code>{"{issue}"}</code> the issue an agent started from.
            </>
          }
        >
          <div className="branch-tokens">
            {(["{agent}", "{random}", "{date}", "{issue}"] as const).map((token) => (
              <button
                key={token}
                type="button"
                className="branch-token"
                disabled={draft.includes(token)}
                onClick={() => insert(token)}
              >
                {token}
              </button>
            ))}
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Cleaning up">
        <Switch
          label="Remove the worktree with its agent"
          hint="Deleting an agent starts with Also remove its worktree ticked. You still confirm each time."
          checked={prefs.removeWithAgent}
          onChange={(removeWithAgent) => setPrefs({ removeWithAgent })}
        />
      </SettingsGroup>
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
      <SettingsPageHeader title="Shortcuts">
        Select a shortcut, then press the new keys. Esc cancels. Ctrl and Cmd count as the same key.
      </SettingsPageHeader>
      <SettingsGroup
        title="Keyboard shortcuts"
        bare
        actions={
          customized ? (
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
          ) : undefined
        }
      >
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
      </SettingsGroup>
      {/* The desktop app reads these before the page does, so a focused terminal cannot take them. */}
      <SettingsGroup title="Zoom" label="Zoom shortcuts" bare>
        <ul className="setting-list shortcut-list">
          {zoomShortcuts.map((zoom) => (
            <li className="shortcut-row" key={zoom.label}>
              <span className="shortcut-label">{zoom.label}</span>
              <span className="shortcut-reset" />
              <span
                className="shortcut-key is-fixed"
                role="img"
                aria-label={`${zoom.label}, ${shortcutText(zoom.shortcut)}`}
              >
                <Kbd shortcut={zoom.shortcut} />
              </span>
            </li>
          ))}
        </ul>
      </SettingsGroup>
    </>
  );
}

const zoomShortcuts = [
  { label: "Zoom in", shortcut: "Mod+=" },
  { label: "Zoom out", shortcut: "Mod+-" },
  { label: "Actual size", shortcut: "Mod+0" },
] as const;
