import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconBell } from "./AppIcons";
import { attentionStatusPresentation } from "../lib/statusPresentation";
import { useAgentStore } from "../stores/agentStore";
import { useAttentionStore } from "../stores/attentionStore";
import { providerDisplayName } from "../types";

function notificationTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function NotificationCenter({ projectId, projectName }: { projectId: string | null; projectName: string | null }) {
  const records = useAttentionStore((state) => state.records);
  const notifications = useAttentionStore((state) => state.notifications);
  const loading = useAttentionStore((state) => state.loading);
  const connected = useAttentionStore((state) => state.connected);
  const error = useAttentionStore((state) => state.error);
  const pendingAgentIds = useAttentionStore((state) => state.pendingAgentIds);
  const markingAllRead = useAttentionStore((state) => state.markingAllRead);
  const markAllRead = useAttentionStore((state) => state.markAllRead);
  const acknowledgeAgent = useAttentionStore((state) => state.acknowledgeAgent);
  const retryConnection = useAttentionStore((state) => state.retryConnection);
  const clearError = useAttentionStore((state) => state.clearError);
  const agents = useAgentStore((state) => state.agents);
  const selectAgent = useAgentStore((state) => state.selectAgent);

  const unreadItems = notifications
    .filter((item) => item.projectId === projectId && item.agentId
      && records[`${item.projectId}\u0000${item.agentId}`]?.unread)
    .sort((left, right) => right.sequence - left.sequence);
  const unreadCount = projectId
    ? Object.values(records)
      .filter((record) => record.projectId === projectId)
      .reduce((count, record) => count + record.unreadCount, 0)
    : 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="notification-trigger"
          aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
        >
          <IconBell />
          {unreadCount ? <span className="notification-trigger-count">{unreadCount}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="notification-panel">
        <div className="notification-header">
          <span>Notifications</span>
        </div>
        <DropdownMenuSeparator />
        {projectId && unreadCount ? (
          <DropdownMenuItem
            className="notification-action"
            disabled={markingAllRead}
            onSelect={() => void markAllRead(projectId)}
          >
            {markingAllRead ? "Marking read…" : "Mark all read"}
          </DropdownMenuItem>
        ) : null}
        {error ? (
          <>
            <div className="notification-state notification-error" role="alert">{error.message}</div>
            <DropdownMenuItem
              className="notification-action"
              disabled={loading}
              onSelect={() => {
                if (connected) clearError();
                else void retryConnection();
              }}
            >
              {loading ? "Retrying connection…" : connected ? "Dismiss" : "Retry connection"}
            </DropdownMenuItem>
          </>
        ) : loading ? (
          <div className="notification-state" role="status">Loading agent updates…</div>
        ) : unreadItems.length ? (
          <DropdownMenuGroup className="notification-list" aria-label="Unread agent notifications">
            {unreadItems.map((item) => {
              const agent = item.agentId ? agents[item.agentId] : undefined;
              const pending = Boolean(item.agentId && pendingAgentIds.includes(item.agentId));
              return (
                <DropdownMenuItem
                  key={item.eventId}
                  className="notification-item"
                  disabled={pending}
                  onSelect={() => {
                    if (!item.agentId) return;
                    if (agent) selectAgent(agent.id);
                    else void acknowledgeAgent(item.agentId, item.projectId);
                  }}
                >
                  <span className="status-dot" data-tone={item.attentionStatus === "failed" ? "danger" : item.attentionStatus === "waiting_for_you" ? "warning" : "success"} aria-hidden="true" />
                  <span className="notification-copy">
                    <strong>{agent?.name ?? "Agent no longer open"}</strong>
                    <span>{item.message}</span>
                    <span className="notification-meta">
                      {projectName ?? item.projectId}
                      {agent ? ` · ${providerDisplayName(agent.provider)}` : " · Offline"}
                      {` · ${attentionStatusPresentation(item.attentionStatus).label}`}
                    </span>
                  </span>
                  <time dateTime={item.timestamp}>{notificationTime(item.timestamp)}</time>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ) : (
          <div className="notification-state">No unread agent updates.</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
