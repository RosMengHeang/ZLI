import { readFile } from "node:fs/promises";

import { runMcpBridge } from "./mcp/bridge/mcpBridge.js";
import { freshAccessToken } from "./mcp/signIn/tokenFile.js";

const USAGE = "Usage: zli-connect mcp --url <url> --name <name> [--token-file <path>] [--header-file <path>]";

class UsageError extends Error {}

type ConnectArgs = { url: string; name: string; tokenFile?: string; headerFile?: string };

function parseConnectArgs(argv: readonly string[]): ConnectArgs {
  const [command, ...rest] = argv;
  if (command !== "mcp") throw new UsageError(USAGE);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    const equals = arg.indexOf("=");
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    if (!["--url", "--name", "--token-file", "--header-file"].includes(flag)) {
      throw new UsageError(`Unknown option: ${arg}\n${USAGE}`);
    }
    const value = equals > 0 ? arg.slice(equals + 1) : rest[++index];
    if (value === undefined || value === "") throw new UsageError(`${flag} needs a value.\n${USAGE}`);
    values.set(flag, value);
  }
  const url = values.get("--url");
  const name = values.get("--name");
  if (!url || !name) throw new UsageError(USAGE);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new UsageError(`Not an http(s) URL: ${url}`);
  const tokenFile = values.get("--token-file");
  const headerFile = values.get("--header-file");
  return { url, name, ...(tokenFile ? { tokenFile } : {}), ...(headerFile ? { headerFile } : {}) };
}

/** Header file contents: one `Name: value` per line. */
function parseHeaderFile(contents: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: ConnectArgs;
  try {
    args = parseConnectArgs(argv);
  } catch (cause) {
    if (!(cause instanceof UsageError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return 2;
  }
  let headers: Record<string, string> = {};
  if (args.headerFile) {
    try {
      headers = parseHeaderFile(await readFile(args.headerFile, "utf8"));
    } catch (cause) {
      process.stderr.write(`Could not read the header file for ${args.name}: ${(cause as Error).message}\n`);
      return 1;
    }
  }
  const tokenFile = args.tokenFile;
  await runMcpBridge({
    url: args.url,
    name: args.name,
    headers,
    getToken: async (force) => (tokenFile ? freshAccessToken(tokenFile, { force }) : undefined),
    input: process.stdin,
    output: process.stdout,
    log: (message) => process.stderr.write(`[zli-connect ${args.name}] ${message}\n`),
  });
  return 0;
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
