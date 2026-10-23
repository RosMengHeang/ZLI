import { useState } from "react";

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

export function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const kind = previewKind(lang, text);
  const [view, setView] = useState<View>(() => (kind && opensAsPreview(kind, text) ? "preview" : "code"));
  const [copyState, copy] = useCopyFeedback();
  const showPreview = kind !== undefined && view === "preview";
  return (
    <figure className={`md-code-block${showPreview ? " is-preview" : ""}`}>
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
        <pre className="md-code" data-lang={lang || undefined}>
          <code>{text}</code>
        </pre>
      )}
    </figure>
  );
}
