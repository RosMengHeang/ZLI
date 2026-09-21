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
import { NodePtyFactory } from "./terminal/NodePtyFactory.js";
import { TerminalReactor } from "./terminal/TerminalReactor.js";
import { TerminalService } from "./terminal/TerminalService.js";
import { ReviewReactor } from "./review/ReviewReactor.js";
import { ReviewService } from "./review/ReviewService.js";

export type RuntimeProcess = {
  database: Database;
  engine: Engine;
  server: RpcServer;
  worktreeReactor: WorktreeReactor;
  terminalService: TerminalService;
  terminalReactor: TerminalReactor;
  reviewReactor: ReviewReactor;
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
  const terminalService = new TerminalService(new NodePtyFactory());
  const terminalReactor = new TerminalReactor(engine, terminalService);
  const reviewReactor = new ReviewReactor(engine, new ReviewService(new GitProcess()));
  const server = new RpcServer({ engine, environment, token, terminalService });
  await server.start();
  return {
    database,
    engine,
    server,
    worktreeReactor,
    terminalService,
    terminalReactor,
    reviewReactor,
    token,
    close: async () => {
      await server.stop();
      await worktreeReactor.waitForIdle();
      await terminalReactor.waitForIdle();
      await reviewReactor.waitForIdle();
      worktreeReactor.stop();
      terminalReactor.stop();
      reviewReactor.stop();
      terminalService.stopAll();
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
