import {
  type BuddyMessage,
  type BuddyProjection,
  buddiesInOrder,
  firstSentence,
  isOpenTask,
  type ProjectGuess,
  type ProjectProjection,
  type RuntimeProjection,
} from "@zli-v2/contracts";

/** A job the buddy started from the chat, read from its reply. */
export type ChatJob = { buddy?: string; project?: string; goal: string };

/** A message the buddy sends to a teammate's chat, read from its reply. */
export type ChatTell = { buddy: string; text: string };

/** What a buddy's reply asks ZLI to do, and the words the person sees. */
export type ChatReply = { text: string; jobs: ChatJob[]; remember: string[]; tells: ChatTell[] };

const JOB = /\[\[job([^\]]*)\]\]([\s\S]*?)\[\[\/job\]\]/gu;
const REMEMBER = /\[\[remember\]\]([\s\S]*?)\[\[\/remember\]\]/gu;
const TELL = /\[\[tell([^\]]*)\]\]([\s\S]*?)\[\[\/tell\]\]/gu;
const ATTRIBUTE = /(\w+)\s*=\s*"([^"]*)"/gu;
/** The brief shows the markers with <placeholders>; a reply that repeats one starts nothing. */
const PLACEHOLDER = /^<[^<>]*>$/u;

/** Reads the markers out of a buddy's reply. What is left is what the person reads. */
export function parseChatReply(raw: string): ChatReply {
  const jobs: ChatJob[] = [];
  const remember: string[] = [];
  const tells: ChatTell[] = [];
  let text = raw.replace(JOB, (_all, attributes: string, goal: string) => {
    const job: ChatJob = { goal: goal.trim() };
    for (const [, key, value] of attributes.matchAll(ATTRIBUTE)) {
      if (key === "buddy" && value?.trim()) job.buddy = value.trim();
      if (key === "project" && value?.trim()) job.project = value.trim();
    }
    if (job.goal && !PLACEHOLDER.test(job.goal)) jobs.push(job);
    return "";
  });
  text = text.replace(REMEMBER, (_all, note: string) => {
    if (note.trim() && !PLACEHOLDER.test(note.trim())) remember.push(note.trim().slice(0, 400));
    return "";
  });
  text = text.replace(TELL, (_all, attributes: string, said: string) => {
    let buddy = "";
    for (const [, key, value] of attributes.matchAll(ATTRIBUTE))
      if (key === "buddy" && value?.trim()) buddy = value.trim();
    if (buddy && said.trim() && !PLACEHOLDER.test(said.trim()) && !PLACEHOLDER.test(buddy))
      tells.push({ buddy, text: said.trim().slice(0, 4_000) });
    return "";
  });
  return { text: text.replace(/\n{3,}/gu, "\n\n").trim(), jobs, remember, tells };
}

/** Who sent a message in a buddy's chat: the person, or the teammate who sent it. */
export function senderName(state: RuntimeProjection, message: BuddyMessage): string {
  if (!message.from) return "Person";
  return state.buddies?.find((entry) => entry.buddyId === message.from)?.name ?? "A teammate";
}

/** The project a job names, by name or folder; with one project, that one. */
export function projectNamed(projects: readonly ProjectProjection[], name: string | undefined) {
  if (projects.length === 1) return projects[0];
  if (!name) return undefined;
  const wanted = name.trim().toLowerCase();
  const folder = (path: string) =>
    (
      path
        .replace(/[\\/]+$/u, "")
        .split(/[\\/]/u)
        .at(-1) ?? ""
    ).toLowerCase();
  return projects.find(
    (project) => project.projectId === name || project.name.toLowerCase() === wanted || folder(project.path) === wanted,
  );
}

/**
 * What a buddy knows before each message in its chat: who it is, the person's projects and team, what is
 * running, and how to start work. A fresh chat also gets the conversation so far.
 */
export function chatBrief(options: {
  buddy: BuddyProjection;
  state: RuntimeProjection;
  guess: ProjectGuess | undefined;
  history?: readonly BuddyMessage[];
}): string {
  const { buddy, state, guess } = options;
  const team = buddiesInOrder(state).filter((entry) => entry.buddyId !== buddy.buddyId);
  const open = (state.tasks ?? []).filter((task) => isOpenTask(task));
  const project = (projectId: string) => state.projects.find((entry) => entry.projectId === projectId)?.name;
  const guessed = guess ? project(guess.projectId) : undefined;
  const lines = [
    `You are ${buddy.name}${buddy.title && buddy.title !== buddy.name ? `, the ${buddy.title}` : ""}${buddy.role === "primary" ? ", the Primary buddy who plans and hands out work" : ""}, on the person's team in ZLI.`,
    `Your name is ${buddy.name}. The person can rename you; if earlier messages used another name, go by this one.`,
    "This is your chat with the person. Talk like a capable assistant and teammate: short, plain, friendly. Answer questions, help them think, look at code when it helps. You can read files here but not change them.",
    "",
    "Real work (building, fixing, testing, writing docs, reviewing code) happens in a job, which runs in its own worktree and chat. Start one only when the person asks for work to be done, not for greetings, questions or chat.",
    "To start a job, put this in your reply, on its own lines:",
    '[[job buddy="<name>" project="<project name>"]]',
    "<the job, clear enough to work from alone>",
    "[[/job]]",
    "Leave buddy out to do it yourself, or name a teammate who suits it better. Tell the person in one line what you started.",
    "If you are not sure which project they mean, ask them, listing the project names, and start the job after they answer.",
    "If they tell you something worth keeping about them or how they like to work, put [[remember]]<one short sentence>[[/remember]] in your reply.",
    'To message a teammate, put [[tell buddy="<name>"]]<your message>[[/tell]] in your reply. ZLI delivers it to their chat and brings their answer back here. Do not wait for it.',
    "You cannot ask the person questions with a tool, approve plans, or wait on anything: say what you need in your reply, and the person answers in the chat.",
    "",
    `Projects: ${state.projects.map((entry) => entry.name).join(", ") || "none yet"}.`,
  ];
  if (guessed)
    lines.push(
      guess?.why === "named" || guess?.why === "learned"
        ? `This message most likely means ${guessed}.`
        : `If a job comes up and they did not say where, ${guessed} is only a guess (${guess?.why === "habit" ? "where you worked last" : "the project on their screen"}): ask first.`,
    );
  if (team.length > 0)
    lines.push(`Team: ${team.map((entry) => `${entry.name}${entry.title ? ` (${entry.title})` : ""}`).join(", ")}.`);
  if (open.length > 0)
    lines.push(
      "Open jobs:",
      ...open
        .slice(-8)
        .map(
          (task) =>
            `- ${state.buddies?.find((entry) => entry.buddyId === task.buddyId)?.name ?? "A buddy"}: ${firstSentence(task.goal, 100)} (${task.status.replace("_", " ")}, ${project(task.projectId) ?? "a project"})`,
        ),
    );
  if (buddy.instructions?.trim()) lines.push("", "Your standing instructions:", buddy.instructions.trim());
  if (buddy.memory.length > 0) lines.push("", "What you know:", ...buddy.memory.map((note) => `- ${note.text}`));
  if (options.history && options.history.length > 0)
    lines.push(
      "",
      "Your conversation so far:",
      ...options.history.map(
        (message) =>
          `${message.role === "you" ? senderName(state, message) : "You"}:${message.text.replace(/\s+/gu, " ").slice(0, 400)}`,
      ),
    );
  return lines.join("\n");
}
