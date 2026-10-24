import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LINEAR_GRAPHQL_URL, type LinearFetch, LinearIssues, linearFailure, linearFilter } from "./LinearIssues.js";

const KEY = "lin_api_secretsecretsecret";

const ROW = {
  id: "uuid-1",
  identifier: "ENG-12",
  title: "Crash on save",
  url: "https://linear.app/acme/issue/ENG-12/crash-on-save",
  updatedAt: "2026-01-05T00:00:00Z",
  branchName: "alice/eng-12-crash-on-save",
  state: { name: "In Progress", type: "started" },
  labels: { nodes: [{ name: "Bug", color: "#eb5757" }] },
  assignee: { name: "Alice Smith", displayName: "alice" },
  creator: { name: "Bob", displayName: "bob" },
};

type Sent = {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
};

function fakeLinear(reply: (sent: Sent) => { status?: number; body: unknown }) {
  const sent: Sent[] = [];
  const fetch: LinearFetch = async (url, init) => {
    const entry = { url, headers: init.headers, body: JSON.parse(init.body) as Sent["body"] };
    sent.push(entry);
    const { status = 200, body } = reply(entry);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, sent };
}

const linearReply = (sent: Sent) => {
  if (sent.body.query.includes("ZliViewer")) {
    return { body: { data: { viewer: { name: "Alice Smith", displayName: "alice", email: "a@example.com" } } } };
  }
  if (sent.body.query.includes("ZliIssues")) return { body: { data: { issues: { nodes: [ROW, { title: "x" }] } } } };
  if (sent.body.variables.id === "ENG-12") {
    return {
      body: {
        data: {
          issue: {
            ...ROW,
            description: "Saving a file crashes.",
            comments: {
              nodes: [
                { body: "second", createdAt: "2026-01-04T00:00:00Z", user: { name: "Bob" } },
                { body: "first", createdAt: "2026-01-03T00:00:00Z", user: { name: "Carol", displayName: "carol" } },
              ],
            },
          },
        },
      },
    };
  }
  return {
    body: { data: null, errors: [{ message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } }] },
  };
};

describe("LinearIssues", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zli-linear-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports not connected without a saved key", async () => {
    const { fetch, sent } = fakeLinear(linearReply);
    const linear = new LinearIssues({ keyPath: join(dir, "linear-key.json"), fetch });
    expect(await linear.status()).toEqual({ connected: false });
    expect(sent).toHaveLength(0);
    await expect(linear.list({})).rejects.toThrow(/not connected/u);
  });

  it("checks the key, saves it privately, and never returns it", async () => {
    const { fetch, sent } = fakeLinear(linearReply);
    const keyPath = join(dir, "linear-key.json");
    const linear = new LinearIssues({ keyPath, fetch });
    const status = await linear.connect(` ${KEY} `);
    expect(status).toEqual({ connected: true, viewer: { name: "alice", email: "a@example.com" } });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(sent[0]?.url).toBe(LINEAR_GRAPHQL_URL);
    expect(sent[0]?.headers.Authorization).toBe(KEY);
    expect(JSON.parse(await readFile(keyPath, "utf8"))).toEqual({ version: 1, apiKey: KEY });
    if (process.platform !== "win32") expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    const reloaded = new LinearIssues({ keyPath, fetch });
    expect((await reloaded.status()).viewer?.name).toBe("alice");

    expect(await linear.disconnect()).toEqual({ connected: false });
    await expect(stat(keyPath)).rejects.toThrow();
  });

  it("does not save a key Linear refuses", async () => {
    const { fetch } = fakeLinear(() => ({
      status: 400,
      body: { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] },
    }));
    const keyPath = join(dir, "linear-key.json");
    const linear = new LinearIssues({ keyPath, fetch });
    const error = (await linear.connect(KEY).catch((cause: unknown) => cause)) as Error;
    expect(error.message).toMatch(/did not accept this API key/u);
    expect(error.message).not.toContain(KEY);
    await expect(stat(keyPath)).rejects.toThrow();
  });

  it("lists issues with the filter and reads one with comments oldest first", async () => {
    const { fetch, sent } = fakeLinear(linearReply);
    const linear = new LinearIssues({ keyPath: join(dir, "linear-key.json"), fetch });
    await linear.connect(KEY);
    const list = await linear.list({ assignee: "me", query: "crash" });
    expect(list.issues).toEqual([
      {
        source: "linear",
        key: "ENG-12",
        reference: "ENG-12",
        title: "Crash on save",
        state: "open",
        stateName: "In Progress",
        url: ROW.url,
        labels: [{ name: "Bug", color: "#eb5757" }],
        assignees: ["alice"],
        author: "bob",
        updatedAt: "2026-01-05T00:00:00Z",
      },
    ]);
    expect(sent.at(-1)?.body.variables.filter).toEqual(linearFilter({ assignee: "me", query: "crash" }));

    const issue = await linear.get("ENG-12");
    expect(issue.body).toBe("Saving a file crashes.");
    expect(issue.branchName).toBe("alice/eng-12-crash-on-save");
    expect(issue.comments.map((comment) => comment.body)).toEqual(["first", "second"]);
    expect(issue.comments[0]?.author).toBe("carol");

    await expect(linear.get("ENG-999")).rejects.toThrow("Issue ENG-999 was not found in Linear.");
  });

  it("explains an unreachable Linear", async () => {
    const fetch: LinearFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const linear = new LinearIssues({ keyPath: join(dir, "linear-key.json"), fetch });
    await expect(linear.connect(KEY)).rejects.toThrow(/could not be reached/u);
  });
});

describe("linearFilter", () => {
  it("defaults to open issues", () => {
    expect(linearFilter({})).toEqual({ state: { type: { nin: ["completed", "canceled"] } } });
    expect(linearFilter({ state: "all" })).toEqual({});
  });

  it("combines search, assignee, labels, and an identifier", () => {
    expect(linearFilter({ state: "closed", assignee: "me", labels: ["Bug"], query: "eng-12" })).toEqual({
      and: [
        { state: { type: { in: ["completed", "canceled"] } } },
        { assignee: { isMe: { eq: true } } },
        { labels: { name: { eqIgnoreCase: "Bug" } } },
        {
          or: [
            { title: { containsIgnoreCase: "eng-12" } },
            { description: { containsIgnoreCase: "eng-12" } },
            { team: { key: { eqIgnoreCase: "eng" } }, number: { eq: 12 } },
          ],
        },
      ],
    });
  });
});

describe("linearFailure", () => {
  it("maps auth and rate limits, and passes successes", () => {
    expect(linearFailure(401, undefined)).toMatch(/did not accept/u);
    expect(linearFailure(200, { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] })).toMatch(
      /limiting/u,
    );
    expect(linearFailure(200, { data: {} })).toBeUndefined();
    expect(linearFailure(200, { errors: [{ message: "Field  bad\n here" }] })).toBe(
      "Linear could not answer. Field bad here",
    );
  });
});
