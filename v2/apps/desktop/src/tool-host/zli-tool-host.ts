import { rename, writeFile } from "node:fs/promises";

import { startToolHost } from "./toolHost.js";

/**
 * Runs the shared tool host for the runtime that started it:
 *   zli-tool-host --endpoint-file <path> --parent-pid <pid>
 * The endpoint file gets {pid, port, token} once the host listens. The host exits when its parent does.
 */
async function main(argv: readonly string[]): Promise<number> {
  const endpointFile = flag(argv, "--endpoint-file");
  const parentPid = Number(flag(argv, "--parent-pid"));
  const controlFile = process.env.ZLI_BROWSER_CONTROL_FILE;
  if (!endpointFile || !controlFile || !Number.isSafeInteger(parentPid) || parentPid <= 0) {
    process.stderr.write(
      "Usage: zli-tool-host --endpoint-file <path> --parent-pid <pid> (with ZLI_BROWSER_CONTROL_FILE set)\n",
    );
    return 2;
  }
  const host = await startToolHost({ controlFile });
  const temp = `${endpointFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ pid: process.pid, port: host.port, token: host.token }), { mode: 0o600 });
  await rename(temp, endpointFile);
  // The runtime owns the agents that call this host; once it is gone nobody else can.
  const watch = setInterval(() => {
    if (!alive(parentPid)) void host.close().finally(() => process.exit(0));
  }, 2_000);
  watch.unref();
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
    process.once("disconnect", resolve);
    // Keeps the process alive while the server listens.
    setInterval(() => undefined, 1 << 30);
  });
  await host.close();
  return 0;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
