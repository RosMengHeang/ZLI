import {
  FileListResult,
  FileReadResult,
  FileSearchResult,
  FileWriteResult,
  type RpcResponse,
  WorktreeId,
} from "@zli-v2/contracts";

import { makeCommandId } from "../runtime/commandId.js";

export type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

export class FileRequestError extends Error {}

async function request<T>(
  dispatch: Dispatch,
  command: Record<string, unknown>,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new FileRequestError("The runtime is not connected.");
  if (!response.accepted) throw new FileRequestError(response.error.message);
  try {
    return schema.parse(response.result);
  } catch {
    throw new FileRequestError("The runtime sent an unexpected reply. Restart ZLI and try again.");
  }
}

export function listFiles(dispatch: Dispatch, worktreeId: string): Promise<FileListResult> {
  return request(dispatch, { type: "files.list", worktreeId: WorktreeId.parse(worktreeId) }, FileListResult);
}

export function readFile(dispatch: Dispatch, worktreeId: string, path: string): Promise<FileReadResult> {
  return request(dispatch, { type: "files.read", worktreeId: WorktreeId.parse(worktreeId), path }, FileReadResult);
}

export function writeFile(
  dispatch: Dispatch,
  worktreeId: string,
  input: { path: string; content: string; expectedVersion: string; bom?: boolean; overwrite?: boolean },
): Promise<FileWriteResult> {
  return request(
    dispatch,
    {
      type: "files.write",
      worktreeId: WorktreeId.parse(worktreeId),
      path: input.path,
      content: input.content,
      expectedVersion: input.expectedVersion,
      ...(input.bom ? { bom: true } : {}),
      ...(input.overwrite ? { overwrite: true } : {}),
    },
    FileWriteResult,
  );
}

export function searchFiles(
  dispatch: Dispatch,
  worktreeId: string,
  input: { query: string; caseSensitive?: boolean; regex?: boolean; maxResults?: number },
): Promise<FileSearchResult> {
  return request(
    dispatch,
    {
      type: "files.search",
      worktreeId: WorktreeId.parse(worktreeId),
      query: input.query,
      ...(input.caseSensitive ? { caseSensitive: true } : {}),
      ...(input.regex ? { regex: true } : {}),
      ...(input.maxResults ? { maxResults: input.maxResults } : {}),
    },
    FileSearchResult,
  );
}
