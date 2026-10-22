import { shortcutKeys } from "./shortcuts.js";

/** Key caps for a shortcut. Decorative: the control it belongs to carries aria-keyshortcuts instead. */
export function Kbd({ shortcut, className }: { shortcut: string; className?: string }) {
  return (
    <span className={`kbd-group${className ? ` ${className}` : ""}`} aria-hidden="true">
      {shortcutKeys(shortcut).map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}
