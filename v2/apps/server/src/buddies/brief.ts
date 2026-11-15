import type { BuddyProjection, HandoffAction, ProjectProjection, TaskProjection } from "@zli-v2/contracts";

/** The first message a buddy's job chat gets: who it is, the job, and how to report back. */
export function jobBrief(options: {
  buddy: BuddyProjection;
  task: TaskProjection;
  project: ProjectProjection;
  branch: string;
  parent?: TaskProjection | undefined;
  primary?: boolean;
}): string {
  const { buddy, task, project, branch } = options;
  const notes = buddy.memory.filter((note) => !note.projectId || note.projectId === project.projectId);
  const lines = [
    `You are ${buddy.name}, a buddy in ZLI${buddy.title ? `. Title: ${buddy.title}` : ""}.`,
    task.kind === "review" ? `Review job: ${task.goal}` : `Job: ${task.goal}`,
    `Project: ${project.name} · branch ${branch}${task.baseRef ? ` (from ${task.baseRef})` : ""} · your own worktree.`,
  ];
  if (task.skill) lines.push(`Use the ${task.skill} skill for this.`);
  if (buddy.instructions?.trim()) lines.push("", "Your instructions:", buddy.instructions.trim());
  if (notes.length > 0)
    lines.push("", "What you know (lessons from earlier jobs):", ...notes.map((note) => `- ${note.text}`));
  if (options.parent?.result)
    lines.push(
      "",
      `This follows ${options.parent.goal.slice(0, 200)}. What was done: ${options.parent.result.summary}`,
    );
  lines.push("");
  if (task.kind === "review")
    lines.push(
      "Read the changes; do not edit files. When you have checked them, call review_verdict with verdict ok, or notes and a short list of what to fix.",
    );
  else
    lines.push(
      "If you change UI, open it with the browser tools and pass the screenshot paths to task_done.",
      "When you're done, call task_done with a 2–3 sentence summary of what you changed and how you checked it.",
      "If you need a decision, call ask_person with options. Don't guess on product choices.",
      "If part of the work suits another buddy better (tests, docs, a review), call hand_off.",
      "If you learn something about this project worth keeping, call remember with one short sentence.",
    );
  if (options.primary)
    lines.push(
      "",
      "You are the Primary buddy: you plan and hand out work. Use list_buddies to see the team, assign_task to give a buddy a job, task_status to check progress, and set_routine for recurring work. Do not edit files yourself.",
    );
  return lines.join("\n");
}

export function nudgeText(): string {
  return "Are you finished? If so, call task_done with a short summary. If you need something from the person, call ask_person.";
}

export function reviseText(note: string): string {
  return `Change request from the person: ${note}\nMake the change, then call task_done again with an updated summary.`;
}

export function answerText(question: string, answer: string): string {
  return `The person answered your question "${question.slice(0, 200)}": ${answer}`;
}

export function reviewNotesText(reviewer: string, notes: readonly string[]): string {
  return `${reviewer} checked your work and has notes:\n${notes.map((note) => `- ${note}`).join("\n")}\nFix them, then call task_done again.`;
}

export function stepUpText(previous: TaskProjection): string {
  return `An earlier attempt at this job got stuck${previous.pick ? ` on ${previous.pick.model ?? previous.pick.provider}` : ""}. Check what is already on the branch, then carry on.\n\nJob: ${previous.goal}`;
}

const ACTION_GOAL: Record<HandoffAction, (task: TaskProjection, from: string) => string> = {
  check: (task, from) => `Check ${from}'s work: ${task.goal}`,
  fix: (task, from) => `Fix what ${from}'s review found: ${task.goal}`,
  tests: (task, from) => `Write or update tests for ${from}'s change: ${task.goal}`,
  docs: (task, from) => `Update the docs for ${from}'s change: ${task.goal}`,
};

export function handoffGoal(action: HandoffAction, task: TaskProjection, from: string): string {
  return ACTION_GOAL[action](task, from).slice(0, 4_000);
}
