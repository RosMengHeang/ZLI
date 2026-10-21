import { describe, expect, it } from "vitest";

import type { AlertProjection } from "./agentAlerts.js";
import { AgentNotifier, type NotifierHost } from "./AgentNotifier.js";
import type { NotificationSettings } from "./notificationSettings.js";

const worktreeId = "00000000-0000-4000-8000-000000000101";

function projection(status: string, requests: string[] = []): AlertProjection {
  return {
    worktrees: [{ worktreeId, projectId: "p", path: "/repo", branch: "main", status: "ready" }],
    threads: [
      {
        threadId: "t1",
        sessionId: "s1",
        worktreeId,
        provider: "codex",
        status,
        capabilities: {},
        activeTurnId: "turn-1",
      },
    ],
    terminals: [],
    requests: requests.map((requestId) => ({ requestId, threadId: "t1", kind: "approval", payload: {} })),
  } as unknown as AlertProjection;
}

function setup(initial: Partial<NotificationSettings> = {}) {
  const settings: NotificationSettings = { enabled: true, sound: true, ...initial };
  const shown: { title: string; silent: boolean; click(): void }[] = [];
  const badges: number[] = [];
  const flashes: boolean[] = [];
  const activated: string[] = [];
  let focused = false;
  const host: NotifierHost = {
    show: (notification, onClick) =>
      shown.push({ title: notification.title, silent: notification.silent, click: onClick }),
    setBadgeCount: (count) => badges.push(count),
    flashFrame: (flash) => flashes.push(flash),
    isFocused: () => focused,
    activate: (sessionId) => activated.push(sessionId),
  };
  const notifier = new AgentNotifier(host, () => settings);
  return {
    notifier,
    settings,
    shown,
    badges,
    flashes,
    activated,
    focus: (value: boolean) => {
      focused = value;
    },
  };
}

describe("AgentNotifier", () => {
  it("is silent for the first projection and notifies once per transition", () => {
    const { notifier, shown } = setup();
    notifier.update(projection("working"));
    expect(shown).toEqual([]);
    notifier.update(projection("idle"));
    notifier.update(projection("idle"));
    expect(shown.map((entry) => entry.title)).toEqual(["Codex finished"]);
  });

  it("does not repeat a transition it already announced", () => {
    const { notifier, shown } = setup();
    notifier.update(projection("working"));
    notifier.update(projection("idle"));
    notifier.update(projection("working"));
    notifier.update(projection("idle"));
    expect(shown).toHaveLength(1);
  });

  it("skips agents on screen while the window is focused", () => {
    const { notifier, shown, focus } = setup();
    focus(true);
    notifier.setViewing(["s1"]);
    notifier.update(projection("working"));
    notifier.update(projection("idle"));
    expect(shown).toEqual([]);

    notifier.setViewing([]);
    notifier.update(projection("working", ["r1"]));
    expect(shown.map((entry) => entry.title)).toEqual(["Codex needs approval"]);
  });

  it("notifies on screen agents when the window is in the background", () => {
    const { notifier, shown } = setup();
    notifier.setViewing(["s1"]);
    notifier.update(projection("working"));
    notifier.update(projection("idle"));
    expect(shown).toHaveLength(1);
  });

  it("selects the session when a notification is clicked", () => {
    const { notifier, shown, activated } = setup();
    notifier.update(projection("working"));
    notifier.update(projection("idle"));
    shown[0]?.click();
    expect(activated).toEqual(["s1"]);
  });

  it("keeps the badge at the number of waiting agents and flashes for new requests in the background", () => {
    const { notifier, badges, flashes } = setup();
    notifier.update(projection("working"));
    notifier.update(projection("waiting", ["r1"]));
    notifier.update(projection("waiting", ["r1", "r2"]));
    notifier.update(projection("working"));
    expect(badges).toEqual([0, 1, 0]);
    expect(flashes).toEqual([true, true]);
    notifier.windowFocused();
    expect(flashes.at(-1)).toBe(false);
  });

  it("plays no sound when sound is off and does nothing when notifications are off", () => {
    const sound = setup({ sound: false });
    sound.notifier.update(projection("working"));
    sound.notifier.update(projection("idle"));
    expect(sound.shown[0]?.silent).toBe(true);

    const off = setup({ enabled: false });
    off.notifier.update(projection("working"));
    off.notifier.update(projection("waiting", ["r1"]));
    expect(off.shown).toEqual([]);
    expect(off.badges).toEqual([0]);
    expect(off.flashes).toEqual([]);
  });

  it("clears the badge when notifications are turned off and restores it when turned back on", () => {
    const { notifier, badges, settings } = setup();
    notifier.update(projection("waiting", ["r1"]));
    settings.enabled = false;
    notifier.settingsChanged();
    settings.enabled = true;
    notifier.settingsChanged();
    expect(badges).toEqual([1, 0, 1]);
  });
});
