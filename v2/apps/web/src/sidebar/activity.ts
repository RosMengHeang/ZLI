/** A chat as the activity list sees it: when it last moved, and whether it is busy now. */
export type ActivityChat = {
  sessionId: string;
  status: string;
  updatedAt?: string | undefined;
  createdAt?: string | undefined;
};

export type ActivityGroup<T> = { key: string; label: string; chats: T[] };

/** What a chat is doing now puts it in Recent, whenever it last changed. */
const BUSY = new Set(["working", "starting", "waiting", "preparing"]);
/** A chat that moved in the last hour is Recent too. */
const RECENT_MS = 60 * 60_000;

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/**
 * Every chat from newest to oldest, in groups by when it last moved: pinned ones first, then Recent (busy now or
 * in the last hour), Today, Yesterday, Previous 7 days, and Earlier. Empty groups are left out.
 */
export function activityGroups<T extends ActivityChat>(
  chats: readonly T[],
  now: Date,
  pinned: (sessionId: string) => boolean,
): ActivityGroup<T>[] {
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60_000;
  const week = today - 7 * 24 * 60 * 60_000;
  const groups: ActivityGroup<T>[] = [
    { key: "pinned", label: "Pinned", chats: [] },
    { key: "recent", label: "Recent", chats: [] },
    { key: "today", label: "Today", chats: [] },
    { key: "yesterday", label: "Yesterday", chats: [] },
    { key: "week", label: "Previous 7 days", chats: [] },
    { key: "earlier", label: "Earlier", chats: [] },
  ];
  const at = (chat: T) => Date.parse(chat.updatedAt ?? chat.createdAt ?? "") || 0;
  const sorted = [...chats].sort((left, right) => at(right) - at(left));
  for (const chat of sorted) {
    const time = at(chat);
    const index = pinned(chat.sessionId)
      ? 0
      : BUSY.has(chat.status) || now.getTime() - time < RECENT_MS
        ? 1
        : time >= today
          ? 2
          : time >= yesterday
            ? 3
            : time >= week
              ? 4
              : 5;
    groups[index]?.chats.push(chat);
  }
  return groups.filter((group) => group.chats.length > 0);
}
