import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_EDITABLE_FILE_BYTES, MAX_PREVIEW_FILE_BYTES } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { GitProcess } from "../git/GitProcess.js";
import { FileService, FileServiceError } from "./FileService.js";

const directories: string[] = [];

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zli-files-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  const git = new GitProcess();
  await git.run(["init", "-q"], { cwd: root });
  await git.run(["config", "user.email", "zli-files@example.invalid"], { cwd: root });
  await git.run(["config", "user.name", "ZLI Files"], { cwd: root });
  await git.run(["config", "core.autocrlf", "false"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "dist/\n*.log\n");
  await writeFile(join(root, "README.md"), "# Demo\nHello World\n");
  await writeFile(join(root, "src", "app.ts"), "export const greeting = 'hello';\nconsole.log(greeting);\n");
  await git.run(["add", "."], { cwd: root });
  await git.run(["commit", "-q", "-m", "base"], { cwd: root });
  return root;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("FileService.list", () => {
  it("lists tracked and untracked files with their Git state, skipping ignored ones", async () => {
    const root = await repository();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "bundle.js"), "x");
    await writeFile(join(root, "debug.log"), "x");
    await writeFile(join(root, "src", "new file.ts"), "x");
    await writeFile(join(root, "src", "ünïcode.ts"), "x");
    await writeFile(join(root, "src", "app.ts"), "changed\n");
    await writeFile(join(root, "staged.ts"), "x");
    await new GitProcess().run(["add", "staged.ts"], { cwd: root });
    await rm(join(root, "README.md"));

    const result = await new FileService().list(root);

    expect(result).toEqual({
      files: [
        { path: ".gitignore" },
        { path: "README.md", status: "deleted" },
        { path: "src/app.ts", status: "modified" },
        { path: "src/new file.ts", status: "untracked" },
        { path: "src/ünïcode.ts", status: "untracked" },
        { path: "staged.ts", status: "added" },
      ],
      truncated: false,
    });
  });

  it("maps status paths onto a folder inside the repository", async () => {
    const root = await repository();
    await writeFile(join(root, "src", "app.ts"), "changed\n");
    await writeFile(join(root, "README.md"), "changed\n");

    const result = await new FileService().list(join(root, "src"));

    expect(result.files).toEqual([{ path: "app.ts", status: "modified" }]);
  });
});

