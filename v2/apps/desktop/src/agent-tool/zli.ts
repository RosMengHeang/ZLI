import { createZliBrowserClient } from "../browser-tool/client.js";
import { serveMcpOverStdio } from "../browser-tool/mcp.js";
import { parseZliArgs, runZli, ZliUsageError } from "./cli.js";
import { createAgentMcpServer } from "./mcp.js";

async function main(argv: readonly string[]): Promise<number> {
  let command: ReturnType<typeof parseZliArgs>;
  try {
    command = parseZliArgs(argv);
  } catch (cause) {
    if (!(cause instanceof ZliUsageError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return 2;
  }
  const call = createZliBrowserClient({
    notRunningMessage: "ZLI is not running, so other agents cannot be reached.",
    serviceName: "ZLI",
  });
  if (command.kind === "mcp") {
    await serveMcpOverStdio(createAgentMcpServer(call), process.stdin, process.stdout);
    return 0;
  }
  return runZli(command, call, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
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
