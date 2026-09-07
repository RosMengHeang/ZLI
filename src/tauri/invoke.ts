import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "../lib/errors";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw {
      code: "not_tauri",
      message: `Cannot call '${cmd}' outside the Tauri runtime.`,
    };
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toAppError(err);
  }
}
