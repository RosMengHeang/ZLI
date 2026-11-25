import { readFile } from "node:fs/promises";

import { runMcpBridge } from "./mcp/bridge/mcpBridge.js";
import { parseStdioSpec, runStdioRelay, type StdioServerSpec } from "./mcp/bridge/stdioRelay.js";
import { parseHiddenTools } from "./mcp/bridge/toolFilter.js";
import { parseSignInGrant, reportRejectedToken, requestAccessToken } from "./mcp/signIn/SignInBroker.js";
import { freshAccessToken, markSignInExpired } from "./mcp/signIn/tokenFile.js";

const USAGE = [
  "Usage: zli-connect mcp --url <url> --name <name> [--token-env <name>] [--header-file <path>] [--header-env <name>] [--hide-tools <path>]",
  "       zli-connect stdio --name <name> --spec-file <path> [--hide-tools <path>]",
].join("\n");

class UsageError extends Error {}

type RemoteArgs = {
  mode: "mcp";
  url: string;
  name: string;
  /** Saved login read directly. Only works for logins saved before sealing; kept for settings files from then. */
  tokenFile?: string;
  /** Environment variable holding where to ask ZLI for the login's access token. */
  tokenEnv?: string;
  headerFile?: string;
  /** Environment variable holding the headers as a JSON object. */
  headerEnv?: string;
  hideTools?: string;
};
type StdioArgs = { mode: "stdio"; name: string; specFile: string; hideTools?: string };
type ConnectArgs = RemoteArgs | StdioArgs;

const FLAGS = {
  mcp: ["--url", "--name", "--token-file", "--token-env", "--header-file", "--header-env", "--hide-tools"],
  stdio: ["--name", "--spec-file", "--hide-tools"],
} as const;

function parseConnectArgs(argv: readonly string[]): ConnectArgs {
  const [command, ...rest] = argv;
  if (command !== "mcp" && command !== "stdio") throw new UsageError(USAGE);
  const allowed: readonly string[] = FLAGS[command];
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    const equals = arg.indexOf("=");
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    if (!allowed.includes(flag)) throw new UsageError(`Unknown option: ${arg}\n${USAGE}`);
    const value = equals > 0 ? arg.slice(equals + 1) : rest[++index];
    if (value === undefined || value === "") throw new UsageError(`${flag} needs a value.\n${USAGE}`);
    values.set(flag, value);
  }
  const name = values.get("--name");
  const hideTools = values.get("--hide-tools");
  const hidden = hideTools ? { hideTools } : {};
  if (command === "stdio") {
    const specFile = values.get("--spec-file");
    if (!name || !specFile) throw new UsageError(USAGE);
    return { mode: "stdio", name, specFile, ...hidden };
  }
  const url = values.get("--url");
  if (!url || !name) throw new UsageError(USAGE);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new UsageError(`Not an http(s) URL: ${url}`);
  const tokenFile = values.get("--token-file");
  const tokenEnv = values.get("--token-env");
  const headerFile = values.get("--header-file");
  const headerEnv = values.get("--header-env");
  return {
    mode: "mcp",
    url,
    name,
    ...(tokenFile ? { tokenFile } : {}),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(headerFile ? { headerFile } : {}),
    ...(headerEnv ? { headerEnv } : {}),
    ...hidden,
  };
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

class SetupError extends Error {}

/** Headers handed over in an environment variable, as a JSON object of names to values. */
function headersFromEnv(variable: string, name: string): Record<string, string> {
  const raw = process.env[variable];
  if (!raw) throw new SetupError(`The headers for ${name} were not passed in ${variable}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SetupError(`The headers for ${name} in ${variable} are not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SetupError(`The headers for ${name} in ${variable} are not valid.`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") headers[key] = value;
  return headers;
}

async function readPrivateFile<T>(path: string, what: string, name: string, parse: (text: string) => T): Promise<T> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new SetupError(`Could not read the ${what} for ${name}: ${(cause as Error).message}`);
  }
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
  const name = args.name;
  const log = (message: string) => process.stderr.write(`[zli-connect ${name}] ${message}\n`);
  try {
    // A list that cannot be read fails the start, so turned-off tools never show up by accident.
    const hiddenTools = args.hideTools
      ? await readPrivateFile(args.hideTools, "list of turned-off tools", name, parseHiddenTools)
      : [];
    if (args.mode === "stdio") {
      const spec: StdioServerSpec = await readPrivateFile(args.specFile, "server settings", name, parseStdioSpec);
      const code = await runStdioRelay({ name, spec, hiddenTools, input: process.stdin, output: process.stdout, log });
      // The server may stop first; an open stdin would keep this process alive.
      process.stdin.destroy();
      return code;
    }
    const headers = {
      ...(args.headerFile ? await readPrivateFile(args.headerFile, "header file", name, parseHeaderFile) : {}),
      ...(args.headerEnv ? headersFromEnv(args.headerEnv, name) : {}),
    };
    const tokenFile = args.tokenFile;
    const grant = args.tokenEnv ? parseSignInGrant(process.env[args.tokenEnv]) : undefined;
    if (args.tokenEnv && !grant) throw new SetupError(`The sign-in for ${name} was not passed in ${args.tokenEnv}.`);
    // The grant is only for this process: servers it starts never see it.
    if (args.tokenEnv) delete process.env[args.tokenEnv];
    await runMcpBridge({
      url: args.url,
      name,
      headers,
      hiddenTools,
      getToken: async (force) =>
        grant ? requestAccessToken(grant, force) : tokenFile ? freshAccessToken(tokenFile, { force }) : undefined,
      ...(grant
        ? { onSignInRejected: (token: string) => reportRejectedToken(grant, token) }
        : tokenFile
          ? { onSignInRejected: (token: string) => markSignInExpired(tokenFile, token) }
          : {}),
      input: process.stdin,
      output: process.stdout,
      log,
    });
    return 0;
  } catch (cause) {
    if (!(cause instanceof SetupError)) throw cause;
    process.stderr.write(`${cause.message}\n`);
    return 1;
  }
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
