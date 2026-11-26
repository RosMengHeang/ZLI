import {
  type BuddyColor,
  type BuddyEngine,
  BuddyLook,
  BuddyName,
  type BuddyProjection,
  type PermissionMode,
  type RoutineProjection,
  RoutineTrigger,
  type TaskProjection,
} from "@zli-v2/contracts";
import { z } from "zod";

/** What a buddy is for, with instructions that make it good at it. */
export type BuddyTemplate = {
  title: string;
  color: BuddyColor;
  look: BuddyLook;
  permissionMode: PermissionMode;
  instructions: string;
  /** Its voice, so it sounds the same on any model. */
  personality: string;
  sampleReply: string;
  /** What the template is for, in the picker. */
  blurb: string;
  /** Its chip on the new buddy form, naming what the buddy focuses on. The Primary has none. */
  focus?: string;
};

export const BUDDY_TEMPLATES: readonly BuddyTemplate[] = [
  {
    title: "Primary",
    color: "tangerine",
    look: "bot",
    permissionMode: "supervised",
    blurb: "Plans bigger asks, hands out jobs, and answers what everyone is doing",
    instructions:
      "You lead the team. Split bigger asks into jobs one buddy can finish alone, give each to the buddy whose title fits, and keep the person posted in short updates. You don't edit files yourself.",
    personality: "calm",
    sampleReply: "Split it in two: Builder takes the form, Tester checks it after. I'll tell you when both land.",
  },
  {
    title: "Builder",
    focus: "Building",
    color: "sky",
    look: "blob",
    permissionMode: "supervised",
    blurb: "Builds features and fixes bugs",
    instructions:
      "Make the change the job asks for, in small steps. Match the code style around you. Run the project's checks before you finish, and say in your summary which ones you ran.",
    personality: "cheerful",
    sampleReply: "Done, and the checks pass! The fix was one line in the cart total.",
  },
  {
    title: "Tester",
    focus: "Testing",
    color: "jade",
    look: "critter",
    permissionMode: "supervised",
    blurb: "Writes tests and checks other buddies' work",
    instructions:
      "Write tests that fail without the change and pass with it. When you check someone's work, run it, try the edge cases, and report concrete notes. Don't rewrite their code.",
    personality: "blunt",
    sampleReply: "Fails on an empty cart. Two tests added, one still red.",
  },
  {
    title: "Reviewer",
    focus: "Reviews",
    color: "indigo",
    look: "ghost",
    permissionMode: "read-only",
    blurb: "Reads changes and leaves clear notes",
    instructions:
      "Read the diff closely. Point out bugs, missing cases and unclear names, each with the file and line. Say ok when there is nothing that must change.",
    personality: "dry",
    sampleReply: "Looks fine, apart from the variable named data2. We can do better.",
  },
  {
    title: "Docs",
    focus: "Docs",
    color: "butter",
    look: "sprout",
    permissionMode: "supervised",
    blurb: "Keeps READMEs, guides and changelogs current",
    instructions:
      "Write for someone new to the project. Short sentences, real examples, and nothing the code doesn't do.",
    personality: "warm",
    sampleReply: "I rewrote the setup page so a first-timer can follow it. Have a look when you have a minute.",
  },
  {
    title: "Release",
    focus: "Releases",
    color: "orchid",
    look: "jelly",
    permissionMode: "supervised",
    blurb: "Writes release notes and gets versions ready",
    instructions:
      "Collect what changed since the last tag from git log and merged PRs, group it for users, and draft the notes. Never push tags or publish.",
    personality: "calm",
    sampleReply: "Notes for 2.3 are drafted. Nothing is tagged; that stays your call.",
  },
  {
    title: "Bug triage",
    focus: "Bug triage",
    color: "tomato",
    look: "bot",
    permissionMode: "read-only",
    blurb: "Reproduces reports and finds the cause",
    instructions:
      "Reproduce the problem first. Find the smallest cause, explain it in two sentences, and suggest the fix. Ask the person when a report is unclear.",
    personality: "blunt",
    sampleReply: "Reproduced it. The cache key ignores the locale, so French users get English prices.",
  },
];

/**
 * Shown wherever a buddy is set to full access. Buddies read web pages, issues, and files other people wrote, and
 * text in them can steer the agent. With full access, nothing stops for the person first.
 */
