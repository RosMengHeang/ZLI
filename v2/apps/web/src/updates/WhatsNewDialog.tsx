import type { WhatsNew } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { renderMarkdown } from "../files/markdown.js";
import { openExternalLink } from "../review/links.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";

/** Release notes for the version ZLI just updated to. GitHub sends Markdown or HTML; both render here. */
export function WhatsNewDialog({
  whatsNew,
  bridge,
  onOpenRelease,
  onClose,
}: {
  whatsNew: WhatsNew;
  bridge: ZliBridge | undefined;
  onOpenRelease(): void;
  onClose(): void;
}) {
  const [notice, setNotice] = useState<string>();
  const notesRef = useRef<HTMLDivElement>(null);
  const markup = useMemo(
    () => (whatsNew.notes ? { __html: renderMarkdown(whatsNew.notes) } : undefined),
    [whatsNew.notes],
  );

  // Links in the notes would otherwise navigate the app window away from ZLI.
  useEffect(() => {
    const notes = notesRef.current;
    if (!notes) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || !notes.contains(anchor)) return;
      event.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (/^https?:\/\//iu.test(href)) void openExternalLink(bridge, href).then(setNotice);
    };
    notes.addEventListener("click", onClick);
    return () => notes.removeEventListener("click", onClick);
  }, [bridge]);

  return (
    <Dialog
      label="What's new"
      title={`What's new in v${whatsNew.version}`}
      subtitle="ZLI updated itself. Here is what changed."
      className="whats-new-dialog"
      scrimLabel="Close what's new"
      onClose={onClose}
    >
      <div className="dialog-body whats-new-body">
        {markup ? (
          <div
            ref={notesRef}
            className="file-md whats-new-notes"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes with DOMPurify.
            dangerouslySetInnerHTML={markup}
          />
        ) : (
          <p className="field-hint">This release has no notes here. The release page lists what changed.</p>
        )}
        {notice ? (
          <p className="field-hint" role="alert">
            {notice}
          </p>
        ) : null}
      </div>
      <div className="dialog-footer">
        <Button icon="externalLink" onClick={onOpenRelease}>
          View on GitHub
        </Button>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
