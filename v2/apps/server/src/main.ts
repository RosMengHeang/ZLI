import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EnvironmentId } from "@zli-v2/contracts";

import { Database } from "./db/Database.js";
import { GitProcess } from "./git/GitProcess.js";
import { Engine } from "./orchestration/Engine.js";
import { RpcServer } from "./rpc/Server.js";
import { WorktreeReactor } from "./worktrees/WorktreeReactor.js";
import { WorktreeService } from "./worktrees/WorktreeService.js";
import { TerminalReactor } from "./terminal/TerminalReactor.js";
import { TerminalService } from "./terminal/TerminalService.js";
import { ReviewReactor } from "./review/ReviewReactor.js";
import { ReviewService } from "./review/ReviewService.js";
import { DaemonSupervisor } from "./daemon/DaemonSupervisor.js";
import { RemotePtyFactory } from "./terminal/RemotePtyFactory.js";
import { CodexAppServerClient } from "@zli-v2/provider-codex";
import { CodexProviderAdapter } from "./providers/CodexProviderAdapter.js";
import { ProviderReactor } from "./providers/ProviderReactor.js";
import { ProviderRegistry, ProviderService } from "./providers/ProviderService.js";
import { DiagnosticsReactor } from "./diagnostics/DiagnosticsReactor.js";

export type RuntimeProcess = {
  database: Database;
  engine: Engine;
  server: RpcServer;
  worktreeReactor: WorktreeReactor;
  terminalService: TerminalService;
  terminalReactor: TerminalReactor;
  daemonSupervisor: DaemonSupervisor;
  providerService: ProviderService;
  providerReactor: ProviderReactor;
  reviewReactor: ReviewReactor;
  diagnosticsReactor: DiagnosticsReactor;
  token: string;
  close: () => Promise<void>;
};

export async function startRuntime(options: {
  databasePath: string;
  token?: string;
  environmentId?: string;
  label?: string;
}): Promise<RuntimeProcess> {
  const databasePath = resolve(options.databasePath);
  await mkdir(dirname(databasePath), { recursive: true });
  const token = options.token ?? randomBytes(32).toString("hex");
  const environment = {
    environmentId: EnvironmentId.parse(
      options.environmentId ?? "00000000-0000-4000-8000-000000000001",
    ),
    label: options.label ?? "ZLI local environment",
    protocolVersion: 1 as const,
    capabilities: {
      eventReplay: true,
      worktrees: true,
      terminals: true,
      browser: true,
      structuredProviders: true,
    },
  };
  const database = new Database({ path: databasePath });
  const engine = new Engine({ database, environment });
  const worktreeReactor = new WorktreeReactor(engine, new WorktreeService(new GitProcess()));
  const daemonSupervisor = new DaemonSupervisor({ endpointPath: `${databasePath}.daemon.json` });
  const terminalService = new TerminalService(new RemotePtyFactory({ connect: () => daemonSupervisor.connect() }));
  const terminalReactor = new TerminalReactor(engine, terminalService);
  const reviewReactor = new ReviewReactor(engine, new ReviewService(new GitProcess()));
  const providerService = new ProviderService(new ProviderRegistry([
    new CodexProviderAdapter({ createClient: () => CodexAppServerClient.connect() }),
  ]));
  const providerReactor = new ProviderReactor(engine, providerService);
  const diagnosticsReactor = new DiagnosticsReactor(engine);
  const server = new RpcServer({ engine, environment, token, terminalService });
  await server.start();
  await terminalReactor.restore();
  return {
    database,
    engine,
    server,
    worktreeReactor,
    terminalService,
    terminalReactor,
    daemonSupervisor,
    providerService,
    providerReactor,
    reviewReactor,
    diagnosticsReactor,
    token,
    close: async () => {
      await server.stop();
      await worktreeReactor.waitForIdle();
      await terminalReactor.waitForIdle();
      await reviewReactor.waitForIdle();
      await providerReactor.waitForIdle();
      await diagnosticsReactor.waitForIdle();
      worktreeReactor.stop();
      terminalReactor.stop();
      reviewReactor.stop();
      providerReactor.stop();
      diagnosticsReactor.stop();
      await providerService.stopAll();
      providerService.dispose();
      database.close();
    },
  };
}

async function main(): Promise<void> {
  const runtime = await startRuntime({
    databasePath: process.env.ZLI_DATABASE_PATH ?? "./.zli/runtime.sqlite",
    ...(process.env.ZLI_RUNTIME_TOKEN ? { token: process.env.ZLI_RUNTIME_TOKEN } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({ url: runtime.server.url(), token: runtime.token })}\n`,
  );
  const shutdown = () => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
