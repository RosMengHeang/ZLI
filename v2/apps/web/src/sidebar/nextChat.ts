type Chat = { sessionId: string; worktreeId: string; createdAt?: string | undefined };
type Worktree = { worktreeId: string; projectId: string };

/**
 * The chat to open after deleting one, in the order the project lists its chats (newest first): the one below it,
 * or the one above when it was last. `undefined` when the project has no other chat, so its empty state shows.
 */
export function chatAfterDelete<T extends Chat>(
  chats: readonly T[],
  deletedId: string,
  worktrees: readonly Worktree[],
): T | undefined {
  const deleted = chats.find((chat) => chat.sessionId === deletedId);
  const projectId = worktrees.find((worktree) => worktree.worktreeId === deleted?.worktreeId)?.projectId;
  if (!deleted || !projectId) return undefined;
  const inProject = new Set(
    worktrees.filter((worktree) => worktree.projectId === projectId).map((worktree) => worktree.worktreeId),
  );
  const listed = chats
    .filter((chat) => inProject.has(chat.worktreeId))
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  const index = listed.findIndex((chat) => chat.sessionId === deletedId);
  return listed[index + 1] ?? listed[index - 1];
}
