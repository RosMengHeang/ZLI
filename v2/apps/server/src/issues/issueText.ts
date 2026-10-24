/** A failure the person can act on; the message is shown as is. */
export class IssueError extends Error {
  override readonly name = "IssueError";
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
