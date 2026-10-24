import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FIRST_VERSION = "0.1.0";
export const BUMPS = ["patch", "minor", "major"];
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SKIP_MARKER = "[skip release]";

/** Reads a `vX.Y.Z` tag. Pre-release tags and anything else return undefined. */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** The highest release tag, or undefined when there is none yet. */
export function latestReleaseTag(tags) {
  let best;
  for (const tag of tags) {
    const version = parseReleaseTag(tag);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag: tag.trim(), version };
  }
  return best;
}

/** The version after the highest release tag. With no tags the first release is 0.1.0, or 1.0.0 for a major bump. */
export function nextVersion(tags, bump = "patch") {
  if (!BUMPS.includes(bump)) throw new Error(`Unknown bump "${bump}". Use patch, minor, or major.`);
  const latest = latestReleaseTag(tags);
  if (!latest) return bump === "major" ? "1.0.0" : FIRST_VERSION;
  const { major, minor, patch } = latest.version;
  if (bump === "major") return formatVersion({ major: major + 1, minor: 0, patch: 0 });
  if (bump === "minor") return formatVersion({ major, minor: minor + 1, patch: 0 });
  return formatVersion({ major, minor, patch: patch + 1 });
}

/** Markdown files anywhere and everything under a docs folder. */
export function isDocsPath(file) {
  const normalized = file.replaceAll("\\", "/");
  return normalized.toLowerCase().endsWith(".md") || /(?:^|\/)docs\//u.test(normalized);
}

/**
 * Whether a release run should stop before tagging. A manual run always releases. A push skips when
 * its commit already has a release tag, when the head commit asks to, or when every file changed since
 * the last release is documentation. An unknown change list (no release yet) never counts as docs only.
 */
export function releaseDecision({ eventName, headMessage = "", changedFiles, releasedAs }) {
  if (eventName === "workflow_dispatch") return { skip: false, reason: "manual release" };
  if (releasedAs) return { skip: true, reason: `this commit is already released as ${releasedAs}` };
  if (headMessage.toLowerCase().includes(SKIP_MARKER)) return { skip: true, reason: `head commit says ${SKIP_MARKER}` };
  if (changedFiles && changedFiles.length > 0 && changedFiles.every(isDocsPath)) {
    return { skip: true, reason: "only documentation changed" };
  }
  return { skip: false, reason: "code changed" };
}

/** Sets the version in the given package.json files, keeping their formatting. */
export async function writePackageVersions(files, version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`"${version}" is not a release version.`);
  for (const file of files) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.version = version;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

async function git(args) {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function lines(output) {
  return output.split("\n").filter(Boolean);
}

async function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}

async function main([command, ...args]) {
  if (command === "next") {
    const eventName = process.env.GITHUB_EVENT_NAME ?? "push";
    const bump = process.env.RELEASE_BUMP || "patch";
    const after = process.env.GITHUB_SHA || (await git(["rev-parse", "HEAD"])).trim();
    const tags = lines(await git(["tag", "--list", "v*"]));
    const latest = latestReleaseTag(tags);
    // Diffing against the last release rather than the push's previous head keeps a docs-only push from
    // skipping code that an earlier push merged while its release run was still waiting.
    const decision = releaseDecision({
      eventName,
      headMessage: await git(["log", "-1", "--format=%B", after]),
      changedFiles: latest ? lines(await git(["diff", "--name-only", latest.tag, after])) : undefined,
      releasedAs: latestReleaseTag(lines(await git(["tag", "--points-at", after, "--list", "v*"])))?.tag,
    });
    const version = nextVersion(tags, eventName === "workflow_dispatch" ? bump : "patch");
    await writeOutputs({
      version,
      tag: `v${version}`,
      previous_tag: latest?.tag ?? "",
      sha: after,
      skip: String(decision.skip),
      reason: decision.reason,
    });
    return;
  }
  if (command === "apply") {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    await writePackageVersions(
      [path.join(root, "package.json"), path.join(root, "apps/desktop/package.json")],
      args[0]?.replace(/^v/u, "") ?? "",
    );
    return;
  }
  throw new Error("Usage: release-version.mjs next | apply <version>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
