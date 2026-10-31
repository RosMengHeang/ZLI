import { createZliBrowserClient } from "../browser-tool/client.js";
import { serveMcpOverStdio } from "../browser-tool/mcp.js";
import { MobileCliUsageError, parseMobileArgs, runMobileCli } from "./cli.js";
import { createMobileMcpServer } from "./mcp.js";

async function main(argv: readonly string[]): Promise<number> {
  let command: ReturnType<typeof parseMobileArgs>;
  try {
    command = parseMobileArgs(argv);
  } catch (cause) {
    if (!(cause instanceof MobileCliUsageError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return 2;
  }
  const call = createZliBrowserClient({
    notRunningMessage: "ZLI is not running, so its Mobile panel is unavailable.",
    serviceName: "ZLI's mobile service",
  });
  if (command.kind === "mcp") {
    await serveMcpOverStdio(createMobileMcpServer(call), process.stdin, process.stdout);
    return 0;
  }
  return runMobileCli(command, call, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: () => process.cwd(),
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
