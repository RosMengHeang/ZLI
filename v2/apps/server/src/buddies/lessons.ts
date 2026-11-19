import { type BuddyProjection, firstSentence, type TaskProjection } from "@zli-v2/contracts";

export type Lesson = { text: string; taskId?: string | undefined; projectId?: string | undefined };

const MAX_PER_LOOKBACK = 3;

function known(buddy: BuddyProjection, text: string): boolean {
  const wanted = text.trim().toLowerCase();
  return [...buddy.memory, ...buddy.pendingMemory].some((note) => note.text.trim().toLowerCase() === wanted);
}

/** A change the person asked for on a finished job is the clearest lesson there is. */
export function lessonFromRevision(task: TaskProjection, note: string): Lesson {
  return {
    text: `When doing ${firstSentence(task.goal, 60).toLowerCase()}: ${firstSentence(note, 200)}`.slice(0, 400),
    taskId: task.taskId,
    projectId: task.projectId,
  };
}

/** The person's answer to a question a job asked: next time the buddy knows it without asking. */
export function lessonFromAnswer(task: TaskProjection, question: string, answer: string): Lesson {
  return {
    text: `Asked "${firstSentence(question, 140)}", the person said: ${firstSentence(answer, 200)}`.slice(0, 400),
    taskId: task.taskId,
    projectId: task.projectId,
  };
}

/**
 * The daily look-back: reads the buddy's jobs since `since` and proposes up to three lessons, from the
 * changes people asked for, review notes, and kinds of jobs that keep failing.
 */
export function lookback(buddy: BuddyProjection, tasks: readonly TaskProjection[], since: string): Lesson[] {
  const recent = tasks.filter((task) => task.buddyId === buddy.buddyId && task.updatedAt > since);
  const lessons: Lesson[] = [];
  const add = (lesson: Lesson) => {
    if (lessons.length >= MAX_PER_LOOKBACK || known(buddy, lesson.text)) return;
    if (lessons.some((existing) => existing.text === lesson.text)) return;
    lessons.push(lesson);
  };
  for (const task of recent)
    for (const review of task.reviews)
      for (const note of review.notes)
        add({
          text: `Reviewers asked for: ${firstSentence(note, 200)}`,
          taskId: task.taskId,
          projectId: task.projectId,
        });
  for (const task of recent) for (const revision of task.revisions) add(lessonFromRevision(task, revision.note));
  const failedKinds = new Map<string, number>();
  for (const task of recent)
    if (task.status === "failed" && task.profile)
      failedKinds.set(task.profile.kind, (failedKinds.get(task.profile.kind) ?? 0) + 1);
  for (const [kind, count] of failedKinds)
    if (count >= 2) add({ text: `${kind} jobs got stuck ${count} times: ask the person early when unsure.` });
  return lessons;
}
