import { createServer, type Socket } from "node:net";
import { expect, it } from "vitest";
import { handshake } from "./DesktopDaemon.js";

it.each(["silent", "closed"])("rejects a %s daemon handshake without hanging startup", async (behavior) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("data", () => { if (behavior === "closed") socket.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    await expect(handshake({ host: "127.0.0.1", port: address.port, pid: process.pid,
      token: "test", protocolVersion: 1, daemonVersion: "zli-v2-daemon/1" }, 50)).resolves.toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
