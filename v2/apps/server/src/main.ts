import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EnvironmentId, type McpServerConfig, PLAN_LIMIT_PROVIDERS, USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";
import { CodexAppServerClient } from "@zli-v2/provider-codex";
import { AccountStore } from "./accounts/AccountStore.js";
import {
  type BrowserToolConfig,
  browserToolConfigFromEnv,
  type McpServerContext,
  type McpServerSpec,
  zliMcpServerSpecs,
} from "./browser-tool/browserTool.js";
import {
  registerBrowserToolInUserSettings,
  syncAccountMcpServers,
  syncUserMcpServers,
  type UserSettingsOutcome,
} from "./browser-tool/userSettings.js";
import { TurnCheckpoints } from "./checkpoints/TurnCheckpoints.js";
import { DaemonSupervisor } from "./daemon/DaemonSupervisor.js";
import { Database } from "./db/Database.js";
import { DevServerReactor } from "./devservers/DevServerReactor.js";
import { DiagnosticsReactor } from "./diagnostics/DiagnosticsReactor.js";
import { StructuredLogger } from "./diagnostics/StructuredLogger.js";
import { GitProcess } from "./git/GitProcess.js";
import { LegacyImportReactor } from "./import/LegacyImportReactor.js";
import { GitHubIssues } from "./issues/GitHubIssues.js";
import { LinearIssues } from "./issues/LinearIssues.js";
import { type LimitTarget, mockLimitRead, PlanLimits } from "./limits/PlanLimits.js";
import { planLimitReader } from "./limits/readers.js";
import { McpServerStore } from "./mcp/McpServerStore.js";
import { GITHUB_OAUTH_CLIENT_ID } from "./mcp/signIn/github.js";
import { McpSignIns } from "./mcp/signIn/McpSignIns.js";
import { PluginStore } from "./plugins/PluginStore.js";
import { AgentMessageReactor } from "./orchestration/AgentMessageReactor.js";
import { Engine } from "./orchestration/Engine.js";
import { ProviderReactor } from "./providers/ProviderReactor.js";
import { ProviderService } from "./providers/ProviderService.js";
import { createProviderRegistry } from "./providers/registerProviders.js";
import { ReviewReactor } from "./review/ReviewReactor.js";
import { ReviewService } from "./review/ReviewService.js";
import { RpcServer } from "./rpc/Server.js";
import { SkillStore } from "./skills/SkillStore.js";
import { syncUserSkills } from "./skills/userSkillSync.js";
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
  skills: SkillStore;
  plugins: PluginStore;
  accounts: AccountStore;
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
  const githubToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined;
  // Loaded first: the MCP and skill stores read plugin parts as they load. The callbacks below run later.
  const plugins: PluginStore = new PluginStore({
    pluginsDir: join(dirname(databasePath), "plugins"),
    dataDir: join(dirname(databasePath), "plugin-data"),
    statePath: join(dirname(databasePath), "plugins.json"),
    githubToken,
    userServerNames: (): string[] => mcpServers.list().servers.map((server) => server.name),
    userSkillNames: (): Promise<string[]> => skills.libraryNames(),
    skillConflicts: (name): string[] => skills.conflictPaths(name),
    onChange: async (): Promise<void> => {
      await mcpServers.refresh();
      await skills.syncUserSettings();
    },
    exportSources: {
      skills: async (): Promise<Array<{ name: string; path: string }>> =>
        (await skills.libraryNames()).map((name) => ({ name, path: join(skills.libraryPath(), name) })),
      servers: (): McpServerConfig[] => mcpServers.list().servers,
    },
  });
  await plugins.load();
  const signIns = new McpSignIns({
    dir: join(dirname(databasePath), "mcp-sign-in"),
    githubClientId: process.env.ZLI_GITHUB_CLIENT_ID?.trim() || GITHUB_OAUTH_CLIENT_ID,
  });
  await signIns.load();
  const mcpServers: McpServerStore = new McpServerStore({
    path: join(dirname(databasePath), "mcp-servers.json"),
    extraServers: (taken): McpServerConfig[] => plugins.mcpServers(taken),
    signIns,
    importFrom: { home: userHome },
    ...(browserTool?.connectScript
      ? { connectTool: { command: browserTool.command, script: browserTool.connectScript } }
      : {}),
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
  const skills = new SkillStore({
    libraryDir: join(dirname(databasePath), "skills"),
    statePath: join(dirname(databasePath), "skills.json"),
    home: userHome,
    githubToken,
    extraSkills: () => plugins.skills(),
    ...(writeUserSettings
      ? {
          sync: (list, owned) =>
            syncUserSkills(list, owned, {
              home: userHome,
              isInstalled: async (provider): Promise<boolean> => (await resolveAgentCli(provider)) !== undefined,
              log: (level, message, context) => logger.record(level, message, {}, context),
            }),
        }
      : {}),
  });
  await skills.load();
  const accounts = new AccountStore({
    path: join(dirname(databasePath), "accounts.json"),
    dir: join(dirname(databasePath), "accounts"),
    // A private config dir hides the user's own MCP settings, so agents that read servers only from there get ZLI's.
    syncMcp: (provider, configDir, owned) =>
      syncAccountMcpServers(
        provider,
        configDir,
        [...(browserTool ? zliMcpServerSpecs(browserTool) : []), ...mcpServers.specs()],
        owned,
      ),
  });
  await accounts.load();
  const resolveAccount = (provider: Parameters<AccountStore["resolve"]>[0], accountId?: string) =>
    accounts.resolve(provider, accountId);
  // Servers limited to some projects are matched against the root of the worktree's project.
  const projectPathFor = async (worktreeId: string | undefined): Promise<string | undefined> => {
    if (!worktreeId) return undefined;
    const projection = await engine.projection();
    const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
    return worktree ? projection.projects.find((project) => project.projectId === worktree.projectId)?.path : undefined;
  };
  const mcpOptions = {
    mcpServers: async ({ worktreeId }: McpServerContext): Promise<McpServerSpec[]> => {
      const projectPath = await projectPathFor(worktreeId).catch(() => undefined);
      return mcpServers.specs(projectPath ? { projectPath } : {});
    },
    mcpConfigDir,
  };
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
    resolveAccount,
    ...(browserTool ? { browserTool } : {}),
    ...mcpOptions,
  });
  const checkpoints = new TurnCheckpoints(engine, new GitProcess({ maxOutputBytes: 4 * 1024 * 1024 }));
  const providerReactor = new ProviderReactor(engine, providerService, checkpoints, { resolveAccount });
  const agentMessageReactor = new AgentMessageReactor(engine);
  const diagnosticsReactor = new DiagnosticsReactor(engine, logger);
  const legacyImportReactor = new LegacyImportReactor(engine);
  const devServerReactor = new DevServerReactor(engine, terminalService);
  const linearIssues = new LinearIssues({ keyPath: join(dirname(databasePath), "linear-key.json") });
  const mockLimits = process.env.ZLI_TEST_PROVIDER === "mock";
  const readLimits = planLimitReader({
    home: userHome,
    resolveCli: resolveAgentCli,
    connectCodex: (command, codexHome) =>
      CodexAppServerClient.connect({ command, ...(codexHome ? { env: { CODEX_HOME: codexHome } } : {}) }),
  });
  const planLimits = new PlanLimits({
    // The usual login shows only when its CLI is installed; the harness has no real CLIs, so it shows all.
    targets: async (): Promise<LimitTarget[]> => {
      const usual = await Promise.all(
        PLAN_LIMIT_PROVIDERS.map(async (provider) =>
          mockLimits || (await resolveAgentCli(provider)) ? [{ provider, accountId: USUAL_LOGIN_ACCOUNT_ID }] : [],
        ),
      );
      return [...usual.flat(), ...accounts.limitTargets()];
    },
    read: (target) => (mockLimits ? Promise.resolve(mockLimitRead(target)) : readLimits(target)),
  });
  const server = new RpcServer({
    engine,
    environment,
    token,
    terminalService,
    discoverProviders: () => providerService.discoverProviders(),
    attachmentsDir: join(dirname(databasePath), "attachments"),
    checkpoints,
    mcpServers,
    issues: { github: new GitHubIssues(), linear: linearIssues },
    skills,
    plugins,
    accounts,
    limits: planLimits,
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
  // After discovery, so skills reach agents installed since the last save.
  void providerService
    .discoverProviders()
    .then(() => skills.syncUserSettings())
    .catch(() => undefined);
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
    skills,
    plugins,
    accounts,
    browserToolRegistration,
    token,
    close: async () => {
      signIns.close();
      await server.stop();
      await browserToolRegistration;
      await mcpServers.waitForIdle();
      await linearIssues.waitForIdle();
      await plugins.waitForIdle();
      await skills.waitForIdle();
      await accounts.waitForIdle();
      await worktreeReactor.waitForIdle();
      await terminalReactor.waitForIdle();
      await reviewReactor.waitForIdle();
      await providerReactor.waitForIdle();
      await checkpoints.waitForIdle();
      await agentMessageReactor.waitForIdle();
      await diagnosticsReactor.waitForIdle();
      await legacyImportReactor.waitForIdle();
      worktreeReactor.stop();
      worktreeSetup.stop();
      terminalReactor.stop();
      reviewReactor.stop();
      providerReactor.stop();
      checkpoints.stop();
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
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // The desktop app ends this pipe to stop the server, because Windows has no SIGTERM to send. The pipe
  // also ends when the app crashes, so agents are stopped instead of left running.
  if (process.env.ZLI_RUNTIME_STOP_ON_STDIN_END === "1") {
    process.stdin.once("end", shutdown);
    process.stdin.resume();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
