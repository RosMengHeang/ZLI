import { webCryptoRandomBytes } from "@zli-v2/remote-protocol";
import { describe, expect, it } from "vitest";

import {
  changeTotals,
  commitChanges,
  commitPlan,
  parseDiff,
  readBranches,
  readFileDiff,
  refreshChanges,
  reviewFor,
  totalsLabel,
} from "./changes.js";
import { demoPairing, openDemoSession } from "./demoDesktop.js";
import { ids } from "./fixtures.js";
import { RemoteLink } from "./link.js";
import { liveStatus } from "./liveStatus.js";
import { StoredPairing } from "./pairingRecord.js";

function demoLink(): RemoteLink {
  return new RemoteLink({
    pairing: demoPairing,
    random: webCryptoRandomBytes,
    createSocket: () => {
      throw new Error("not used");
    },
    newId: () => crypto.randomUUID(),
    openSession: openDemoSession,
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !check(); index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}

describe("demo desktop", () => {
  it("has a pairing the app accepts", () => {
    expect(StoredPairing.parse(demoPairing)).toEqual(demoPairing);
  });

  it("goes online through the real link with the named sample agents", async () => {
    const link = demoLink();
    link.start();
    await until(() => link.getSnapshot().state.kind === "online" && link.getSnapshot().projection !== undefined);
    const names = link.getSnapshot().projection?.threads.map((thread) => thread.name);
    expect(names).toEqual(["Fix the login form", "Clean the build output", "Update the README"]);
    expect(liveStatus(link.getSnapshot().projection)).toMatchObject({
      agent: "Clean the build output",
      title: "Clean the build output asks to continue",
    });
    link.pause();
    await link.settled();
  });

  it("plays out an answer and a stop, so the live status moves on", async () => {
    const link = demoLink();
    link.start();
    await until(() => link.getSnapshot().state.kind === "online");
    await link.command({ type: "thread.respond", threadId: ids.waiting, requestId: "r1", decision: {} });
    await until(() => (link.getSnapshot().projection?.requests ?? []).length === 0);
    expect(liveStatus(link.getSnapshot().projection)?.title).toBe("Fix the login form is working");

    await link.command({ type: "thread.stop", threadId: ids.working });
    await until(() => liveStatus(link.getSnapshot().projection) === undefined);
    link.pause();
    await link.settled();
  });

  it("answers terminal reads with sample output", async () => {
    const link = demoLink();
    link.start();
    await until(() => link.getSnapshot().state.kind === "online");
    const response = await link.command({ type: "terminal.read", terminalId: ids.shell, maxBytes: 1024 });
    expect(response).toMatchObject({ accepted: true, result: { terminalId: ids.shell, truncated: false } });
    link.pause();
    await link.settled();
  });

  it("lists the feature worktree's changes, reads their diffs, and commits and pushes them", async () => {
    const link = demoLink();
    link.start();
    await until(() => link.getSnapshot().state.kind === "online");
    const review = reviewFor(link.getSnapshot().projection, ids.feature);
    expect(review?.files.map((file) => file.path)).toEqual([
      "src/auth/LoginForm.tsx",
      "src/auth/session.ts",
      "src/auth/LoginForm.test.tsx",
    ]);
    expect(totalsLabel(changeTotals(review?.files ?? []))).toBe("+26 −10 in 3 files");

    expect(await refreshChanges(link, ids.feature, 1_000)).toEqual({ ok: true });
    const diff = await readFileDiff(link, ids.feature, "src/auth/session.ts");
    expect(diff.ok && parseDiff(diff.diff.patch).lines.filter((line) => line.kind === "add")).toHaveLength(2);

    const branches = await readBranches(link, ids.feature);
    const plan = commitPlan(reviewFor(link.getSnapshot().projection, ids.feature), branches);
    expect(plan).toEqual({ kind: "commit", push: true, staged: false });
    expect(
      await commitChanges(link, { worktreeId: ids.feature, message: "Submit the login form once", push: true }, 1_000),
    ).toEqual({
      ok: true,
      notice: "Committed and pushed feature/login to origin.",
    });
    expect(reviewFor(link.getSnapshot().projection, ids.feature)?.files).toEqual([]);
    link.pause();
    await link.settled();
  });

  it("offers Push after a commit that was not pushed", async () => {
    const link = demoLink();
    link.start();
    await until(() => link.getSnapshot().state.kind === "online");
    await commitChanges(link, { worktreeId: ids.feature, message: "Submit the login form once", push: false }, 1_000);
    const plan = commitPlan(
      reviewFor(link.getSnapshot().projection, ids.feature),
      await readBranches(link, ids.feature),
    );
    expect(plan.kind).toBe("push");
    link.pause();
    await link.settled();
  });
});
