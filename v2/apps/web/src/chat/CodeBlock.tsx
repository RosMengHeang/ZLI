import { highlightCode } from "@lezer/highlight";
import { type ReactNode, useEffect, useState } from "react";

import { useCopyFeedback } from "../review/links.js";
import { Button } from "../ui/Button.js";
import { Segmented, type SegmentedOption } from "../ui/Segmented.js";

export type PreviewKind = "html" | "svg";

type View = "preview" | "code";

const VIEW_OPTIONS: readonly SegmentedOption<View>[] = [
  { value: "preview", label: "Preview" },
  { value: "code", label: "Code" },
];

/** Scripts, forms, and every network fetch stay off; inline styles and data: images still render. */
const PREVIEW_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** Longer blocks stay plain: coloring them on every streamed word would stall the reply. */
const MAX_HIGHLIGHT_CHARS = 40_000;
/** A block taller than this opens folded, so one long file does not push the rest of the reply away. */
export const FOLD_LINES = 28;

export function previewKind(lang: string, text: string): PreviewKind | undefined {
  const language = lang.toLowerCase();
  const trimmed = text.trimStart();
  if (language === "svg" || (language === "xml" && /^<svg[\s>]/iu.test(trimmed))) return "svg";
  if (language === "html" || language === "htm") return "html";
  return undefined;
}

/** A whole page or a drawing opens as a preview; an HTML fragment shown as code opens as code. */
export function opensAsPreview(kind: PreviewKind, text: string): boolean {
  if (kind === "svg") return true;
  return /^\s*(<!doctype html|<html[\s>])/iu.test(text);
}

export function previewDocument(kind: PreviewKind, text: string): string {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">`;
  if (kind === "svg") {
    return `<!doctype html><html><head>${head}<style>html,body{height:100%;margin:0;background:#fff}body{display:grid;place-items:center}svg{max-width:100%;max-height:100%}</style></head><body>${text}</body></html>`;
  }
  // The policy goes first so it applies before any markup in the reply is parsed.
  return `${head}<style>html{background:#fff;color:#111}</style>${text}`;
}

type Colored = { text: string; nodes: ReactNode[] };

/**
 * The code in the editor's syntax colors, once the language's parser has loaded. While a reply
 * streams, the part colored so far stays colored and the new tail shows plain until it catches up.
 */
function useColored(lang: string, text: string): ReactNode {
  const [colored, setColored] = useState<Colored>();
  useEffect(() => {
    if (!lang || !text || text.length > MAX_HIGHLIGHT_CHARS) return;
    let cancelled = false;
    void import("../files/codeEditor.js")
      .then(async ({ fenceHighlighter, loadFenceParser }) => {
        const parser = await loadFenceParser(lang);
        if (!parser || cancelled) return;
        const nodes: ReactNode[] = [];
        let key = 0;
        highlightCode(
          text,
          parser.parse(text),
          fenceHighlighter,
          (chunk, classes) => {
            key += 1;
            nodes.push(
              classes ? (
                <span key={key} className={classes}>
                  {chunk}
                </span>
              ) : (
                chunk
              ),
            );
          },
          () => nodes.push("\n"),
        );
        setColored({ text, nodes });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lang, text]);
  if (!colored || !text.startsWith(colored.text)) return text;
  return colored.text.length === text.length ? colored.nodes : [...colored.nodes, text.slice(colored.text.length)];
}

export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const kind = previewKind(lang, text);
  const [view, setView] = useState<View>(() => (kind && opensAsPreview(kind, text) ? "preview" : "code"));
  const [copyState, copy] = useCopyFeedback();
  const [unfolded, setUnfolded] = useState(false);
  const code = useColored(lang, text);
  const showPreview = kind !== undefined && view === "preview";
  const lines = text.split("\n").length;
  const foldable = lines > FOLD_LINES;
  const folded = foldable && !unfolded;
  return (
    <figure className={`md-code-block${showPreview ? " is-preview" : ""}${folded ? " is-folded" : ""}`}>
      <figcaption className="md-code-head">
        <span className="md-code-lang">{lang || "text"}</span>
        {kind ? (
          <Segmented<View>
            className="md-code-views"
            label="Show as"
            value={view}
            options={VIEW_OPTIONS}
            onChange={setView}
          />
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          icon={copyState === "copied" ? "check" : "copy"}
          onClick={() => copy(text)}
          aria-live="polite"
        >
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
        </Button>
      </figcaption>
      {showPreview ? (
        <>
          <iframe
            className="md-preview"
            title={kind === "svg" ? "SVG preview" : "HTML preview"}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={previewDocument(kind, text)}
          />
          <p className="md-preview-note">Scripts and network requests are off in this preview.</p>
        </>
      ) : (
        <>
          <pre className="md-code" data-lang={lang || undefined}>
            <code>{code}</code>
          </pre>
          {foldable ? (
            <button
              type="button"
              className="md-code-fold"
              aria-expanded={!folded}
              onClick={() => setUnfolded((value) => !value)}
            >
              {folded ? `Show all ${lines} lines` : "Show less"}
            </button>
          ) : null}
        </>
      )}
    </figure>
  );
}
