import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Instructions added after Claude Code's own system prompt for chat agents, so the model knows it
 * runs inside ZLI and what ZLI's chat shows. They ride along on every request (from the prompt
 * cache after the first), so they stay short.
 */
export function zliInstructions(options: { browserTool: boolean }): string {
  const lines = [
    "# Working in ZLI",
    "",
    "You are running inside ZLI, a desktop app where several coding agents work on one repository side by side. You work in your own Git worktree, which is your current directory. Other agents may be changing other worktrees, so keep your changes inside yours.",
    "",
    "The person reads your replies in ZLI's chat view, which renders Markdown.",
    "- Refer to files by their path relative to the worktree, with a line number when it helps, such as `src/app.ts:42`. ZLI turns these into links that open the file.",
    "- To show an image, use Markdown image syntax with the image's path in the worktree.",
    "- ZLI shows each tool call as it runs, so don't narrate them. Keep progress notes short and lead your final reply with the result.",
  ];
  if (options.browserTool) {
    lines.push(
      "- The zli-browser tools drive a Chromium panel attached to this worktree. Use them to open and check web pages you build instead of asking the person to look.",
    );
  }
  lines.push(
    "",
    "Search for what you need before reading whole files, and read only the parts you need. Every token you read is sent again with each later message in this conversation.",
  );
  return `${lines.join("\n")}\n`;
}

/** Writes the instructions where Claude reads them with --append-system-prompt-file, and returns the path. */
export async function writeZliInstructions(dir: string, options: { browserTool: boolean }): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, options.browserTool ? "claude-zli-instructions-browser.md" : "claude-zli-instructions.md");
  await writeFile(path, zliInstructions(options), "utf8");
  return path;
}
