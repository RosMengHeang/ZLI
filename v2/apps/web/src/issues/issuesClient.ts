import {
  IssueGetResult,
  type IssueListResult,
  IssueListResult as IssueListSchema,
  type IssueSource,
  type IssueStateFilter,
  LinearStatusResult,
  ProjectId,
  type RpcResponse,
} from "@zli-v2/contracts";

import { makeCommandId } from "../runtime/commandId.js";

export type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

async function request<T>(
  dispatch: Dispatch,
  command: Record<string, unknown>,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  try {
    return schema.parse(response.result);
  } catch {
    throw new Error("The runtime sent an unexpected reply. Restart ZLI and try again.");
  }
}

export type IssueListFilter = {
  query?: string;
  state?: IssueStateFilter;
  assignee?: "me";
  labels?: readonly string[];
};

export function listIssues(
  dispatch: Dispatch,
  projectId: string,
  source: IssueSource,
  filter: IssueListFilter,
): Promise<IssueListResult> {
  const query = filter.query?.trim();
  return request(
    dispatch,
    {
      type: "issues.list",
      projectId: ProjectId.parse(projectId),
      source,
      ...(query ? { query } : {}),
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.assignee ? { assignee: filter.assignee } : {}),
      ...(filter.labels && filter.labels.length > 0 ? { labels: [...filter.labels] } : {}),
    },
    IssueListSchema,
  );
}

export function getIssue(
  dispatch: Dispatch,
  projectId: string,
  source: IssueSource,
  key: string,
): Promise<IssueGetResult> {
  return request(dispatch, { type: "issues.get", projectId: ProjectId.parse(projectId), source, key }, IssueGetResult);
}

export function linearStatus(dispatch: Dispatch): Promise<LinearStatusResult> {
  return request(dispatch, { type: "issues.linear.status" }, LinearStatusResult);
}

export function connectLinear(dispatch: Dispatch, apiKey: string): Promise<LinearStatusResult> {
  return request(dispatch, { type: "issues.linear.connect", apiKey }, LinearStatusResult);
}

export function disconnectLinear(dispatch: Dispatch): Promise<LinearStatusResult> {
  return request(dispatch, { type: "issues.linear.disconnect" }, LinearStatusResult);
}
