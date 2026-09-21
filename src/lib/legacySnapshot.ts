export const LEGACY_SNAPSHOT_SCHEMA_VERSION = 1 as const;

const ALLOWED_KEYS = [
  "zli:workspace-registry",
  "zli:browser-permissions",
  "zli:last-project-path",
] as const;

export type LegacySnapshot = {
  format: "zli-legacy-snapshot";
  schemaVersion: typeof LEGACY_SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  workspaceRegistry: unknown;
  browserPermissions?: unknown;
  lastProjectPath?: string;
};

export function buildLegacySnapshot(storage: Pick<Storage, "getItem"> = localStorage): LegacySnapshot {
  const readJson = (key: string): unknown => {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  const workspaceRegistry = readJson(ALLOWED_KEYS[0]) ?? { workspaces: [] };
  const browserPermissions = readJson(ALLOWED_KEYS[1]);
  const lastProjectPath = storage.getItem(ALLOWED_KEYS[2]) ?? undefined;
  return {
    format: "zli-legacy-snapshot",
    schemaVersion: LEGACY_SNAPSHOT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspaceRegistry,
    ...(browserPermissions === undefined ? {} : { browserPermissions }),
    ...(lastProjectPath ? { lastProjectPath } : {}),
  };
}

export function downloadLegacySnapshot(storage: Pick<Storage, "getItem"> = localStorage): void {
  const blob = new Blob([JSON.stringify(buildLegacySnapshot(storage), null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "zli-legacy-snapshot.json";
  anchor.click();
  URL.revokeObjectURL(url);
}
