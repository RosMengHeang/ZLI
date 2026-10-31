import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EnvironmentId,
  type McpServerConfig,
  PLAN_LIMIT_PROVIDERS,
  TerminalId,
  USUAL_LOGIN_ACCOUNT_ID,
} from "@zli-v2/contracts";
import { CodexAppServerClient } from "@zli-v2/provider-codex";
import { AccountStore } from "./accounts/AccountStore.js";
import {
  type BrowserToolConfig,
  browserToolConfigFromEnv,
  type McpServerContext,
  type McpServerSpec,
  zliMcpServerSpecs,
} from "./browser-tool/browserTool.js";
import { removeZliFromUserSettings, syncAccountMcpServers } from "./browser-tool/mcpSettingsFiles.js";
import { TurnCheckpoints } from "./checkpoints/TurnCheckpoints.js";
import { DaemonSupervisor } from "./daemon/DaemonSupervisor.js";
import { Database } from "./db/Database.js";
import { DevServerReactor } from "./devservers/DevServerReactor.js";
import { DiagnosticsReactor } from "./diagnostics/DiagnosticsReactor.js";
import { StructuredLogger } from "./diagnostics/StructuredLogger.js";
import { GitProcess } from "./git/GitProcess.js";
import { HuddleReactor } from "./huddles/HuddleReactor.js";
import { TerminalInputTracker } from "./huddles/TerminalInputTracker.js";
import { LegacyImportReactor } from "./import/LegacyImportReactor.js";
import { GitHubIssues } from "./issues/GitHubIssues.js";
import { GitLabIssues } from "./issues/GitLabIssues.js";
import { LinearIssues } from "./issues/LinearIssues.js";
import { type LimitTarget, mockLimitRead, PlanLimits } from "./limits/PlanLimits.js";
import { planLimitReader } from "./limits/readers.js";
import { McpServerStore } from "./mcp/McpServerStore.js";
import { GITHUB_OAUTH_CLIENT_ID } from "./mcp/signIn/github.js";
import { McpSignIns } from "./mcp/signIn/McpSignIns.js";
import { AgentMessageReactor } from "./orchestration/AgentMessageReactor.js";
import { Engine } from "./orchestration/Engine.js";
import { PluginStore } from "./plugins/PluginStore.js";
import { ProviderReactor } from "./providers/ProviderReactor.js";
import { ProviderService } from "./providers/ProviderService.js";
import { createProviderRegistry } from "./providers/registerProviders.js";
import { ReviewReactor } from "./review/ReviewReactor.js";
import { ReviewService } from "./review/ReviewService.js";
import { RpcServer } from "./rpc/Server.js";
import { SkillStore } from "./skills/SkillStore.js";
import { type SkillCopyTarget, syncSkillCopies, worktreeRootOf, worktreeSkillDirs } from "./skills/skillCopies.js";
import { RemotePtyFactory } from "./terminal/RemotePtyFactory.js";
import { TerminalReactor } from "./terminal/TerminalReactor.js";
import { TerminalService } from "./terminal/TerminalService.js";
import { WorktreeAgentFiles } from "./worktrees/WorktreeAgentFiles.js";
import { WorktreeReactor } from "./worktrees/WorktreeReactor.js";
import { WorktreeService } from "./worktrees/WorktreeService.js";
import { WorktreeSetupRunner } from "./worktrees/WorktreeSetup.js";

