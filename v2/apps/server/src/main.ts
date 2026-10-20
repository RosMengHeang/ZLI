import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EnvironmentId } from "@zli-v2/contracts";
import { DaemonSupervisor } from "./daemon/DaemonSupervisor.js";
import { Database } from "./db/Database.js";
import { DiagnosticsReactor } from "./diagnostics/DiagnosticsReactor.js";
import { StructuredLogger } from "./diagnostics/StructuredLogger.js";
import { GitProcess } from "./git/GitProcess.js";
import { LegacyImportReactor } from "./import/LegacyImportReactor.js";
import { AgentMessageReactor } from "./orchestration/AgentMessageReactor.js";
import { Engine } from "./orchestration/Engine.js";
import { ProviderReactor } from "./providers/ProviderReactor.js";
import { ProviderService } from "./providers/ProviderService.js";
import { createProviderRegistry } from "./providers/registerProviders.js";
import { ReviewReactor } from "./review/ReviewReactor.js";
import { ReviewService } from "./review/ReviewService.js";
import { RpcServer } from "./rpc/Server.js";
import { RemotePtyFactory } from "./terminal/RemotePtyFactory.js";
import { TerminalReactor } from "./terminal/TerminalReactor.js";
import { TerminalService } from "./terminal/TerminalService.js";
import { WorktreeReactor } from "./worktrees/WorktreeReactor.js";
import { WorktreeService } from "./worktrees/WorktreeService.js";

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
  agentMessageReactor: AgentMessageReactor;
  reviewReactor: ReviewReactor;
  diagnosticsReactor: DiagnosticsReactor;
  legacyImportReactor: LegacyImportReactor;
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
    environmentId: EnvironmentId.parse(options.environmentId ?? "00000000-0000-4000-8000-000000000001"),
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
  const logger = new StructuredLogger();
  const engine = new Engine({ database, environment, logger });
  const worktreeReactor = new WorktreeReactor(engine, new WorktreeService(new GitProcess()));
  const daemonSupervisor = new DaemonSupervisor({ endpointPath: `${databasePath}.daemon.json` });
  const terminalService = new TerminalService(new RemotePtyFactory({ connect: () => daemonSupervisor.connect() }));
  const reviewReactor = new ReviewReactor(engine, new ReviewService(new GitProcess()));
  const providerService = new ProviderService(createProviderRegistry());
  const terminalReactor = new TerminalReactor(engine, terminalService, {
    resolveAgentCli: async (provider) => {
      const discovery = (await providerService.discoverProviders()).find((entry) => entry.provider === provider);
      return discovery?.status === "found" ? discovery.path : undefined;
    },
  });
  const providerReactor = new ProviderReactor(engine, providerService);
  const agentMessageReactor = new AgentMessageReactor(engine);
  const diagnosticsReactor = new DiagnosticsReactor(engine, logger);
  const legacyImportReactor = new LegacyImportReactor(engine);
  const server = new RpcServer({
    engine,
    environment,
    token,
    terminalService,
    discoverProviders: () => providerService.discoverProviders(),
    attachmentsDir: join(dirname(databasePath), "attachments"),
  });
  await server.start();
  await terminalReactor.restore();
  await providerReactor.reconcileOrphanedThreads();
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
    agentMessageReactor,
    reviewReactor,
    diagnosticsReactor,
    legacyImportReactor,
    token,
    close: async () => {
      await server.stop();
      await worktreeReactor.waitForIdle();
      await terminalReactor.waitForIdle();
      await reviewReactor.waitForIdle();
      await providerReactor.waitForIdle();
      await agentMessageReactor.waitForIdle();
      await diagnosticsReactor.waitForIdle();
      await legacyImportReactor.waitForIdle();
      worktreeReactor.stop();
      terminalReactor.stop();
      reviewReactor.stop();
      providerReactor.stop();
      agentMessageReactor.stop();
      diagnosticsReactor.stop();
      legacyImportReactor.stop();
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
  process.stdout.write(`${JSON.stringify({ url: runtime.server.url(), token: runtime.token })}\n`);
  const shutdown = () => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
