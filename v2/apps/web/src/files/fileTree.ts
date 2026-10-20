import type { FileChangeStatus, FileListEntry } from "@zli-v2/contracts";

export type FileTreeDirectory = {
  kind: "directory";
  name: string;
  path: string;
  directories: FileTreeDirectory[];
  files: FileTreeFile[];
  /** Number of changed files anywhere below this folder. */
  changed: number;
};
export type FileTreeFile = { kind: "file"; name: string; path: string; status?: FileChangeStatus | undefined };

export type FileTreeRow =
  | { kind: "directory"; name: string; path: string; depth: number; expanded: boolean; changed: number }
  | { kind: "file"; name: string; path: string; depth: number; status?: FileChangeStatus | undefined };

export function buildFileTree(entries: readonly FileListEntry[]): FileTreeDirectory {
  const root: FileTreeDirectory = { kind: "directory", name: "", path: "", directories: [], files: [], changed: 0 };
  const directories = new Map<string, FileTreeDirectory>([["", root]]);
  const directoryFor = (path: string): FileTreeDirectory => {
    const existing = directories.get(path);
    if (existing) return existing;
    const split = path.lastIndexOf("/");
    const parent = directoryFor(split === -1 ? "" : path.slice(0, split));
    const created: FileTreeDirectory = {
      kind: "directory",
      name: split === -1 ? path : path.slice(split + 1),
      path,
      directories: [],
      files: [],
      changed: 0,
    };
    parent.directories.push(created);
    directories.set(path, created);
    return created;
  };
  for (const entry of entries) {
    const split = entry.path.lastIndexOf("/");
    const parentPath = split === -1 ? "" : entry.path.slice(0, split);
    const parent = directoryFor(parentPath);
    parent.files.push({ kind: "file", name: entry.path.slice(split + 1), path: entry.path, status: entry.status });
    if (entry.status) {
      for (let path: string | undefined = parentPath; path !== undefined; ) {
        const directory = directories.get(path);
        if (directory) directory.changed += 1;
        if (path === "") break;
        const next = path.lastIndexOf("/");
        path = next === -1 ? "" : path.slice(0, next);
      }
    }
  }
  const sort = (directory: FileTreeDirectory) => {
    directory.directories.sort((left, right) => compareNames(left.name, right.name));
    directory.files.sort((left, right) => compareNames(left.name, right.name));
    for (const child of directory.directories) sort(child);
  };
  sort(root);
  return root;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
}

/** Flattens the expanded part of the tree into rows; collapsed folders hide their contents. */
export function visibleTreeRows(root: FileTreeDirectory, expanded: ReadonlySet<string>): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const walk = (directory: FileTreeDirectory, depth: number) => {
    for (const child of directory.directories) {
      const open = expanded.has(child.path);
      rows.push({
        kind: "directory",
        name: child.name,
        path: child.path,
        depth,
        expanded: open,
        changed: child.changed,
      });
      if (open) walk(child, depth + 1);
    }
    for (const file of directory.files) {
      rows.push({ kind: "file", name: file.name, path: file.path, depth, status: file.status });
    }
  };
  walk(root, 0);
  return rows;
}

/** Every folder that contains `path`, so revealing a file can expand its parents. */
export function ancestorDirectories(path: string): string[] {
  const parts = path.split("/");
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) result.push(parts.slice(0, index).join("/"));
  return result;
}
