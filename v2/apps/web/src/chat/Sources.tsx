import type { ThreadActivityProjection, ThreadActivitySource } from "@zli-v2/contracts";
import { createContext, useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Collapse } from "../ui/Collapse.js";
import { Icon } from "../ui/Icon.js";

export type Source = ThreadActivitySource;

/** A source the reply links to, numbered in the order the turn found it. */
export type Citation = Source & { number: number; host: string };

/** The site a page is on, without the "www." most sites put in front. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

/** One form of an address for matching a reply's link to a source: no fragment, no trailing slash. */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return url.replace(/#.*$/u, "").replace(/\/$/u, "");
  }
}

/** Every page a turn's web steps looked at, each once, in the order they came up. */
export function turnSources(activities: readonly ThreadActivityProjection[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const activity of activities) {
    if (activity.kind !== "web") continue;
    for (const source of activity.urls ?? []) {
      const key = sourceKey(source.url);
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}

export function citationsFor(sources: readonly Source[]): ReadonlyMap<string, Citation> {
  return new Map(
    sources.map((source, index) => [sourceKey(source.url), { ...source, number: index + 1, host: hostOf(source.url) }]),
  );
}

/** The sources of the turn a reply belongs to, so its links to them read as citations. */
export const CitationContext = createContext<ReadonlyMap<string, Citation> | undefined>(undefined);

/** Opens a web address the way reply links do: in the system browser, never in the app window. */
export function useOpenWebLink(): (href: string) => void {
  const { bridge } = useRuntime();
  return useCallback(
    (href: string) => {
      if (bridge?.app.openExternal) void openExternalLink(bridge, href);
      else window.open(href, "_blank", "noopener,noreferrer");
    },
    [bridge],
  );
}

/** The site's icon, or its first letter when the icon cannot load, as when the machine is offline. */
function SiteIcon({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="site-icon is-letter" aria-hidden="true">
        {host.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="site-icon"
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      alt=""
      width={12}
      height={12}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** The pages one web step looked at, as small site chips under the step. */
export function SourceChips({ urls }: { urls: readonly Source[] }) {
  const open = useOpenWebLink();
  return (
    <ul className="source-chips" aria-label="Pages">
      {urls.map((source) => {
        const host = hostOf(source.url);
        return (
          <li key={source.url}>
            <button
              className="source-chip"
              type="button"
              title={source.title ? `${source.title}\n${source.url}` : source.url}
              onClick={() => open(source.url)}
            >
              <SiteIcon host={host} />
              <span className="source-chip-host">{host}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Under a reply that searched the web: one quiet line that opens to the pages it drew on. */
export function SourcesRow({ sources }: { sources: readonly Source[] }) {
  const [expanded, setExpanded] = useState(false);
  const open = useOpenWebLink();
  return (
    <section className={`sources${expanded ? " is-open" : ""}`} aria-label="Sources">
      <button className="sources-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Icon name="chevronRight" size={11} className="sources-chevron" />
        Sources ({sources.length})
      </button>
      <Collapse open={expanded}>
        <ol className="sources-list">
          {sources.map((source, index) => {
            const host = hostOf(source.url);
            return (
              <li key={source.url}>
                <button className="sources-item" type="button" title={source.url} onClick={() => open(source.url)}>
                  <span className="sources-number">{index + 1}</span>
                  <SiteIcon host={host} />
                  <span className="sources-title">{source.title ?? host}</span>
                  {source.title ? <span className="sources-host">{host}</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      </Collapse>
    </section>
  );
}

/** A reply's link to one of its turn's sources: a small number that names the page on hover. */
export function CitationChip({ citation }: { citation: Citation }) {
  const open = useOpenWebLink();
  const [hover, setHover] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const placement = useAnchoredPlacement(hover, triggerRef, cardRef, {
    prefer: "above",
    align: "start",
    gap: 6,
    edge: 8,
  });
  return (
    <>
      <button
        ref={triggerRef}
        className="md-cite"
        type="button"
        aria-label={`Source ${citation.number}: ${citation.title ?? citation.host}`}
        aria-describedby={hover ? cardId : undefined}
        onClick={() => open(citation.url)}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        {citation.number}
      </button>
      {hover && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={cardRef}
              id={cardId}
              className="cite-card"
              role="tooltip"
              style={placement ? { ...placement, maxHeight: undefined } : { left: 0, top: 0, visibility: "hidden" }}
            >
              {citation.title ? <p className="cite-card-title">{citation.title}</p> : null}
              <p className="cite-card-host">
                <SiteIcon host={citation.host} />
                {citation.host}
              </p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
