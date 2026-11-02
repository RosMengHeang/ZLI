import type { MobileDevToolModule } from "./types.js";

export const buildTools: MobileDevToolModule = {
  tools: [
    {
      name: "mobile_build_brief",
      title: "Explain a build failure",
      action: "mobilebuildbrief",
      readOnly: true,
      description:
        "Give a failed Gradle, Xcode, EAS, or Metro log (text or a file path) and get the real first error with context, what kind of failure it is, this project's version problems, the files most likely involved, a first command to propose, and the shortcuts to avoid. Call this before changing versions or config to fix a build.",
      properties: {
        log: { type: "string", description: "The log text, or at least its last few thousand lines. Up to 2 MB." },
        logPath: {
          type: "string",
          description:
            "A log file in this worktree or the temp folder, relative to the worktree root or absolute. ZLI reads its last 2 MB.",
        },
      },
    },
  ],
  format: (action, result) => {
    if (action !== "mobilebuildbrief" || typeof result !== "object" || result === null) return undefined;
    const text = (result as { text?: unknown }).text;
    return typeof text === "string" ? { content: [{ type: "text", text }] } : undefined;
  },
  instructions:
    "When a build fails, call mobile_build_brief with the log before you change versions or config, and fix the first error it names.",
};
