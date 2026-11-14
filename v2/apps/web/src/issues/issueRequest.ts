import type { IssueDetail } from "@zli-v2/contracts";

const EVENT = "zli:pick-issue";

export type IssueRequest = {
  /** The project whose issues to list first. */
  projectId: string | undefined;
  /** Gets the issue the person picked. Not called when they cancel. */
  onPick(issue: IssueDetail): void;
};

/**
 * Asks the app shell to open the issue picker for a chat that wants an issue attached, such as the message
 * box's paperclip. The shell owns the picker, so this saves passing a callback through every layer.
 */
export function requestIssue(request: IssueRequest): void {
  window.dispatchEvent(new CustomEvent<IssueRequest>(EVENT, { detail: request }));
}

/** The shell's side: calls `open` for every request until the returned function is called. */
export function onIssueRequest(open: (request: IssueRequest) => void): () => void {
  const listener = (event: Event) => {
    const request = (event as CustomEvent<IssueRequest>).detail;
    if (request) open(request);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
