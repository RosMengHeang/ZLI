import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EnvironmentId } from "@zli-v2/contracts";
import { type BrowserToolConfig, browserToolConfigFromEnv } from "./browser-tool/browserTool.js";
import {
  registerBrowserToolInUserSettings,
  syncUserMcpServers,
  type UserSettingsOutcome,
} from "./browser-tool/userSettings.js";
import { DaemonSupervisor } from "./daemon/DaemonSupervisor.js";
import { Database } from "./db/Database.js";
import { DevServerReactor } from "./devservers/DevServerReactor.js";
import { DiagnosticsReactor } from "./diagnostics/DiagnosticsReactor.js";
import { StructuredLogger } from "./diagnostics/StructuredLogger.js";
import { GitProcess } from "./git/GitProcess.js";
import { LegacyImportReactor } from "./import/LegacyImportReactor.js";
import { McpServerStore } from "./mcp/McpServerStore.js";
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
import { WorktreeSetupRunner } from "./worktrees/WorktreeSetup.js";

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
  devServerReactor: DevServerReactor;
  mcpServers: McpServerStore;
  /** Settles once the browser tool is registered in agent user settings (empty when not configured). */
  browserToolRegistration: Promise<readonly UserSettingsOutcome[]>;
  token: string;
  close: () => Promise<void>;
};

export async function startRuntime(options: {
  databasePath: string;
  token?: string;
  environmentId?: string;
  label?: string;
  /** Lets agents drive ZLI's browser. Absent in tests and CLI runs, which then inject nothing. */
  browserTool?: BrowserToolConfig;
  /** Home directory whose agent settings receive the browser tool and MCP servers. Defaults to the user's home. */
  userHome?: string;
  /** False keeps ZLI's MCP servers out of agent user settings; per-launch wiring still applies. */
  registerInUserSettings?: boolean;
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
  const daemonSupervisor = new DaemonSupervisor({ endpointPath: `${databasePath}.daemon.json` });
  const terminalService = new TerminalService(new RemotePtyFactory({ connect: () => daemonSupervisor.connect() }));
  const worktreeSetup = new WorktreeSetupRunner(engine, terminalService);
  const worktreeReactor = new WorktreeReactor(engine, new WorktreeService(new GitProcess()), {
    setup: (context) => worktreeSetup.run(context),
  });
  const reviewReactor = new ReviewReactor(engine, new ReviewService(new GitProcess()));
  const browserTool = options.browserTool;
  const userHome = options.userHome ?? homedir();
  const writeUserSettings = options.registerInUserSettings !== false;
  const mcpConfigDir = browserTool?.mcpConfigDir ?? join(dirname(databasePath), "mcp");
  const mcpServers = new McpServerStore({
    path: join(dirname(databasePath), "mcp-servers.json"),
    ...(writeUserSettings
      ? {
          syncUserSettings: (specs, owned) =>
            syncUserMcpServers(specs, owned, {
              home: userHome,
              isInstalled: async (provider): Promise<boolean> => (await resolveAgentCli(provider)) !== undefined,
              log: (level, message, context) => logger.record(level, message, {}, context),
            }),
        }
      : {}),
  });
  await mcpServers.load();
  const mcpOptions = { mcpServers: () => mcpServers.specs(), mcpConfigDir };
  const providerService = new ProviderService(
    createProviderRegistry(process.env, { ...(browserTool ? { browserTool } : {}), ...mcpOptions }),
  );
  // Started now so it overlaps server start and terminal restore; the first projection and the
  // browser tool registration below share this run.
  void providerService.discoverProviders().catch(() => undefined);
  const resolveAgentCli = async (provider: string): Promise<string | undefined> => {
    const discovery = (await providerService.discoverProviders()).find((entry) => entry.provider === provider);
    return discovery?.status === "found" ? discovery.path : undefined;
  };
  const terminalReactor = new TerminalReactor(engine, terminalService, {
    resolveAgentCli,
    ...(browserTool ? { browserTool } : {}),
    ...mcpOptions,
  });
  const providerReactor = new ProviderReactor(engine, providerService);
  const agentMessageReactor = new AgentMessageReactor(engine);
  const diagnosticsReactor = new DiagnosticsReactor(engine, logger);
  const legacyImportReactor = new LegacyImportReactor(engine);
  const devServerReactor = new DevServerReactor(engine, terminalService);
  const server = new RpcServer({
    engine,
    environment,
    token,
    terminalService,
    discoverProviders: () => providerService.discoverProviders(),
    attachmentsDir: join(dirname(databasePath), "attachments"),
    mcpServers,
  });
  // Before the server accepts commands, so a setup started by a new request is never mistaken for a stale one.
  await worktreeSetup.reconcile();
  await server.start();
  await terminalReactor.restore();
  await providerReactor.reconcileOrphanedThreads();
  // Runs in the background: discovery can take seconds and agent settings are not needed to serve the UI.
  const browserToolRegistration: Promise<readonly UserSettingsOutcome[]> =
    browserTool && writeUserSettings
      ? registerBrowserToolInUserSettings(browserTool, {
          home: userHome,
          isInstalled: async (provider) => (await resolveAgentCli(provider)) !== undefined,
          log: (level, message, context) => logger.record(level, message, {}, context),
        }).catch(() => [])
      : Promise.resolve([]);
  // After the browser registration, which writes the same files. Picks up agents installed since the last save.
  void browserToolRegistration.then(() => mcpServers.syncUserSettings()).catch(() => undefined);
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
    devServerReactor,
    mcpServers,
    browserToolRegistration,
    token,
    close: async () => {
      await server.stop();
      await browserToolRegistration;
      await mcpServers.waitForIdle();
      await worktreeReactor.waitForIdle();
      await terminalReactor.waitForIdle();
      await reviewReactor.waitForIdle();
      await providerReactor.waitForIdle();
      await agentMessageReactor.waitForIdle();
      await diagnosticsReactor.waitForIdle();
      await legacyImportReactor.waitForIdle();
      worktreeReactor.stop();
      worktreeSetup.stop();
      terminalReactor.stop();
      reviewReactor.stop();
      providerReactor.stop();
      agentMessageReactor.stop();
      diagnosticsReactor.stop();
      legacyImportReactor.stop();
      devServerReactor.stop();
      await devServerReactor.waitForIdle();
      await providerService.stopAll();
      providerService.dispose();
      await engine.flushProjection();
      database.close();
    },
  };
}

async function main(): Promise<void> {
  const browserTool = browserToolConfigFromEnv(process.env);
  const runtime = await startRuntime({
    databasePath: process.env.ZLI_DATABASE_PATH ?? "./.zli/runtime.sqlite",
    ...(process.env.ZLI_RUNTIME_TOKEN ? { token: process.env.ZLI_RUNTIME_TOKEN } : {}),
    ...(browserTool ? { browserTool } : {}),
    registerInUserSettings: process.env.ZLI_BROWSER_USER_SETTINGS !== "0",
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
