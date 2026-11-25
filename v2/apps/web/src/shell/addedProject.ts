/**
 * What opens after a folder is added as a project. From Settings nothing opens, only the project is
 * selected. Otherwise a new chat opens with the default agent; the dialog stays for Terminal mode, since a
 * terminal agent cannot change once it starts, and for a computer with no agent installed, where the
 * dialog says what is missing.
 */
export type AddedProjectStep = "select" | "chat" | "dialog";

export function stepAfterAddingProject({
  startAgent,
  mode,
  hasAgent,
}: {
  startAgent: boolean;
  mode: string | undefined;
  hasAgent: boolean;
}): AddedProjectStep {
  if (!startAgent) return "select";
  if (mode === "terminal" || !hasAgent) return "dialog";
  return "chat";
}
