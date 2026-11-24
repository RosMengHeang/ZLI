import { type AgentServer, MAX_AGENT_SERVERS, type RuntimeProjection } from "@zli-v2/contracts";

import { probePort } from "./DevServerReactor.js";
import { detectDevServerUrls } from "./devServerDetector.js";

export type PortProbe = (url: string) => Promise<boolean>;

/** How many printed ports are looked at in all, newest first: past it, older ones are not probed. */
const MAX_CANDIDATES = 64;

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
  for (let index = activities.length - 1; index >= 0 && byPort.size < MAX_CANDIDATES; index -= 1) {
    const activity = activities[index];
    if (!activity?.detail) continue;
    for (const line of activity.detail.split(/\r\n|\n|\r/u)) {
      for (const url of detectDevServerUrls(line)) {
        const port = Number(new URL(url).port);
        if (byPort.has(port) || byPort.size >= MAX_CANDIDATES) continue;
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
  // Probed a batch at a time, newest first, until enough answer: a closed newer port never hides an older live one.
  const candidates = [...byPort.values()];
  const live: AgentServer[] = [];
  for (let start = 0; start < candidates.length && live.length < MAX_AGENT_SERVERS; start += MAX_AGENT_SERVERS) {
    const batch = candidates.slice(start, start + MAX_AGENT_SERVERS);
    const open = await Promise.all(batch.map((server) => probe(server.url).catch(() => false)));
    live.push(...batch.filter((_, index) => open[index]));
  }
  return live.slice(0, MAX_AGENT_SERVERS);
}
