import { isCommandMissing, toAppError } from "../lib/errors";
import type { CreatePtyRequest, TerminalSession } from "../types";
import { PTY_COMMANDS } from "../types/commands";
import { invokeCmd } from "./invoke";

export function ptyCreate(request: CreatePtyRequest): Promise<TerminalSession> {
  return invokeCmd<TerminalSession>(PTY_COMMANDS.create, {
    cwd: request.cwd,
    cols: request.cols,
    rows: request.rows,
    title: request.title,
    argv: request.argv,
  });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invokeCmd<void>(PTY_COMMANDS.write, { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invokeCmd<void>(PTY_COMMANDS.resize, { id, cols, rows });
}

export async function ptyClose(id: string): Promise<void> {
  try {
    await invokeCmd<void>(PTY_COMMANDS.close, { id });
  } catch (err) {
    const parsed = toAppError(err);
    if (!isCommandMissing(parsed)) throw parsed;
    await invokeCmd<void>(PTY_COMMANDS.kill, { id });
  }
}
