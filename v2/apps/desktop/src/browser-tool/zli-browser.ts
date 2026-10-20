import { createZliBrowserClient } from "./client.js";
import { CliUsageError, parseCliArgs, runCli } from "./cli.js";
import { createMcpServer, serveMcpOverStdio } from "./mcp.js";

async function main(argv: readonly string[]): Promise<number> {
  let command: ReturnType<typeof parseCliArgs>;
  try {
    command = parseCliArgs(argv);
  } catch (cause) {
    if (!(cause instanceof CliUsageError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return 2;
  }
  const call = createZliBrowserClient();
  if (command.kind === "mcp") {
    await serveMcpOverStdio(createMcpServer(call), process.stdin, process.stdout);
    return 0;
  }
  return runCli(command, call, {
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
