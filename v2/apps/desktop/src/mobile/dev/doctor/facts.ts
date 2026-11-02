import type { MobileProjectFacts } from "@zli-v2/contracts";

import type { MobileDevHost } from "../host.js";
import { notesFile, notesState, renderBlock } from "./agentsBlock.js";
import { lastDeep } from "./deepCheck.js";
import { fingerprintOf } from "./fingerprint.js";
import { findIssues, type IssueFacts } from "./knownIssues.js";
import { probeHost } from "./probes.js";
import { readProject } from "./readProject.js";

/**
 * What the doctor knows about a worktree's app: its stack, versions, findings, and the last Expo check results.
 * Undefined only when ZLI does not know the worktree. Files are read on every call, so an edit shows at once; the
 * host's tool versions are cached for a minute unless refresh is set. The build brief reads this too.
 */
export async function projectFacts(
  host: MobileDevHost,
  worktreeId: string,
  options: { refresh?: boolean } = {},
): Promise<MobileProjectFacts | undefined> {
  const root = host.worktreePath(worktreeId);
  if (!root) return undefined;
  const [read, probe] = await Promise.all([
    readProject(host.fs, root, host.os).catch(() => undefined),
    probeHost(host, options),
  ]);
  const checkedAt = host.now().toISOString();
  const hostVersions = Object.fromEntries(
    Object.entries(probe.tools).filter(([, value]) => value !== "not found" && value !== "not checked"),
  );
  const signing = {
    android: read?.androidSigning ?? "unknown",
    ios: probe.iosIdentities === undefined ? ("not-checked" as const) : { identities: probe.iosIdentities },
  };
  if (!read) {
    return {
      worktreeId,
      appDir: ".",
      stack: "none",
      versions: hostVersions,
      findings: [],
      fingerprint: fingerprintOf(hostVersions),
      checkedAt,
      host: probe.tools,
      signing,
    };
  }
  const versions = { ...read.versions, ...hostVersions };
  const deep = lastDeep(host, worktreeId);
  const issueFacts: IssueFacts = {
    appDir: read.appDir,
    stack: read.stack,
    versions,
    client: read.client,
    newArch: read.newArch,
    appIds: read.appIds,
    ...(read.android ? { android: read.android } : {}),
    ...(read.ios ? { ios: read.ios } : {}),
    signing,
    host: probe.tools,
    ...(deep ? { deep } : {}),
    ...(read.packageManager ? { packageManager: read.packageManager } : {}),
    devClient: read.devClient,
    projectFingerprint: fingerprintOf(read.versions),
    ...(read.unreadable.length > 0 ? { unreadable: read.unreadable.slice(0, 20) } : {}),
  };
  const facts: MobileProjectFacts = {
    worktreeId,
    ...issueFacts,
    findings: findIssues(issueFacts).slice(0, 50),
    fingerprint: fingerprintOf(versions),
    checkedAt,
  };
  const notes = await notesFile(host, root);
  return { ...facts, notes: { file: notes.file, state: notesState(notes.text, renderBlock(facts)) } };
}
