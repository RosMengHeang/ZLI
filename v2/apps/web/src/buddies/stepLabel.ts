import type { ThreadActivityProjection } from "@zli-v2/contracts";

/** "zli.taxz.dev" from a URL, or undefined. */
function hostOf(text: string | undefined): string | undefined {
  const match = text?.match(/https?:\/\/[^\s"'`)]+/u)?.[0];
  if (!match) return undefined;
  try {
    return new URL(match).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

/** The last part of a path, without its folders. */
function fileName(path: string | undefined): string | undefined {
  const name = path
    ?.replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .at(-1);
  return name && name.length <= 60 ? name : undefined;
}

/** A tool's own name from how agents report it: mcp__zli-browser__browser_open, zli-browser.browser_open... */
function toolName(title: string): { server?: string; tool: string } {
  const mcp = /^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/u.exec(title);
  if (mcp?.[1] && mcp[2]) return { server: mcp[1], tool: mcp[2] };
  const dotted = /^([\w-]+)[./]([\w-]+)$/u.exec(title);
  if (dotted?.[1] && dotted[2]) return { server: dotted[1], tool: dotted[2] };
  return { tool: title };
}

const BROWSER: Record<string, string> = {
  browser_open: "Opening",
  browser_navigate: "Opening",
  browser_snapshot: "Reading the page",
  browser_read: "Reading the page",
  browser_click: "Clicking on the page",
  browser_type: "Typing on the page",
  browser_fill: "Filling in the form",
  browser_press: "Pressing a key",
  browser_select: "Choosing an option",
  browser_scroll: "Scrolling the page",
  browser_screenshot: "Looking at the page",
  browser_wait: "Waiting for the page",
  browser_back: "Going back",
  browser_tabs: "Checking my tabs",
};

const BUDDY: Record<string, string> = {
  remember: "Noting that down",
  list_buddies: "Checking on the team",
  list_agents: "Checking on the team",
  read_agent: "Reading a teammate's chat",
  message_agent: "Messaging a teammate",
  assign_task: "Handing out a job",
  hand_off: "Handing work on",
  task_status: "Checking on the jobs",
  set_routine: "Setting up a routine",
  ask_person: "Asking you",
};

/**
 * What a buddy is doing, in words the person reads: "Opening zli.taxz.dev", "Reading the page", "Running a
 * command". Never a raw command line, a file path or a tool's internal name.
 */
export function friendlyStep(step: ThreadActivityProjection): string {
  const title = step.title.trim();
  switch (step.kind) {
    case "reasoning":
      return "Thinking";
    case "web": {
      const host = hostOf(title) ?? hostOf(step.detail);
      return /^search/iu.test(title) ? "Searching the web" : host ? `Reading ${host}` : "Looking it up online";
    }
    case "search":
      return /select:|tool/iu.test(title) ? "Getting my tools ready" : "Searching";
    case "file-read": {
      const name = fileName(step.files?.[0]);
      return name ? `Reading ${name}` : "Reading a file";
    }
    case "file-edit": {
      const name = fileName(step.files?.[0]);
      return name ? `Editing ${name}` : "Editing a file";
    }
    case "command": {
      // Commands read like what they do, not like the shell line that does it.
      const line = `${step.command ?? ""} ${title}`;
      const host = hostOf(line);
      if (host) return `Reading ${host}`;
      if (/\b(Get-Content|cat|type|head|tail|less|more|Select-String|rg|grep|findstr)\b/iu.test(line))
        return "Reading files";
      if (/\b(ls|dir|Get-ChildItem|find|tree)\b/iu.test(line)) return "Looking through files";
      if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b|\bpytest\b/iu.test(line)) return "Running the tests";
      if (/\bgit\b/iu.test(line)) return "Checking git";
      return "Running a command";
    }
    case "tool": {
      const { server, tool } = toolName(title);
      const browser = BROWSER[tool];
      if (browser === "Opening") {
        const host = hostOf(step.detail) ?? hostOf(title) ?? hostOf(JSON.stringify(step));
        return host ? `Opening ${host}` : "Opening a page";
      }
      if (browser) return browser;
      if (/^COMPOSIO_SEARCH/iu.test(tool)) return "Finding the right app";
      if (/^COMPOSIO_MANAGE_CONNECTIONS/iu.test(tool)) return "Getting an app connected";
      if (/^COMPOSIO_/iu.test(tool)) return "Using your apps";
      const buddy = BUDDY[tool];
      if (buddy) return buddy;
      if (server && /composio/iu.test(server)) return "Using your apps";
      if (!tool || tool === "none") return "Working";
      return server ? `Using ${server.replace(/^zli-?/u, "") || "a tool"}` : "Using a tool";
    }
  }
  return "Working";
}

/** The steps to show, newest last, with repeats of the same words folded into one. */
export function friendlySteps(steps: readonly ThreadActivityProjection[]): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const step of steps) {
    const label = friendlyStep(step);
    if (out.at(-1)?.label === label) continue;
    out.push({ id: step.activityId, label });
  }
  return out;
}
