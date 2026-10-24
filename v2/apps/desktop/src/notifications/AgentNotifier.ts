import {
  type AlertProjection,
  type AlertState,
  alertState,
  detectAgentAlerts,
  waitingAgentCount,
} from "./agentAlerts.js";
import type { NotificationSettings } from "./notificationSettings.js";

/** The Electron calls the notifier makes, injected so the decisions can be tested without a window. */
export type NotifierHost = {
  show(notification: { title: string; body: string; silent: boolean }, onClick: () => void): void;
  setBadgeCount(count: number): void;
  /** Draws attention to the window in the taskbar or dock until it is focused. */
  flashFrame(flash: boolean): void;
  isFocused(): boolean;
  /** Brings the window forward and selects the session. */
  activate(sessionId: string): void;
  /** Brings the window forward and opens Settings at a connector, a catalog id or a server name. */
  openConnector(connectorId: string): void;
};

const MAX_REMEMBERED_KEYS = 500;

export class AgentNotifier {
  private state: AlertState | undefined;
  private viewing = new Set<string>();
  private readonly notified = new Set<string>();
  private badge: number | undefined;
  private latest: AlertProjection | undefined;

  constructor(
    private readonly host: NotifierHost,
    private readonly settings: () => NotificationSettings,
  ) {}

  /** Sessions whose tiles are on screen. Their alerts are skipped while the window has focus. */
  setViewing(sessionIds: readonly string[]): void {
    this.viewing = new Set(sessionIds);
  }

  update(projection: AlertProjection): void {
    this.latest = projection;
    const previous = this.state;
    this.state = alertState(projection);
    const settings = this.settings();
    this.syncBadge(settings.enabled ? waitingAgentCount(projection) : 0);
    if (!previous || !settings.enabled) return;
    const focused = this.host.isFocused();
    let flash = false;
    for (const alert of detectAgentAlerts(previous, projection)) {
      if (this.notified.has(alert.key)) continue;
      this.remember(alert.key);
      if (focused && this.viewing.has(alert.sessionId)) continue;
      this.host.show({ title: alert.title, body: alert.body, silent: !settings.sound }, () =>
        this.host.activate(alert.sessionId),
      );
      if (!focused && (alert.kind === "approval" || alert.kind === "user-input")) flash = true;
    }
    if (flash) this.host.flashFrame(true);
  }

  /** An agent asked the person to connect a service. Shown even while the window has focus. */
  connectorRequest(request: { title: string; body: string; connectorId: string }): void {
    const settings = this.settings();
    if (!settings.enabled) return;
    this.host.show({ title: request.title, body: request.body, silent: !settings.sound }, () =>
      this.host.openConnector(request.connectorId),
    );
  }

  windowFocused(): void {
    this.host.flashFrame(false);
  }

  settingsChanged(): void {
    const settings = this.settings();
    this.syncBadge(settings.enabled && this.latest ? waitingAgentCount(this.latest) : 0);
    if (!settings.enabled) this.host.flashFrame(false);
  }

  private syncBadge(count: number): void {
    if (count === this.badge) return;
    this.badge = count;
    this.host.setBadgeCount(count);
  }

  private remember(key: string): void {
    this.notified.add(key);
    if (this.notified.size <= MAX_REMEMBERED_KEYS) return;
    const oldest = this.notified.values().next().value;
    if (oldest !== undefined) this.notified.delete(oldest);
  }
}
