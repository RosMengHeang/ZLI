import {
  type BuddyColor,
  type BuddyEngine,
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
  permissionMode: PermissionMode;
  instructions: string;
  /** What the template is for, in the picker. */
  blurb: string;
};

export const BUDDY_TEMPLATES: readonly BuddyTemplate[] = [
  {
    title: "Primary",
    color: "tangerine",
    permissionMode: "supervised",
    blurb: "Plans bigger asks, hands out jobs, and answers what everyone is doing",
    instructions:
      "You lead the team. Split bigger asks into jobs one buddy can finish alone, give each to the buddy whose title fits, and keep the person posted in short updates. You don't edit files yourself.",
  },
  {
    title: "Builder",
    color: "sky",
    permissionMode: "full-access",
    blurb: "Builds features and fixes bugs",
    instructions:
      "Make the change the job asks for, in small steps. Match the code style around you. Run the project's checks before you finish, and say in your summary which ones you ran.",
  },
  {
    title: "Tester",
    color: "jade",
    permissionMode: "full-access",
    blurb: "Writes tests and checks other buddies' work",
    instructions:
      "Write tests that fail without the change and pass with it. When you check someone's work, run it, try the edge cases, and report concrete notes. Don't rewrite their code.",
  },
  {
    title: "Reviewer",
    color: "indigo",
    permissionMode: "read-only",
    blurb: "Reads changes and leaves clear notes",
    instructions:
      "Read the diff closely. Point out bugs, missing cases and unclear names, each with the file and line. Say ok when there is nothing that must change.",
  },
  {
    title: "Docs",
    color: "butter",
    permissionMode: "full-access",
    blurb: "Keeps READMEs, guides and changelogs current",
    instructions:
      "Write for someone new to the project. Short sentences, real examples, and nothing the code doesn't do.",
  },
  {
    title: "Release",
    color: "orchid",
    permissionMode: "supervised",
    blurb: "Writes release notes and gets versions ready",
    instructions:
      "Collect what changed since the last tag from git log and merged PRs, group it for users, and draft the notes. Never push tags or publish.",
  },
  {
    title: "Bug triage",
    color: "tomato",
    permissionMode: "read-only",
    blurb: "Reproduces reports and finds the cause",
    instructions:
      "Reproduce the problem first. Find the smallest cause, explain it in two sentences, and suggest the fix. Ask the person when a report is unclear.",
  },
];

export function template(title: string): BuddyTemplate | undefined {
  return BUDDY_TEMPLATES.find((entry) => entry.title === title);
}

export type NewBuddy = {
  buddyId: string;
  name: string;
  color: BuddyColor;
  title?: string;
  role: "primary" | "buddy";
  engine: BuddyEngine;
  instructions?: string;
  permissionMode: PermissionMode;
  maxActiveJobs: number;
  handoffs: BuddyProjection["handoffs"];
};

export function buddyFromTemplate(id: string, name: string, entry: BuddyTemplate): NewBuddy {
  return {
    buddyId: id,
    name,
    color: entry.color,
    title: entry.title,
    role: entry.title === "Primary" ? "primary" : "buddy",
    engine: { mode: "auto" },
    instructions: entry.instructions,
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

/* ---------- Which project a message is about ---------- */

/** Words too common to tell projects apart. */
const COMMON = new Set(
  "the and for with that this from into have make need want add fix can you please also then when what your our its are was".split(
    " ",
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !COMMON.has(word));
}

/** "taxzy_cli", "Taxzy CLI" and "taxzy-cli" all read as "taxzy cli". */
function phrase(text: string): string {
  return ` ${words(text).join(" ")} `;
}

export type ProjectGuess = { projectId: string; why: "named" | "learned" | "habit" | "focus" };

/**
 * The project a message to a buddy is about, so nobody has to pick one. In order: a project the message
 * names (by its name or folder); the project whose past jobs used the message's words, which it learns
 * as jobs pile up; the project this buddy worked in last; the one on screen; the first.
 */
export function guessProject(
  text: string,
  projects: readonly { projectId: string; name: string; path: string }[],
  tasks: readonly Pick<TaskProjection, "buddyId" | "projectId" | "goal" | "createdAt">[],
  buddyId: string,
  focusedProjectId: string | undefined,
): ProjectGuess | undefined {
  if (projects.length === 0) return undefined;
  const only = projects[0];
  if (projects.length === 1 && only) return { projectId: only.projectId, why: "named" };
  const said = phrase(text);
  const folder = (path: string) =>
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .at(-1) ?? "";
  const named = projects.filter((project) =>
    [project.name, folder(project.path)].some((label) => {
      const wanted = phrase(label);
      return wanted.trim().length > 0 && said.includes(wanted);
    }),
  );
  const [first] = named;
  if (named.length === 1 && first) return { projectId: first.projectId, why: "named" };

  // What each project's past jobs talked about: words that show up in one project's jobs and not the others'.
  const asked = new Set(words(text));
  const seen = new Map<string, Set<string>>();
  for (const task of tasks) {
    const known = seen.get(task.projectId) ?? new Set<string>();
    for (const word of words(task.goal)) known.add(word);
    seen.set(task.projectId, known);
  }
  const scores = projects.map((project) => {
    let score = 0;
    for (const word of asked) {
      if (!seen.get(project.projectId)?.has(word)) continue;
      const shared = projects.filter((other) => seen.get(other.projectId)?.has(word)).length;
      score += 1 / shared;
    }
    return { projectId: project.projectId, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  if (best && best.score >= 1 && best.score > (next?.score ?? 0) * 1.5)
    return { projectId: best.projectId, why: "learned" };

  const last = tasks
    .filter((task) => task.buddyId === buddyId && projects.some((project) => project.projectId === task.projectId))
    .reduce<(typeof tasks)[number] | undefined>(
      (latest, task) => (!latest || task.createdAt > latest.createdAt ? task : latest),
      undefined,
    );
  if (last) return { projectId: last.projectId, why: "habit" };
  if (focusedProjectId && projects.some((project) => project.projectId === focusedProjectId))
    return { projectId: focusedProjectId, why: "focus" };
  return only ? { projectId: only.projectId, why: "focus" } : undefined;
}
