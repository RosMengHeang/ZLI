import type { CSSProperties } from "react";

type DiffKind = "meta" | "header" | "hunk" | "add" | "del" | "ctx";

interface DiffLine {
  kind: DiffKind;
  text: string;
}

function classify(line: string): DiffKind {
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
    return "meta";
  }
  if (line.startsWith("---") || line.startsWith("+++")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

const STYLES: Record<DiffKind, CSSProperties> = {
  meta: { color: "#8b8b8b" },
  header: { color: "#569cd6" },
  hunk: { color: "#c586c0", background: "#2b2142" },
  add: { color: "#3fb950", background: "rgba(63,185,80,0.12)" },
  del: { color: "#f85149", background: "rgba(248,81,73,0.12)" },
  ctx: { color: "#d4d4d4" },
};

export function DiffViewer({ diff, binary, path }: { diff: string; binary?: boolean; path?: string }) {
  if (binary) {
    return (
      <div className="p-3 font-mono text-[12px] text-[#cca700]">
        Binary file{path ? ` (${path})` : ""}. Diff not shown.
      </div>
    );
  }
  if (!diff.trim()) {
    return (
      <div className="p-3 text-[12px] text-[#8b8b8b]">
        No diff text for {path ?? "this file"}.
      </div>
    );
  }

  const lines: DiffLine[] = diff.replace(/\r\n/g, "\n").split("\n").map((text) => ({
    kind: classify(text),
    text,
  }));

  return (
    <pre className="m-0 min-h-0 overflow-auto bg-[#1e1e1e] p-0 font-mono text-[12px] leading-[18px]">
      {lines.map((line, index) => (
        <div key={index} className="whitespace-pre px-2" style={STYLES[line.kind]}>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}