export const FULL_ACCESS_WARNING =
  "With full access, a web page, issue, or file this buddy reads can make it run commands on your computer without asking you. Pick it only when you trust everything the buddy will read.";

/** The optional focus chips on the new buddy form. Picking one fills in its instructions; none means it takes any job. */
export const FOCUS_PRESETS: readonly (BuddyTemplate & { focus: string })[] = BUDDY_TEMPLATES.filter(
  (entry): entry is BuddyTemplate & { focus: string } => entry.focus !== undefined,
);

/** A new buddy's first words: what should it focus on. Answers show under it in the chat. */
export function focusQuestion(name: string): string {
  return `Hi, I'm ${name}. What do you want me to work on? Pick one below, or tell me in your own words.`;
}

/** What the buddy says once a focus answer is picked: what it will do, and where to change it. */
export function focusSaved(entry: BuddyTemplate | undefined): string {
  return entry
    ? `Got it: ${entry.blurb.charAt(0).toLowerCase()}${entry.blurb.slice(1)}. You can change this any time under Here for.`
    : "Got it. I'll take any job. Tell me if you want me to focus on something.";
}

export function template(title: string): BuddyTemplate | undefined {
  return BUDDY_TEMPLATES.find((entry) => entry.title === title);
}

export type NewBuddy = {
  buddyId: string;
  name: string;
  color: BuddyColor;
  look?: BuddyLook;
  title?: string;
  role: "primary" | "buddy";
  engine: BuddyEngine;
  instructions?: string;
  personality?: string;
  sampleReply?: string;
  permissionMode: PermissionMode;
  maxActiveJobs: number;
  handoffs: BuddyProjection["handoffs"];
};

export function buddyFromTemplate(id: string, name: string, entry: BuddyTemplate): NewBuddy {
  return {
    buddyId: id,
    name,
    color: entry.color,
    look: entry.look,
    title: entry.title,
    role: entry.title === "Primary" ? "primary" : "buddy",
    engine: { mode: "auto" },
    instructions: entry.instructions,
    personality: entry.personality,
    sampleReply: entry.sampleReply,
    permissionMode: entry.permissionMode,
    maxActiveJobs: 2,
    handoffs: [],
  };
}

/** The starter team: a Primary that plans, a Builder, and a Tester that checks the Builder's work. */
export function starterTeam(newId: () => string): {
  buddies: NewBuddy[];
  handoff: { from: string; to: string; ruleId: string };
} {
  const primary = buddyFromTemplate(newId(), "Primary", template("Primary") as BuddyTemplate);
  const builder = buddyFromTemplate(newId(), "Builder", template("Builder") as BuddyTemplate);
  const tester = buddyFromTemplate(newId(), "Tester", template("Tester") as BuddyTemplate);
  return {
    buddies: [primary, builder, tester],
    handoff: { from: builder.buddyId, to: tester.buddyId, ruleId: newId() },
  };
}

export type BuddyStats = {
  done: number;
  failed: number;
  open: number;
  /** Share of finished jobs that ended ready without failing, 0–1, or undefined before any. */
  successRate: number | undefined;
  revisions: number;
  costUsd: number;
  /** Jobs by model, best first. */
  models: { model: string; jobs: number; ok: number }[];
};

