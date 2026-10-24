import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeEventEnvelope, RuntimeProjection } from "@zli-v2/contracts";

import { buildSupportEntries, createSupportBundle } from "./SupportBundle.js";

const ids = {
  environment: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000002",
  worktree: "00000000-0000-4000-8000-000000000003",
  thread: "00000000-0000-4000-8000-000000000004",
  terminal: "00000000-0000-4000-8000-000000000005",
  profile: "00000000-0000-4000-8000-000000000006",
  browser: "00000000-0000-4000-8000-000000000007",
  event: "00000000-0000-4000-8000-000000000008",
};

const projection = {
  environment: {
    environmentId: ids.environment,
    label: "ZLI local environment",
    protocolVersion: 1,
    capabilities: { eventReplay: true, terminals: true },
  },
  projects: [{ projectId: ids.project, path: "C:\\secret\\project", name: "project" }],
  worktrees: [
    {
      worktreeId: ids.worktree,
      projectId: ids.project,
      path: "C:\\secret\\worktree",
      branch: "feature/support-bundle",
      status: "ready",
    },
  ],
  threads: [
    {
      threadId: ids.thread,
      worktreeId: ids.worktree,
      provider: "codex",
      status: "idle",
      capabilities: { structuredApproval: true },
    },
  ],
  terminals: [
    {
      terminalId: ids.terminal,
      worktreeId: ids.worktree,
      title: "Shell",
      status: "running",
      lastSequence: 4,
    },
  ],
  browserTabs: [
    {
      browserTabId: ids.browser,
      profileId: ids.profile,
      worktreeId: ids.worktree,
      url: "https://private.example.test/secret",
      title: "Private tab",
      active: true,
      status: "idle",
    },
  ],
  attention: [],
  lastSequence: 4,
} as unknown as RuntimeProjection;

const events = [
  {
    protocolVersion: 1,
    sequence: 4,
    eventId: ids.event,
    occurredAt: "2026-09-21T00:00:00.000Z",
    event: { type: "terminal.write.requested", terminalId: ids.terminal, data: "file contents and token=super-secret" },
  },
] as RuntimeEventEnvelope[];

describe("SupportBundle", () => {
  it("keeps support data allowlisted and redacts sensitive log values", () => {
    const entries = buildSupportEntries({
      projection,
      events,
      logs: [
        {
          level: "error",
          message:
            "Authorization: Bearer super-secret prompt=do-not-include https://private.example.test C:\\secret\\file.txt",
          context: { component: "provider", operation: "request", secret: "also-secret", retryable: true },
        },
      ],
    });
    const combined = Object.values(entries).join("\n");

    expect(combined).toContain("allowlist-v1");
    expect(combined).toContain("terminal.write.requested");
    expect(combined).toContain("REDACTED");
    expect(combined).not.toContain("super-secret");
    expect(combined).not.toContain("do-not-include");
    expect(combined).not.toContain("private.example.test");
    expect(combined).not.toContain("C:\\secret");
    expect(combined).not.toContain("file contents and token");
    expect(combined).not.toContain("https://");
    expect(entries["runtime.json"]).not.toContain("url");
    expect(entries["runtime.json"]).not.toContain("path");
  });

  it("names the desktop build in the manifest", () => {
    const entries = buildSupportEntries({
      projection,
      app: { version: "0.4.2", platform: "darwin", arch: "arm64", electron: "44.4.2", packaged: true },
    });
    expect(JSON.parse(entries["manifest.json"] ?? "{}").app).toEqual({
      version: "0.4.2",
      platform: "darwin",
      arch: "arm64",
      electron: "44.4.2",
      packaged: true,
    });
    expect(JSON.parse(buildSupportEntries({ projection })["manifest.json"] ?? "{}").app).toBeUndefined();
  });

  it("excludes cookie values and environment credentials from every bundle entry", () => {
    const entries = buildSupportEntries({
      projection,
      events,
      logs: [
        { level: "warn", message: "Cookie: session=private-cookie" },
        { level: "error", message: "ZLI_API_KEY=private-api-key ZLI_SECRET=private-env-secret" },
      ],
    });
    const combined = Object.values(entries).join("\n");

    expect(combined).not.toContain("private-cookie");
    expect(combined).not.toContain("private-api-key");
    expect(combined).not.toContain("private-env-secret");
    expect(combined).toContain("REDACTED");
  });

  it("redacts quoted and unquoted multiword prompt values in logs", () => {
    const entries = buildSupportEntries({
      projection,
      logs: [
        { level: "error", message: 'prompt="private multiword customer text"' },
        { level: "error", message: "prompt=another private customer request" },
      ],
    });
    const combined = Object.values(entries).join("\n");

    expect(combined).not.toContain("multiword customer text");
    expect(combined).not.toContain("private customer request");
    expect(combined).toContain("REDACTED");
  });

  it("writes a real non-overwriting zip bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-support-bundle-"));
    const destination = join(directory, "diagnostics.zip");
    try {
      const result = await createSupportBundle({
        destinationPath: destination,
        allowedRoot: directory,
        projection,
        events,
      });
      const archive = await readFile(destination);
      expect(archive.subarray(0, 4).toString("hex")).toBe("504b0304");
      expect(archive.toString("utf8")).toContain("manifest.json");
      expect(archive.toString("utf8")).toContain("runtime.json");
      expect(result.entries).toEqual(["manifest.json", "runtime.json", "logs.jsonl", "events.jsonl"]);

      await expect(
        createSupportBundle({ destinationPath: destination, allowedRoot: directory, projection }),
      ).rejects.toMatchObject({
        code: "already_exists",
      });
      await expect(
        createSupportBundle({ destinationPath: join(directory, "notes.txt"), allowedRoot: directory, projection }),
      ).rejects.toMatchObject({
        code: "invalid_destination",
        message: "Support bundles must use a .zip destination.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects destination paths that escape the allowed directory with ..", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-support-bundle-"));
    const escaped = join(dirname(directory), "zli-support-traversal.zip");
    try {
      const attempt = createSupportBundle({
        destinationPath: `${directory}${sep}..${sep}zli-support-traversal.zip`,
        allowedRoot: directory,
        projection,
      });
      await expect(attempt).rejects.toMatchObject({
        code: "invalid_destination",
        message: "Support bundle destination must stay inside the export directory.",
      });
      await expect(
        createSupportBundle({
          destinationPath: `..${sep}zli-support-traversal.zip`,
          allowedRoot: directory,
          projection,
        }),
      ).rejects.toMatchObject({ code: "invalid_destination" });
      await expect(access(escaped)).rejects.toThrow();
    } finally {
      await rm(escaped, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects absolute destinations outside the allowed directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-support-bundle-"));
    const outside = join(dirname(directory), "zli-support-absolute.zip");
    const sibling = `${directory}-evil${sep}bundle.zip`;
    try {
      await expect(
        createSupportBundle({ destinationPath: outside, allowedRoot: directory, projection }),
      ).rejects.toMatchObject({
        code: "invalid_destination",
        message: "Support bundle destination must stay inside the export directory.",
      });
      await expect(
        createSupportBundle({ destinationPath: sibling, allowedRoot: directory, projection }),
      ).rejects.toMatchObject({ code: "invalid_destination" });
      await expect(access(outside)).rejects.toThrow();
    } finally {
      await rm(outside, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