export type RuntimeProcess = {
  database: Database;
  engine: Engine;
  server: RpcServer;
  worktreeReactor: WorktreeReactor;
  huddleReactor: HuddleReactor;
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
  agentFiles: WorktreeAgentFiles;
  /** Settles once ZLI's entries from older versions are out of the person's own agent settings. */
  userSettingsCleanup: Promise<void>;
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
  /** The person's home directory, where agents keep their own settings. Defaults to the user's home. */
  userHome?: string;
  /**
   * False leaves the person's own agent settings untouched. Otherwise the MCP servers and skills older
   * versions copied there are removed once.
   */
  cleanUpUserSettings?: boolean;
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
  const cleanUpUserSettings = options.cleanUpUserSettings !== false;
  const log = (level: "info" | "warn", message: string, context: Record<string, unknown>) =>
    logger.record(level, message, {}, context);
  const agentFiles = new WorktreeAgentFiles({ statePath: join(dirname(databasePath), "worktree-files.json"), log });
  await agentFiles.load();
  // Leftovers from a run that did not shut down cleanly. Done before any agent starts or is restored.
  await agentFiles.removeAll().catch(() => undefined);
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
      await skills.syncCopies();
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
    // Huddles across projects pause or resume at once when this setting changes.
    onAgentScopeChange: () => huddleReactor.refresh(),
    ...(browserTool?.connectScript
      ? { connectTool: { command: browserTool.command, script: browserTool.connectScript } }
      : {}),
  });
  await mcpServers.load();
  // Every ready worktree gets the skills, so agents in chat and in terminals both find them.
  const skillTargets = async (): Promise<SkillCopyTarget[]> => {
    const projection = await engine.projection();
    const roots = [
      ...new Set(
        projection.worktrees.filter((worktree) => worktree.status === "ready").map((worktree) => worktree.path),
      ),
    ];
    const present = await Promise.all(roots.map(async (root) => ((await isDirectory(root)) ? [root] : [])));
    return present.flat().flatMap((root) =>
      worktreeSkillDirs().map(({ dir, agents }) => ({
        path: join(root, ...dir.split("/")),
        agents,
        root,
        prepare: async (names: readonly string[]) => {
          await agentFiles.hide(
            root,
            names.map((name) => `${dir}/${name}/`),
          );
          await agentFiles.makeDir(root, dir);
        },
      })),
    );
  };
  const skills = new SkillStore({
    libraryDir: join(dirname(databasePath), "skills"),
    statePath: join(dirname(databasePath), "skills.json"),
    home: userHome,
    githubToken,
    extraSkills: () => plugins.skills(),
    sync: async (list, owned) => syncSkillCopies(list, owned, await skillTargets(), { log, rootOf: worktreeRootOf }),
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
  const writeWorktreeFile = (worktreePath: string, relPath: string, contents: string | undefined) =>
    agentFiles.writeFile(worktreePath, relPath, contents);
  const providerService = new ProviderService(
    createProviderRegistry(process.env, {
      ...(browserTool ? { browserTool } : {}),
      ...mcpOptions,
      writeWorktreeFile,
    }),
  );
  // Started now so it overlaps server start and terminal restore; the first projection shares this run.
  void providerService.discoverProviders().catch(() => undefined);
  const resolveAgentCli = async (provider: string): Promise<string | undefined> => {
    const discovery = (await providerService.discoverProviders()).find((entry) => entry.provider === provider);
    return discovery?.status === "found" ? discovery.path : undefined;
  };
  const terminalReactor = new TerminalReactor(engine, terminalService, {
    resolveAgentCli,
    resolveAccount,
    writeWorktreeFile,
    ...(browserTool ? { browserTool } : {}),
    ...mcpOptions,
  });
  const checkpoints = new TurnCheckpoints(engine, new GitProcess({ maxOutputBytes: 4 * 1024 * 1024 }));
  const providerReactor = new ProviderReactor(engine, providerService, checkpoints, { resolveAccount });
  const agentMessageReactor = new AgentMessageReactor(engine);
  const diagnosticsReactor = new DiagnosticsReactor(engine, logger);
  const legacyImportReactor = new LegacyImportReactor(engine);
  const devServerReactor = new DevServerReactor(engine, terminalService);
  const terminalInput = new TerminalInputTracker();
  const huddleReactor = new HuddleReactor(engine, {
    input: terminalInput,
    writeTerminal: (terminalId, data) => terminalService.write(TerminalId.parse(terminalId), data),
    agentScope: () => mcpServers.agentScope(),
  });
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
    terminalInput,
    discoverProviders: () => providerService.discoverProviders(),
    attachmentsDir: join(dirname(databasePath), "attachments"),
    checkpoints,
    mcpServers,
    issues: { github: new GitHubIssues(), gitlab: new GitLabIssues(), linear: linearIssues },
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
  const unsubscribeWorktrees = engine.subscribe((envelope) => {
    const event = envelope.event;
    if (
      (event.type === "worktree.status.changed" && event.status === "ready") ||
      event.type === "worktree.imported" ||
      event.type === "worktree.removed" ||
      event.type === "worktree.archived"
    ) {
      void skills.syncCopies().catch(() => undefined);
    }
  });
  void skills.syncCopies().catch(() => undefined);
  // In the background: none of this is needed to serve the UI.
  const userSettingsCleanup: Promise<void> = cleanUpUserSettings
    ? Promise.all([
        mcpServers.cleanUpUserSettings((owned) => removeZliFromUserSettings(owned, { home: userHome, log })),
        skills.cleanUpUserFolders(async (owned) => (await syncSkillCopies([], owned, [], { log })).owned),
      ]).then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
  return {
    database,
    engine,
    server,
    worktreeReactor,
    huddleReactor,
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
    agentFiles,
    userSettingsCleanup,
    token,
    close: async () => {
      signIns.close();
      unsubscribeWorktrees();
      await server.stop();
      await userSettingsCleanup;
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
      await huddleReactor.waitForIdle();
      // After the terminals and chats settle, so no launch writes a file once these are gone.
      await skills.removeCopies().catch(() => undefined);
      await agentFiles.removeAll().catch(() => undefined);
      huddleReactor.stop();
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

/**
 * Reads the server's launch settings from `env` and deletes the runtime token from it. Agents, git
 * hooks, terminals, and MCP servers inherit this environment, and with the token any of them could
 * connect to the runtime and run its commands.
 */
export function takeLaunchOptions(env: NodeJS.ProcessEnv): Parameters<typeof startRuntime>[0] {
  const token = env.ZLI_RUNTIME_TOKEN;
  delete env.ZLI_RUNTIME_TOKEN;
  const browserTool = browserToolConfigFromEnv(env);
  return {
    databasePath: env.ZLI_DATABASE_PATH ?? "./.zli/runtime.sqlite",
    ...(token ? { token } : {}),
    ...(browserTool ? { browserTool } : {}),
    cleanUpUserSettings: env.ZLI_BROWSER_USER_SETTINGS !== "0",
  };
}

async function main(): Promise<void> {
  const runtime = await startRuntime(takeLaunchOptions(process.env));
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