export function buddyStats(buddyId: string, tasks: readonly TaskProjection[]): BuddyStats {
  const own = tasks.filter((task) => task.buddyId === buddyId);
  let done = 0;
  let failed = 0;
  let open = 0;
  let revisions = 0;
  let costUsd = 0;
  const models = new Map<string, { jobs: number; ok: number }>();
  for (const task of own) {
    revisions += task.revisions.length;
    costUsd += task.result?.costUsd ?? 0;
    const ok = task.status === "ready" || task.status === "shipped" || (task.status === "closed" && !task.undone);
    const bad = task.status === "failed" || task.undone === true;
    if (ok) done += 1;
    else if (bad) failed += 1;
    else if (task.status !== "cancelled" && task.status !== "stopped") open += 1;
    if (task.pick && (ok || bad)) {
      const key = task.pick.model ?? task.pick.provider;
      const entry = models.get(key) ?? { jobs: 0, ok: 0 };
      entry.jobs += 1;
      if (ok) entry.ok += 1;
      models.set(key, entry);
    }
  }
  return {
    done,
    failed,
    open,
    successRate: done + failed > 0 ? done / (done + failed) : undefined,
    revisions,
    costUsd,
    models: [...models.entries()]
      .map(([model, entry]) => ({ model, ...entry }))
      .sort((left, right) => right.ok / right.jobs - left.ok / left.jobs || right.jobs - left.jobs),
  };
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function money(usd: number): string {
  return usd < 0.01 ? "under 1¢" : `$${usd.toFixed(2)}`;
}

/** Schedules people pick from, as cron, with how they read. */
export const SCHEDULES: readonly { cron: string; label: string }[] = [
  { cron: "0 9 * * 1-5", label: "Weekdays at 9:00" },
  { cron: "0 18 * * 1-5", label: "Weekdays at 18:00" },
  { cron: "0 9 * * *", label: "Every day at 9:00" },
  { cron: "0 16 * * 5", label: "Fridays at 16:00" },
  { cron: "0 * * * *", label: "Every hour" },
];

export function triggerLabel(trigger: RoutineProjection["trigger"]): string {
  switch (trigger.kind) {
    case "schedule":
      return SCHEDULES.find((entry) => entry.cron === trigger.cron)?.label ?? `On schedule ${trigger.cron}`;
    case "ci_failed":
      return `When CI fails on ${trigger.branch}`;
    case "review_requested":
      return "When someone asks you for a review";
    case "issue_labeled":
      return `When an issue gets the ${trigger.label} label`;
  }
}

/** A buddy as a file people can share. Never chat history, tokens or project paths. */
export const BuddyFile = z.object({
  zli: z.literal("buddy"),
  version: z.literal(1),
  buddy: z.object({
    name: BuddyName,
    color: z.string(),
    look: BuddyLook.optional(),
    title: z.string().max(40).optional(),
    instructions: z.string().max(4_000).optional(),
    engine: z.unknown(),
    permissionMode: z.enum(["read-only", "supervised", "full-access"]),
    maxActiveJobs: z.number().int().min(1).max(4),
    memory: z.array(z.string().min(1).max(400)).max(40),
  }),
  routines: z.array(z.object({ goal: z.string().min(1).max(4_000), trigger: RoutineTrigger })).max(20),
});
export type BuddyFile = z.infer<typeof BuddyFile>;

export function exportBuddy(buddy: BuddyProjection, routines: readonly RoutineProjection[]): BuddyFile {
  return {
    zli: "buddy",
    version: 1,
    buddy: {
      name: buddy.name,
      color: buddy.color,
      ...(buddy.look ? { look: buddy.look } : {}),
      ...(buddy.title ? { title: buddy.title } : {}),
      ...(buddy.instructions ? { instructions: buddy.instructions } : {}),
      engine: buddy.engine,
      permissionMode: buddy.permissionMode,
      maxActiveJobs: buddy.maxActiveJobs,
      memory: buddy.memory.filter((note) => !note.projectId).map((note) => note.text),
    },
    routines: routines
      .filter((routine) => routine.buddyId === buddy.buddyId && !routine.builtin)
      .map((routine) => ({ goal: routine.goal, trigger: routine.trigger })),
  };
}

export function parseBuddyFile(text: string): BuddyFile | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "That file is not a ZLI buddy.";
  }
  const parsed = BuddyFile.safeParse(raw);
  return parsed.success ? parsed.data : "That file is not a ZLI buddy, or it is from a newer ZLI.";
}

/** A free name: the one asked for, or it with a number. */
export function freeName(wanted: string, buddies: readonly Pick<BuddyProjection, "name" | "archived">[]): string {
  const taken = new Set(buddies.filter((buddy) => !buddy.archived).map((buddy) => buddy.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${wanted.slice(0, 20)} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return wanted;
}

/**
 * The team order with one buddy moved a place up (-1) or down (1). The primary buddy stays first and
 * cannot be moved, so nothing moves above it. Undefined when the move is not possible.
 */
export function moveBuddy(
  team: readonly Pick<BuddyProjection, "buddyId" | "role">[],
  buddyId: string,
  by: -1 | 1,
): string[] | undefined {
  const ids = team.map((buddy) => buddy.buddyId);
  const from = ids.indexOf(buddyId);
  const to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return undefined;
  if (team[from]?.role === "primary" || team[to]?.role === "primary") return undefined;
  ids.splice(from, 1);
  ids.splice(to, 0, buddyId);
  return ids;
}
