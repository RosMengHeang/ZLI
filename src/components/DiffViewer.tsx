import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DIFF_LINE_HEIGHT,
  MAX_DIFF_LINES,
  parseDiffLines,
  visibleDiffRange,
  type DiffKind,
} from "../lib/diffView";

const STYLES: Record<DiffKind, CSSProperties> = {
  meta: { color: "#8a909e" },
  header: { color: "#6eafc7" },
  hunk: { color: "#93c5fd", background: "rgba(37,99,235,0.16)" },
  add: { color: "#4ade80", background: "rgba(34,197,94,0.12)" },
  del: { color: "#f87171", background: "rgba(239,68,68,0.12)" },
  ctx: { color: "#e5e7eb" },
};

export function DiffViewer({ diff, binary, path }: { diff: string; binary?: boolean; path?: string }) {
  const scrollerRef = useRef<HTMLPreElement>(null);
  const [range, setRange] = useState({ start: 0, end: 80 });

  const allLines = useMemo(() => (binary || !diff.trim() ? [] : parseDiffLines(diff)), [binary, diff]);
  const truncated = allLines.length > MAX_DIFF_LINES;
  const lines = truncated ? allLines.slice(0, MAX_DIFF_LINES) : allLines;

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      setRange(visibleDiffRange(el.scrollTop, el.clientHeight, lines.length));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [lines.length]);

  if (binary) {
    return (
      <div className="p-4 font-mono text-[12px] text-warn">
        Binary file{path ? ` (${path})` : ""}. Diff not shown.
      </div>
    );
  }
  if (!diff.trim()) {
    return (
      <div className="p-4 text-[13px] text-mute">
        No diff text for {path ?? "this file"}.
      </div>
    );
  }

  const slice = lines.slice(range.start, range.end);

  return (
    <pre
      ref={scrollerRef}
      className="m-0 h-full min-h-0 overflow-auto bg-ink p-0 font-mono text-[12px] leading-[18px]"
    >
      {truncated ? (
        <div className="px-3 py-1.5 text-warn">
          Showing first {MAX_DIFF_LINES.toLocaleString()} of {allLines.length.toLocaleString()} lines.
        </div>
      ) : null}
      <div style={{ height: lines.length * DIFF_LINE_HEIGHT, position: "relative" }}>
        <div style={{ position: "absolute", top: range.start * DIFF_LINE_HEIGHT, left: 0, right: 0 }}>
          {slice.map((line, index) => (
            <div key={range.start + index} className="whitespace-pre px-3" style={STYLES[line.kind]}>
              {line.text || " "}
            </div>
          ))}
        </div>
      </div>
    </pre>
  );
}
