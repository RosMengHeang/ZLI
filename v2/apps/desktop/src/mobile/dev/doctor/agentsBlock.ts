import {
  type MobileAgentsBlockResult,
  type MobileProjectFacts,
  PROPOSAL_BLOCK_END,
  PROPOSAL_BLOCK_START,
  PROPOSAL_FILES,
} from "@zli-v2/contracts";

import { pathFor } from "../../host.js";
import type { MobileDevHost } from "../host.js";
import { proposalDigest } from "../ProposalStore.js";
import { major } from "./readProject.js";

type NotesFile = (typeof PROPOSAL_FILES)[number];

const PROPOSAL_TITLE = "Add mobile notes for agents";
const PROPOSAL_REASON =
  "Agents read this file before they work. These lines give them this project's real versions and the commands to use, so they stop guessing from old training data.";

/**
 * The text between the zli:mobile markers. Only project-level facts go in, never a worktree's port, a date, or this
 * computer's tool versions, because the file is committed and shared by every branch and every person.
 */
export function renderBlock(facts: MobileProjectFacts): string {
  const lines: string[] = ["### Mobile (written by ZLI; edit outside these markers)"];
  const v = facts.versions;
  const rn = v["react-native"];
  const js = facts.stack === "expo" || facts.stack === "react-native";
  const newArchOn = facts.newArch?.enabled === true;
  const sdk = facts.stack === "expo" ? major(v.expo) : undefined;
  const forced = facts.newArch?.source?.startsWith("Always on") === true;
  if (facts.stack === "expo") {
    const client =
      facts.client?.kind === "dev-build"
        ? "development build (expo-dev-client)"
        : facts.client?.kind === "expo-go"
          ? "runs in Expo Go"
          : "native debug build";
    const arch = facts.newArch?.enabled === undefined ? "" : `, New Architecture ${newArchOn ? "on" : "off"}`;
    lines.push(`- Expo SDK ${sdk ?? "unknown"}${rn ? ` (react-native ${rn})` : ""}, ${client}${arch}.`);
  } else if (facts.stack === "react-native") {
    const arch = facts.newArch?.enabled === undefined ? "" : `, New Architecture ${newArchOn ? "on" : "off"}`;
    lines.push(`- React Native ${rn ?? "unknown"}${arch}.`);
  } else if (facts.stack === "flutter") {
    const parts = [v.flutter ? `Flutter ${v.flutter}` : undefined, v.dart ? `Dart ${v.dart}` : undefined].filter(
      Boolean,
    );
    lines.push(`- Flutter app${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`);
  } else if (facts.stack === "android") {
    lines.push("- Native Android app.");
  } else if (facts.stack === "ios") {
    lines.push(
      `- Native iOS app${facts.ios?.deploymentTarget ? ` with deployment target ${facts.ios.deploymentTarget}` : ""}.`,
    );
  }
  if (facts.appDir !== ".") lines.push(`- The app is in \`${facts.appDir}\`; run its commands from there.`);
  const android = [
    v.gradle ? `Gradle ${v.gradle}` : undefined,
    v.agp ? `Android Gradle Plugin ${v.agp}` : undefined,
    v.kotlin ? `Kotlin ${v.kotlin}` : undefined,
  ].filter(Boolean);
  if (android.length > 0) lines.push(`- Android build: ${android.join(", ")}.`);
  if (facts.stack === "expo")
    lines.push(
      "- Install packages with `npx expo install <pkg>`, never plain `npm install`. Check new packages with the zli-mobile tool mobile_check_package first.",
    );
  else if (facts.stack === "react-native")
    lines.push(
      `- Install packages with \`${installCommand(facts.packageManager)} <pkg>\`. Check new packages with the zli-mobile tool mobile_check_package first.`,
    );
  if (js)
    lines.push(
      "- Each worktree has its own Metro port in `$ZLI_METRO_PORT`; start Metro with `--port $ZLI_METRO_PORT`. Ask mobile_workspace for the URL to open.",
    );
  if (forced) lines.push("- Do not set newArchEnabled=false; this SDK cannot turn it off.");
  if (sdk !== undefined && sdk >= 55 && !facts.devClient)
    lines.push(
      "- Expo Go from the App Store stops at SDK 54. On a physical iPhone this app needs a development build.",
    );
  if (facts.ios?.podfile) {
    const folder = facts.stack === "ios" ? facts.appDir : facts.appDir === "." ? "ios" : `${facts.appDir}/ios`;
    lines.push(`- After native dependency changes, \`pod install\` must run in \`${folder}\`.`);
  }
  lines.push(
    "- Propose install, fix, and build commands with mobile_propose so the person runs them; do not run them yourself.",
    "- Verify UI changes on a device with mobile_screenshot and mobile_snapshot before saying they work.",
    "- When a build fails, call mobile_build_brief with the log before changing versions. Never downgrade a package or silence an error just to make the build pass.",
    "- Call mobile_doctor for this computer's toolchain and the project's known problems.",
  );
  if (facts.projectFingerprint) lines.push(`- Project versions fingerprint: ${facts.projectFingerprint}.`);
  return lines.join("\n");
}

