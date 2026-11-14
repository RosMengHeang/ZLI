import { useCopyFeedback } from "../review/links.js";
import { IconButton } from "../ui/Button.js";

/** An icon-only copy button. Its label says when the copy worked, so the tooltip confirms it too. */
export function CopyButton({ text, className }: { text: string; className?: string | undefined }) {
  const [state, copy] = useCopyFeedback();
  return (
    <IconButton
      size="xs"
      icon={state === "copied" ? "check" : "copy"}
      label={state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      className={className}
      onClick={() => copy(text)}
    />
  );
}
