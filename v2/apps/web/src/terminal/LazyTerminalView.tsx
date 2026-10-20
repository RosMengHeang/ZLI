import { type ComponentProps, lazy, Suspense } from "react";

import type { TerminalView as TerminalViewComponent } from "./TerminalView.js";

const TerminalView = lazy(() => import("./TerminalView.js").then((module) => ({ default: module.TerminalView })));

/** Loads xterm the first time a terminal is shown, keeping it out of the startup bundle. */
export function LazyTerminalView(props: ComponentProps<typeof TerminalViewComponent>) {
  return (
    <Suspense fallback={<div className={props.className ?? "terminal-output"} aria-busy="true" />}>
      <TerminalView {...props} />
    </Suspense>
  );
}
