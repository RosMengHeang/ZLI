import { type AgentServer, MAX_AGENT_SERVERS, type RuntimeProjection } from "@zli-v2/contracts";

import { probePort } from "./DevServerReactor.js";
import { detectDevServerUrls } from "./devServerDetector.js";

export type PortProbe = (url: string) => Promise<boolean>;

/**
 * The local servers the agents of these chats started from their own shell tools and that still answer.
 * A chat agent's commands run inside the agent, not in a ZLI terminal, so the only signs are the address a
 * command printed (read with the same banner rules as terminals, so a `curl localhost:3000` is not a server)
 * and a port that accepts a connection now. The newest step that names a port speaks for it.
 */
export async function findAgentServers(
  projection: Pick<RuntimeProjection, "activities">,
  threadIds: readonly string[],
  probe: PortProbe = (url) => probePort(url, 500),
): Promise<AgentServer[]> {
  const threads = new Set(threadIds);
  const byPort = new Map<number, AgentServer>();
  const activities = (projection.activities ?? []).filter(
    (activity) => threads.has(activity.threadId) && activity.kind === "command" && activity.detail,
  );
  // Newest first, so the latest step that printed a port names it.
  for (let index = activities.length - 1; index >= 0 && byPort.size < MAX_AGENT_SERVERS; index -= 1) {
    const activity = activities[index];
    if (!activity?.detail) continue;
    for (const line of activity.detail.split(/\r\n|\n|\r/u)) {
      for (const url of detectDevServerUrls(line)) {
        const port = Number(new URL(url).port);
        if (byPort.has(port) || byPort.size >= MAX_AGENT_SERVERS) continue;
        byPort.set(port, {
          threadId: activity.threadId,
          activityId: activity.activityId,
          url,
          port,
          ...(activity.command ? { command: activity.command } : {}),
          title: activity.title,
        });
      }
    }
  }
  const candidates = [...byPort.values()];
  const open = await Promise.all(candidates.map((server) => probe(server.url).catch(() => false)));
  return candidates.filter((_, index) => open[index]);
}
