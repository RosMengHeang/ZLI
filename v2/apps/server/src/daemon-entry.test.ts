import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { accept } from "./daemon-entry.js";
import { TerminalService } from "./terminal/TerminalService.js";

it("isolates a reset runtime socket without crashing the terminal daemon", () => {
  const socket = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    destroy: vi.fn(),
  });
  const service = new TerminalService({
    spawn: async () => {
      throw new Error("unused");
    },
  });
  accept(socket as unknown as Socket, service);
  expect(() => socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).not.toThrow();
  expect(socket.destroy).toHaveBeenCalledOnce();
});
