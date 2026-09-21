import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import { ProjectId, type ProjectProjection, type RuntimeCommand, type RuntimeProjection } from "@zli-v2/contracts";

export type DomainErrorCode = "project_exists" | "unsupported_command";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type ProjectRegisteredDecision = {
  type: "project.registered";
  project: ProjectProjection;
};

export type DomainDecision = ProjectRegisteredDecision;

export function decide(
  projection: RuntimeProjection,
  command: RuntimeCommand,
): DomainDecision[] {
  if (command.type !== "project.register") {
    throw new DomainError("unsupported_command", `Command ${command.type} is not a domain mutation.`);
  }

  const path = canonicalPath(command.path);
  if (projection.projects.some((project) => canonicalPath(project.path) === path)) {
    throw new DomainError("project_exists", `Project is already registered: ${command.path}`);
  }

  const projectId = ProjectId.parse(stableProjectId(path));
  return [
    {
      type: "project.registered",
      project: {
        projectId,
        path: command.path,
        name: projectName(command.path),
      },
    },
  ];
}

export function canonicalPath(path: string): string {
  const normalized = path.replaceAll("/", "\\");
  return win32.normalize(normalized).replace(/[\\/]$/, "").toLowerCase();
}

function projectName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const name = posix.basename(normalized);
  return name || normalized;
}

function stableProjectId(path: string): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = createHash("sha256").update(path).digest("hex").slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = ((Number.parseInt(bytes[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