function installCommand(manager: MobileProjectFacts["packageManager"]): string {
  switch (manager) {
    case "pnpm":
      return "pnpm add";
    case "yarn":
      return "yarn add";
    case "bun":
      return "bun add";
    default:
      return "npm install";
  }
}

/** The text between the markers, or undefined when the file has no block. */
export function currentBlock(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const start = text.indexOf(PROPOSAL_BLOCK_START);
  const end = start === -1 ? -1 : text.indexOf(PROPOSAL_BLOCK_END, start);
  if (start === -1 || end === -1) return undefined;
  return text.slice(start + PROPOSAL_BLOCK_START.length, end);
}

function sameBlock(a: string | undefined, b: string): boolean {
  const clean = (value: string) => value.replaceAll("\r\n", "\n").trim();
  return a !== undefined && clean(a) === clean(b);
}

/**
 * Which file gets the block: the one that already has it, else AGENTS.md if present, else CLAUDE.md if present,
 * else a new AGENTS.md.
 */
export async function notesFile(
  host: MobileDevHost,
  root: string,
): Promise<{ file: NotesFile; text: string | undefined }> {
  const path = pathFor(host.os);
  const read = async (file: NotesFile) => {
    try {
      return await host.fs.readFile(path.join(root, file));
    } catch {
      return undefined;
    }
  };
  const texts = await Promise.all(PROPOSAL_FILES.map(async (file) => ({ file, text: await read(file) })));
  return (
    texts.find((entry) => currentBlock(entry.text) !== undefined) ??
    texts.find((entry) => entry.text !== undefined) ?? { file: "AGENTS.md", text: undefined }
  );
}

export function notesState(text: string | undefined, content: string): "missing" | "current" | "outdated" {
  const block = currentBlock(text);
  if (block === undefined) return "missing";
  return sameBlock(block, content) ? "current" : "outdated";
}

/**
 * Prepare notes: a file-block proposal for the person to review, or upToDate when the block already says this.
 * Nothing is written here; the proposal's Write button does that.
 */
export async function proposeBlock(
  host: MobileDevHost,
  worktreeId: string,
  facts: MobileProjectFacts,
): Promise<MobileAgentsBlockResult> {
  const root = host.worktreePath(worktreeId);
  if (!root) throw new Error("That worktree is not in ZLI.");
  if (facts.stack === "none") throw new Error("No mobile app found in this worktree.");
  const content = renderBlock(facts);
  const { file, text } = await notesFile(host, root);
  if (sameBlock(currentBlock(text), content)) return { upToDate: true, file };
  const baseDigest = proposalDigest(text);
  const waiting = host.proposals
    .list(worktreeId)
    .find(
      (proposal) =>
        proposal.state === "pending" &&
        proposal.action.kind === "file-block" &&
        proposal.action.file === file &&
        proposal.action.content === content &&
        proposal.action.baseDigest === baseDigest,
    );
  const proposal =
    waiting ??
    host.proposals.create({
      worktreeId,
      source: "zli",
      sourceLabel: "From the project check",
      title: currentBlock(text) === undefined ? PROPOSAL_TITLE : `Update the mobile notes in ${file}`,
      reason: PROPOSAL_REASON,
      action: { kind: "file-block", file, marker: "zli:mobile", content, baseDigest },
    });
  return { upToDate: false, file, content, proposalId: proposal.proposalId };
}
