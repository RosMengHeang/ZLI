export interface BrowserOpenRequestPayload {
  requestId: string;
  projectId: string;
  agentId: string | null;
  url: string;
}

export interface ActiveProjectIdentity {
  path: string;
  repositoryRoot: string;
}

export type BrowserOpenDecision =
  | { kind: "inactive"; requestId: string }
  | { kind: "open"; requestId: string; agentId: string | null; url: string };

export function resolveBrowserOpenRequest(
  request: BrowserOpenRequestPayload,
  active: ActiveProjectIdentity | null | undefined,
): BrowserOpenDecision {
  if (
    !active
    || (request.projectId !== active.path && request.projectId !== active.repositoryRoot)
  ) {
    return { kind: "inactive", requestId: request.requestId };
  }
  return {
    kind: "open",
    requestId: request.requestId,
    agentId: request.agentId,
    url: request.url,
  };
}
