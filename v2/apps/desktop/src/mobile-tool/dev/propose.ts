import { PROPOSAL_PROGRAMS } from "@zli-v2/contracts";

import type { MobileDevToolModule } from "./types.js";

export const proposeTools: MobileDevToolModule = {
  tools: [
    {
      name: "mobile_propose",
      title: "Propose a command",
      action: "mobilepropose",
      description:
        "Ask the person to run a command, such as an install or a fix, in this worktree. ZLI shows it in the Mobile panel with Run in terminal and Dismiss; nothing runs until they choose Run. Use this instead of running installs or fixes yourself.",
      properties: {
        title: {
          type: "string",
          description: "What the command does, as the person reads it, such as Install expo-camera.",
        },
        reason: { type: "string", description: "One or two sentences on why it is needed." },
        program: { type: "string", enum: [...PROPOSAL_PROGRAMS] },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            'The arguments, one word each, such as ["expo", "install", "expo-camera"]. Letters, digits, and @ . _ / : = + , % ^ ~ - only: no spaces, quotes, or shell operators.',
        },
        folder: {
          type: "string",
          description: "Where to run it, relative to the worktree root, such as apps/mobile. Defaults to the root.",
        },
      },
      required: ["title", "program"],
    },
  ],
  format: (action, result) => {
    if (action !== "mobilepropose" || typeof result !== "object" || result === null) return undefined;
    const message = (result as { message?: unknown }).message;
    return typeof message === "string" ? { content: [{ type: "text", text: message }] } : undefined;
  },
  instructions:
    "When an install, fix, or build command needs to run, call mobile_propose so the person can run it from the Mobile panel; do not run it yourself.",
};