describe("FileService.read", () => {
  it("reads UTF-8 text with a stable version", async () => {
    const root = await repository();
    const service = new FileService();
    const first = await service.read(root, "src/app.ts");
    expect(first).toMatchObject({
      path: "src/app.ts",
      content: "export const greeting = 'hello';\nconsole.log(greeting);\n",
      binary: false,
      tooLarge: false,
      bom: false,
      lineEnding: "lf",
    });
    expect(first.version).toMatch(/^[0-9a-f]{64}$/u);
    expect((await service.read(root, "src/app.ts")).version).toBe(first.version);
  });

  it("strips a BOM and detects CRLF while keeping the content intact", async () => {
    const root = await repository();
    await writeFile(join(root, "win.txt"), Buffer.from("\uFEFFone\r\ntwo\r\n", "utf8"));
    expect(await new FileService().read(root, "win.txt")).toMatchObject({
      content: "one\r\ntwo\r\n",
      bom: true,
      lineEnding: "crlf",
      size: 13,
    });
  });

  it("marks binary and invalid UTF-8 files without content", async () => {
    const root = await repository();
    await writeFile(join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await writeFile(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const service = new FileService();
    for (const path of ["image.bin", "latin1.txt"]) {
      const result = await service.read(root, path);
      expect(result).toMatchObject({ binary: true, tooLarge: false });
      expect(result.content).toBeUndefined();
    }
  });

  it("does not load files over the editable limit", async () => {
    const root = await repository();
    await writeFile(join(root, "big.txt"), "a".repeat(MAX_EDITABLE_FILE_BYTES + 1));
    const result = await new FileService().read(root, "big.txt");
    expect(result).toMatchObject({ tooLarge: true, binary: false, size: MAX_EDITABLE_FILE_BYTES + 1 });
    expect(result.content).toBeUndefined();
  });

  it("rejects paths outside the worktree, folders, and missing files", async () => {
    const root = await repository();
    const service = new FileService();
    for (const path of ["../outside.txt", "src/../../x", "/etc/passwd", "C:/Windows/win.ini", "src\\app.ts"]) {
      await expect(service.read(root, path)).rejects.toThrow("That file is outside the worktree.");
    }
    await expect(service.read(root, ".git/config")).rejects.toThrow(FileServiceError);
    await expect(service.read(root, "src")).rejects.toThrow("That path is a folder: src");
    await expect(service.read(root, "src/missing.ts")).rejects.toThrow("File not found: src/missing.ts");
  });

  it("refuses symlinks that point outside the worktree", async () => {
    const root = await repository();
    const outside = join(root, "..", "secret.txt");
    await writeFile(outside, "secret");
    try {
      await symlink(outside, join(root, "link.txt"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const service = new FileService();
    await expect(service.read(root, "link.txt")).rejects.toThrow("That file is outside the worktree.");
    await expect(
      service.write(root, { path: "link.txt", content: "x", expectedVersion: "new", overwrite: true }),
    ).rejects.toThrow("That file is outside the worktree.");
    expect(await readFile(outside, "utf8")).toBe("secret");
  });
});

describe("FileService.readData", () => {
  it("returns the bytes of images and PDFs with their type", async () => {
    const root = await repository();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await writeFile(join(root, "src", "logo.PNG"), png);
    const result = await new FileService().readData(root, "src/logo.PNG");
    expect(result).toMatchObject({ path: "src/logo.PNG", size: png.length, mimeType: "image/png" });
    expect(Buffer.from(result.dataBase64, "base64").equals(png)).toBe(true);
  });

  it("refuses other file types, oversized files, and paths outside the worktree", async () => {
    const root = await repository();
    const service = new FileService();
    await expect(service.readData(root, "src/app.ts")).rejects.toThrow("ZLI previews images and PDFs only");
    await writeFile(join(root, "huge.pdf"), Buffer.alloc(MAX_PREVIEW_FILE_BYTES + 1));
    await expect(service.readData(root, "huge.pdf")).rejects.toThrow("too large to preview");
    await expect(service.readData(root, "../outside.png")).rejects.toThrow("That file is outside the worktree.");
  });
});

describe("FileService.write", () => {
  it("saves with the read version and returns the new version", async () => {
    const root = await repository();
    const service = new FileService();
    const read = await service.read(root, "README.md");
    const saved = await service.write(root, {
      path: "README.md",
      content: "# Changed\n",
      expectedVersion: read.version,
    });
    expect(saved).toMatchObject({ status: "saved", path: "README.md", size: 10 });
    if (saved.status !== "saved") throw new Error("expected saved");
    expect(saved.version).not.toBe(read.version);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# Changed\n");
    expect((await service.read(root, "README.md")).version).toBe(saved.version);
  });

  it("restores the BOM when asked", async () => {
    const root = await repository();
    await writeFile(join(root, "bom.txt"), Buffer.from("\uFEFFold", "utf8"));
    const service = new FileService();
    const read = await service.read(root, "bom.txt");
    await service.write(root, { path: "bom.txt", content: "new", expectedVersion: read.version, bom: read.bom });
    expect(await readFile(join(root, "bom.txt"))).toEqual(Buffer.from("\uFEFFnew", "utf8"));
  });

  it("reports a conflict when the file changed on disk, unless overwriting", async () => {
    const root = await repository();
    const service = new FileService();
    const read = await service.read(root, "README.md");
    await writeFile(join(root, "README.md"), "changed elsewhere\n");
    const current = await service.read(root, "README.md");

    const conflict = await service.write(root, { path: "README.md", content: "mine", expectedVersion: read.version });
    expect(conflict).toEqual({ status: "conflict", path: "README.md", version: current.version });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("changed elsewhere\n");

    const forced = await service.write(root, {
      path: "README.md",
      content: "mine",
      expectedVersion: read.version,
      overwrite: true,
    });
    expect(forced.status).toBe("saved");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("mine");
  });

  it("creates files only when the version is new", async () => {
    const root = await repository();
    const service = new FileService();
    const created = await service.write(root, { path: "src/deep/new.ts", content: "a", expectedVersion: "new" });
    expect(created.status).toBe("saved");
    expect(await readFile(join(root, "src", "deep", "new.ts"), "utf8")).toBe("a");

    const existing = await service.write(root, { path: "src/deep/new.ts", content: "b", expectedVersion: "new" });
    expect(existing).toMatchObject({ status: "conflict" });
    expect(await readFile(join(root, "src", "deep", "new.ts"), "utf8")).toBe("a");

    const read = await service.read(root, "src/deep/new.ts");
    await rm(join(root, "src", "deep", "new.ts"));
    await expect(
      service.write(root, { path: "src/deep/new.ts", content: "c", expectedVersion: read.version }),
    ).resolves.toEqual({ status: "conflict", path: "src/deep/new.ts", version: "new" });
  });

  it("rejects unsafe write paths", async () => {
    const root = await repository();
    const service = new FileService();
    await expect(service.write(root, { path: "../x.txt", content: "x", expectedVersion: "new" })).rejects.toThrow(
      "That file is outside the worktree.",
    );
    await expect(service.write(root, { path: "src", content: "x", expectedVersion: "new" })).rejects.toThrow(
      "That path is a folder: src",
    );
  });
});

describe("FileService.search", () => {
  it("finds fixed strings case-insensitively by default", async () => {
    const root = await repository();
    await writeFile(join(root, "notes.txt"), "a.b hello\n");
    const result = await new FileService().search(root, "HELLO");
    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual(
      expect.arrayContaining([
        { path: "README.md", line: 2, column: 1, preview: "Hello World" },
        { path: "src/app.ts", line: 1, column: 26, preview: "export const greeting = 'hello';" },
        { path: "notes.txt", line: 1, column: 5, preview: "a.b hello" },
      ]),
    );
    expect(result.matches).toHaveLength(3);
  });

  it("honors case sensitivity, regex, and option-like queries", async () => {
    const root = await repository();
    await writeFile(join(root, "notes.txt"), "a.b axb --help\n");
    const service = new FileService();
    expect((await service.search(root, "hello", { caseSensitive: true })).matches.map((match) => match.path)).toEqual([
      "src/app.ts",
    ]);
    expect((await service.search(root, "a.b")).matches).toEqual([
      { path: "notes.txt", line: 1, column: 1, preview: "a.b axb --help" },
    ]);
    expect((await service.search(root, "a.b axb", { regex: true })).matches).toHaveLength(1);
    expect((await service.search(root, "ax?b$|--h", { regex: true })).matches).toHaveLength(1);
    expect((await service.search(root, "--help")).matches).toHaveLength(1);
    await expect(service.search(root, "(", { regex: true })).rejects.toThrow(/Invalid search pattern/u);
  });

  it("returns no matches without failing", async () => {
    const root = await repository();
    expect(await new FileService().search(root, "definitely-not-here")).toEqual({ matches: [], truncated: false });
  });

  it("stops at the result limit", async () => {
    const root = await repository();
    await writeFile(join(root, "many.txt"), "needle\n".repeat(50));
    const service = new FileService();
    const limited = await service.search(root, "needle", { maxResults: 10 });
    expect(limited.matches).toHaveLength(10);
    expect(limited.truncated).toBe(true);
    const exact = await service.search(root, "needle", { maxResults: 50 });
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.matches).toHaveLength(50);
  });

  it("trims long lines around the match", async () => {
    const root = await repository();
    await writeFile(join(root, "long.txt"), `${"x".repeat(1_000)}target${"y".repeat(1_000)}\n`);
    const [match] = (await new FileService().search(root, "target")).matches;
    expect(match?.column).toBe(1_001);
    expect(match?.preview).toContain("target");
    expect(match?.preview.length).toBeLessThanOrEqual(202);
  });
});
