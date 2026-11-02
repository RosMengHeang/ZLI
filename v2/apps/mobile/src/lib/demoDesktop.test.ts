import { webCryptoRandomBytes } from "@zli-v2/remote-protocol";
import { describe, expect, it } from "vitest";

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
});
