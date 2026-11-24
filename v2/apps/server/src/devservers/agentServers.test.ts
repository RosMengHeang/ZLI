import type { RuntimeProjection, ThreadActivityProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { findAgentServers } from "./agentServers.js";

const threadId = "00000000-0000-4000-8000-000000000b01" as ThreadActivityProjection["threadId"];
const otherThread = "00000000-0000-4000-8000-000000000b02" as ThreadActivityProjection["threadId"];

function step(id: string, patch: Partial<ThreadActivityProjection>): ThreadActivityProjection {
  return { activityId: id, threadId, kind: "command", title: "Run it", status: "completed", ...patch };
}

const projection = (activities: ThreadActivityProjection[]): Pick<RuntimeProjection, "activities"> => ({
  activities,
});

describe("findAgentServers", () => {
  it("reports an address a shell step announced while its port answers", async () => {
    const probed: string[] = [];
    const servers = await findAgentServers(
      projection([
        step("a1", {
          title: "Start the dev server",
          command: "npm run dev",
          detail: "VITE v6 ready in 300 ms\n  ➜  Local:   http://localhost:5173/\n",
        }),
      ]),
      [threadId],
      async (url) => {
        probed.push(url);
        return true;
      },
    );
    expect(probed).toEqual(["http://localhost:5173/"]);
    expect(servers).toEqual([
      {
        threadId,
        activityId: "a1",
        url: "http://localhost:5173/",
        port: 5173,
        command: "npm run dev",
        title: "Start the dev server",
      },
    ]);
  });

  it("leaves out closed ports, calls to a server, other chats, and steps that are not commands", async () => {
    const servers = await findAgentServers(
      projection([
        step("closed", { detail: "Server running at http://localhost:3000" }),
        step("curl", { detail: "GET http://localhost:4000/api 200" }),
        step("other", { threadId: otherThread, detail: "Listening on http://localhost:5000" }),
        step("read", { kind: "file-read", detail: "Server running at http://localhost:6000" }),
      ]),
      [threadId],
      async (url) => !url.includes(":3000"),
    );
    expect(servers).toEqual([]);
  });

  it("still finds an older server that runs when the newer ports have all closed", async () => {
    // Nine servers announced, oldest first; only the oldest still answers.
    const steps = Array.from({ length: 9 }, (_, index) =>
      step(`s${index}`, {
        detail: `Local: http://localhost:${4000 + index}/
`,
      }),
    );
    const servers = await findAgentServers(projection(steps), [threadId], async (url) => url.includes(":4000/"));
    expect(servers.map((server) => server.port)).toEqual([4000]);
  });

  it("lets the newest step name a port", async () => {
    const servers = await findAgentServers(
      projection([
        step("old", { title: "Old", detail: "Listening on http://localhost:8080" }),
        step("new", { title: "BashOutput", detail: "Server ready on http://127.0.0.1:8080" }),
      ]),
      [threadId],
      async () => true,
    );
    expect(servers.map((server) => [server.activityId, server.url])).toEqual([["new", "http://127.0.0.1:8080/"]]);
  });
});
