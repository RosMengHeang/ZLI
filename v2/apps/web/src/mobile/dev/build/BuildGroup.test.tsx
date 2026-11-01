// @vitest-environment jsdom

import type { MobileBuildBrief, MobileProposal } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { button, cleanup, click, devContext, render, testRuntime } from "../crash/testRender.js";
import { BuildGroup } from "./BuildGroup.js";

const brief: MobileBuildBrief = {
  stack: "gradle",
  category: "jdk-gradle",
  confidence: "high",
  firstError: {
    line: "General error during conversion: Unsupported class file major version 65",
    lineNumber: 40,
    context: ["* What went wrong:", "  General error during conversion: Unsupported class file major version 65", ""],
  },
  versionFindings: [],
  versionChecked: false,
  likelyFiles: ["android/gradle/wrapper/gradle-wrapper.properties"],
  avoid: ["Do not add @ts-ignore, @Suppress, try!, or skip tests to make the build pass."],
  suggestion: {
    text: "Install pods.",
    title: "Install pods",
    action: { kind: "command", program: "pod", args: ["install"], cwd: "ios" },
  },
  text: "Build failure: JDK / Gradle (Gradle, high confidence).",
};

function fakeBuild() {
  return {
    brief: vi.fn(async () => brief),
    propose: vi.fn(async () => ({ proposalId: "p-1" }) as MobileProposal),
  };
}

async function paste(container: HTMLElement, value: string) {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(cleanup);

describe("build failure group", () => {
  it("explains a pasted log only once there is text", async () => {
    const build = fakeBuild();
    const container = await render(<BuildGroup context={devContext({ build })} />, testRuntime().bridge);
    expect(container.querySelector("h3")?.textContent).toBe("Build failure");
    expect(container.textContent).toContain(
      "Paste the end of a failed Gradle, Xcode, or EAS build. ZLI finds the first real error.",
    );
    expect(button(container, "Explain").disabled).toBe(true);
    await paste(container, "FAILURE: Build failed");
    await click(button(container, "Explain"));
    expect(build.brief).toHaveBeenCalledWith("wt-1", "FAILURE: Build failed");
    expect(container.querySelector(".badge")?.textContent).toBe("JDK / Gradle");
    expect(container.textContent).toContain("high confidence");
    expect(container.querySelector(".mobile-build-well")?.textContent).toBe(brief.firstError.line);
    expect(container.textContent).toContain("Version checks did not run.");
    expect(container.querySelector(".mobile-build-files li")?.textContent).toBe(
      "android/gradle/wrapper/gradle-wrapper.properties",
    );
    await click(button(container, "Show context"));
    expect(container.querySelector(".mobile-build-well")?.textContent).toContain("* What went wrong:");
    expect(container.querySelector(".mobile-build-well .is-error")?.textContent?.trim()).toBe(brief.firstError.line);
  });

  it("proposes the fix as a card, and sends the brief to the agent", async () => {
    const build = fakeBuild();
    const runtime = testRuntime();
    const context = devContext({ build });
    const container = await render(<BuildGroup context={context} />, runtime.bridge);
    await paste(container, "log");
    await click(button(container, "Explain"));
    await click(button(container, "Propose fix"));
    expect(build.propose).toHaveBeenCalledWith({
      worktreeId: "wt-1",
      title: "Install pods",
      reason: "Install pods.",
      action: brief.suggestion?.action,
    });
    await click(button(container, "Send to agent"));
    expect(runtime.commands).toEqual([{ type: "thread.send", threadId: "t-1", text: brief.text }]);
    expect(context.onNotice).toHaveBeenCalledWith("Sent to the agent in feat-login");
  });

  it("has no Propose fix without a command, and no Send to agent without an agent", async () => {
    const build = fakeBuild();
    build.brief.mockResolvedValueOnce({ ...brief, suggestion: { text: "Install JDK 17 and point JAVA_HOME to it." } });
    const container = await render(<BuildGroup context={devContext({ build })} />, testRuntime(false).bridge);
    await paste(container, "log");
    await click(button(container, "Explain"));
    expect(() => button(container, "Propose fix")).toThrow();
    expect(button(container, "Send to agent").disabled).toBe(true);
    expect(container.textContent).toContain("Install JDK 17 and point JAVA_HOME to it.");
  });

  it("shows why a log could not be read", async () => {
    const build = fakeBuild();
    build.brief.mockRejectedValueOnce(new Error("That worktree is not in ZLI."));
    const container = await render(<BuildGroup context={devContext({ build })} />, testRuntime().bridge);
    await paste(container, "log");
    await click(button(container, "Explain"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("That worktree is not in ZLI.");
  });
});
