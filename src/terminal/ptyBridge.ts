import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toAppError } from "../lib/errors";
import type { PtyErrorPayload, PtyExitPayload, SessionStatus } from "../types";
import { useTerminalStore } from "../stores/terminalStore";
import {
  createPtyLifecycleFanout,
  createPtyOutputFanout,
  type PtyLifecycleListener,
  type PtyOutputListener,
} from "../lib/ptyEventFanout";
import { terminalRegistry } from "./registry";
import {
  bindPtyListeners,
  decodeTerminalBytes,
  flushTerminalDecoder,
} from "./ptyBridgeHelpers";

export {
  bindPtyListeners,
  decodeTerminalBytes,
  flushTerminalDecoder,
  type PtyListen,
} from "./ptyBridgeHelpers";

let started = false;
const unlistens: UnlistenFn[] = [];
const pendingOutput = new Map<string, string[]>();
let outputFrame = 0;
const outputFanout = createPtyOutputFanout();
const lifecycleFanout = createPtyLifecycleFanout();
const decoders = new Map<string, TextDecoder>();

export function subscribePtyOutput(listener: PtyOutputListener): () => void {
  return outputFanout.subscribe(listener);
}

export function subscribePtyLifecycle(listener: PtyLifecycleListener): () => void {
  return lifecycleFanout.subscribe(listener);
}

function flushPendingOutput(): void {
  outputFrame = 0;
  for (const [id, chunks] of pendingOutput) {
    if (chunks.length === 1) terminalRegistry.write(id, chunks[0]);
    else terminalRegistry.write(id, chunks.join(""));
  }
  pendingOutput.clear();
}

function queueOutput(id: string, data: string): void {
  const chunks = pendingOutput.get(id);
  if (chunks) chunks.push(data);
  else pendingOutput.set(id, [data]);
  if (!outputFrame) {
    outputFrame = requestAnimationFrame(flushPendingOutput);
  }
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

function payloadId(payload: unknown): string | null {
  const rec = payloadRecord(payload);
  if (!rec) return null;
  const id = rec.id ?? rec.terminalId ?? rec.sessionId;
  return typeof id === "string" ? id : null;
}

function toBytesOrString(data: unknown): string | Uint8Array | null {
  if (typeof data === "string") return data;
  if (Array.isArray(data) && data.every((n) => typeof n === "number")) {
    return Uint8Array.from(data);
  }
  return null;
}

function handleOutput(payload: unknown): void {
  const id = payloadId(payload);
  const rec = payloadRecord(payload);
  const raw = rec?.data ?? rec?.chunk ?? rec?.output;
  if (!id) return;
  const data = toBytesOrString(raw);
  if (data === null) return;
  if (typeof data === "string") {
    outputFanout.publish(id, data);
    queueOutput(id, data);
    return;
  }
  const text = decodeTerminalBytes(decoders, id, data);
  if (!text) return;
  outputFanout.publish(id, text);
  queueOutput(id, text);
}

function handleStatus(payload: unknown): void {
  const rec = payloadRecord(payload);
  const id = payloadId(payload);
  if (!id || !rec) return;
  const status = rec.status;
  if (status === "exited" || status === "killed") {
    const tail = flushTerminalDecoder(decoders, id);
    if (tail) {
      outputFanout.publish(id, tail);
      queueOutput(id, tail);
    }
    useTerminalStore.getState().markExited(id, null);
    lifecycleFanout.publish({ type: "exit", terminalId: id });
    return;
  }
  if (status === "failed") {
    const tail = flushTerminalDecoder(decoders, id);
    if (tail) {
      outputFanout.publish(id, tail);
      queueOutput(id, tail);
    }
    useTerminalStore.getState().markError(id, "PTY session failed.");
    lifecycleFanout.publish({ type: "error", terminalId: id, message: "PTY session failed." });
    return;
  }
  if (status === "running") {
    const current = useTerminalStore.getState().sessions[id];
    if (current) {
      useTerminalStore.getState().upsert({ ...current, status: "running" as SessionStatus });
    }
    lifecycleFanout.publish({ type: "status", terminalId: id });
  }
}

function handleExit(payload: unknown): void {
  const rec = payloadRecord(payload) as PtyExitPayload | null;
  const id = payloadId(payload);
  if (!id) return;
  const tail = flushTerminalDecoder(decoders, id);
  if (tail) {
    outputFanout.publish(id, tail);
    queueOutput(id, tail);
  }
  const exitCode = typeof rec?.exitCode === "number" ? rec.exitCode : null;
  useTerminalStore.getState().markExited(id, exitCode);
  lifecycleFanout.publish({ type: "exit", terminalId: id });
}

function handleError(payload: unknown): void {
  const rec = payloadRecord(payload) as PtyErrorPayload | null;
  const id = payloadId(payload);
  if (!id) return;
  const tail = flushTerminalDecoder(decoders, id);
  if (tail) {
    outputFanout.publish(id, tail);
    queueOutput(id, tail);
  }
  const message = typeof rec?.message === "string" ? rec.message : "PTY error";
  useTerminalStore.getState().markError(id, message);
  lifecycleFanout.publish({ type: "error", terminalId: id, message });
}

export async function startPtyBridge(): Promise<void> {
  if (started) return;
  try {
    const collected = await bindPtyListeners(listen, {
      onOutput: handleOutput,
      onStatus: handleStatus,
      onExit: handleExit,
      onError: handleError,
    });
    unlistens.push(...collected);
    started = true;
  } catch (err) {
    const parsed = toAppError(err);
    console.warn("PTY event bridge not available:", parsed.message);
  }
}

export async function stopPtyBridge(): Promise<void> {
  if (outputFrame) cancelAnimationFrame(outputFrame);
  outputFrame = 0;
  flushPendingOutput();
  for (const id of [...decoders.keys()]) {
    flushTerminalDecoder(decoders, id);
  }
  await Promise.all(unlistens.map((fn) => fn()));
  unlistens.length = 0;
  started = false;
}
