import { describe, expect, it } from "vitest";

import {
  fileExtension,
  fileKind,
  fileName,
  parentName,
  splitAttachedFiles,
  withAttachedFiles,
} from "./attachedFiles.js";

const pdf = "C:\\Users\\USER\\Downloads\\Ros MengHeang (1).pdf";

describe("attached files", () => {
  it("lists the paths after the message and reads them back", () => {
    const text = withAttachedFiles([pdf, "/home/me/notes.md"], "Summarize these");
    expect(text).toBe(`Summarize these\n\nAttached files:\n- \`${pdf}\`\n- \`/home/me/notes.md\``);
    expect(splitAttachedFiles(text)).toEqual({ text: "Summarize these", paths: [pdf, "/home/me/notes.md"] });
  });

  it("handles a message with no text and paths with backticks", () => {
    const text = withAttachedFiles(["/tmp/odd`name.txt"], "");
    expect(text).toBe("Attached files:\n- /tmp/odd`name.txt");
    expect(splitAttachedFiles(text)).toEqual({ text: "", paths: ["/tmp/odd`name.txt"] });
    expect(withAttachedFiles([], "hi")).toBe("hi");
  });

  it("leaves a message alone when the list is not a clean trailing block", () => {
    const typed = "Attached files:\n- a.pdf\nand then more words";
    expect(splitAttachedFiles(typed)).toEqual({ text: typed, paths: [] });
    expect(splitAttachedFiles("no files here")).toEqual({ text: "no files here", paths: [] });
  });

  it("names files and folders on Windows and POSIX paths", () => {
    expect(fileName(pdf)).toBe("Ros MengHeang (1).pdf");
    expect(parentName(pdf)).toBe("Downloads");
    expect(fileName("/home/me/project/")).toBe("project");
    expect(parentName("report.pdf")).toBe("");
  });

  it("sorts files by extension", () => {
    expect(fileExtension(pdf)).toBe("pdf");
    expect(fileExtension("/repo/.env")).toBe("");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileKind(pdf)).toBe("pdf");
    expect(fileKind("C:\\data\\Q3.XLSX")).toBe("sheet");
    expect(fileKind("deck.pptx")).toBe("slides");
    expect(fileKind("src/app.ts")).toBe("code");
    expect(fileKind("archive.zip")).toBe("archive");
    expect(fileKind("photo.heic")).toBe("media");
    expect(fileKind("Makefile")).toBe("other");
  });
});
