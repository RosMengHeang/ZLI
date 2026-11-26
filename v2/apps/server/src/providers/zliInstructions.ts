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
    "You are running inside ZLI, a desktop app where several coding agents work on one repository side by side. Your current directory is your folder: usually your own Git worktree, sometimes shared with other agents. Other agents may be changing other folders, so keep your changes inside yours.",
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
    "## Switching branches",
    "",
    "When the person asks you to switch to another branch, switch your own folder with git switch. Never start another agent for it: start_agent is for work in parallel.",
    "- Your folder may be shared. Call the zli list_agents tool first: if any agent is marked sameWorktree, switching would change the files under it. Don't switch then; tell the person and suggest the branch menu in the chat bar, which moves this chat to its own folder.",
    "- With uncommitted changes, ask whether to commit or stash them before switching.",
    "- If Git says the branch is checked out in another folder, don't force it. Tell the person which folder has it.",
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
