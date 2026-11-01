import { readFileSync } from "node:fs";

import { crashLineMarks, shortCrashTitle } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { CrashDetector, type DetectedCrash } from "./detector.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.log`, import.meta.url), "utf8").split("\n");

/** Each crash with the 1-based line that closed its block, or "flush" when the log ended first. */
function detect(lines: readonly string[]): { at: number | "flush"; crash: DetectedCrash }[] {
  const detector = new CrashDetector();
  return [
    ...lines.flatMap((line, index) => detector.push(line).map((crash) => ({ at: index + 1, crash }))),
    ...detector.flush().map((crash) => ({ at: "flush" as const, crash })),
  ];
}

describe("crash detector", () => {
  it("reads a Java crash and gives a repeat the same signature", () => {
    const found = detect(fixture("java-fatal"));
    expect(found.map((entry) => entry.at)).toEqual([63, 98]);
    const [first, second] = found.map((entry) => entry.crash);
    expect(first).toMatchObject({
      kind: "java",
      appId: "com.example.app",
      title: "java.lang.IllegalStateException: Fragment ProfileFragment{5f2a1b} not attached to a context.",
    });
    expect(first?.frames).toHaveLength(8);
    expect(first?.frames[0]).toBe("at androidx.fragment.app.Fragment.requireContext(Fragment.java:972)");
    // The signature uses the app's own frames, not the framework's.
    expect(first?.signature).toContain("ProfileFragment.onAvatarLoaded");
    expect(first?.signature).not.toContain("androidx");
    expect(second?.signature).toBe(first?.signature);
    expect(first?.lines).toHaveLength(16);
  });

  it("reads an ANR with its reason", () => {
    const [entry, ...rest] = detect(fixture("anr"));
    expect(rest).toEqual([]);
    expect(entry?.crash).toMatchObject({ kind: "anr", appId: "com.example.app", signature: "anr|com.example.app" });
    expect(entry?.crash.title).toMatch(/^ANR in com\.example\.app: Input dispatching timed out/u);
    expect(entry?.crash.lines).toHaveLength(19);
  });

  it("joins a native tombstone to the signal line that came before it", () => {
    const found = detect(fixture("native-sigsegv")).map((entry) => entry.crash);
    expect(found).toHaveLength(2);
    const [signal, tombstone] = found;
    expect(signal).toMatchObject({
      kind: "native",
      appId: "com.example.app",
      title: "Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0000000000000008",
      frames: [],
    });
    expect(tombstone?.updates).toBe(signal?.signature);
    expect(tombstone?.title).toContain("(null pointer dereference)");
    expect(tombstone?.frames[0]).toMatch(/^#00 pc 00000000000a1b2c .*libimagefilter\.so/u);
    expect(tombstone?.frames[0]).not.toContain("BuildId");
  });

  it("reads a React Native JS error once, though AndroidRuntime repeats it", () => {
    const found = detect(fixture("rn-js-error"));
    expect(found).toHaveLength(1);
    expect(found[0]?.crash).toMatchObject({
      kind: "js-error",
      appId: "com.example.app",
      title: "TypeError: Cannot read property 'name' of undefined",
    });
    expect(found[0]?.crash.frames[0]).toBe("in ProfileHeader (at ProfileScreen.tsx:42)");
    expect(found[0]?.crash.lines).toHaveLength(24);
  });

  it("reads an uncaught iOS exception and its call stack", () => {
    const found = detect(fixture("ios-uncaught"));
    expect(found).toHaveLength(1);
    expect(found[0]?.crash).toMatchObject({
      kind: "ios-exception",
      appId: "ExampleApp",
      title:
        "NSInvalidArgumentException: -[__NSCFNumber length]: unrecognized selector sent to instance 0x8000000000000000",
    });
    expect(found[0]?.crash.frames).toHaveLength(8);
    expect(found[0]?.crash.signature).toContain("ProfileViewController updateName:");
    expect(found[0]?.crash.lines).toHaveLength(17);
  });

  it("finds nothing in a busy log without a crash", () => {
    const lines = fixture("noise-only");
    expect(detect(lines)).toEqual([]);
    expect(crashLineMarks(lines).some(Boolean)).toBe(false);
  });

  it("ends a block at a line from another tag more than 300 ms later", () => {
    const lines = [
      "11-01 10:00:00.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main",
      "11-01 10:00:00.001  100  100 E AndroidRuntime: Process: com.example.app, PID: 100",
      "11-01 10:00:00.002  100  100 E AndroidRuntime: java.lang.RuntimeException: boom",
      "11-01 10:00:00.003  100  100 E AndroidRuntime: \tat com.example.app.Main.run(Main.kt:1)",
      "11-01 10:00:00.100  200  200 I Other   : close enough to skip",
      "11-01 10:00:00.500  200  200 I Other   : far enough to end it",
    ];
    const found = detect(lines);
    expect(found.map((entry) => entry.at)).toEqual([6]);
    expect(found[0]?.crash.lines).toHaveLength(4);
    expect(crashLineMarks(lines)).toEqual([true, true, true, true, false, false]);
  });

  it("ends a block after 40 frames", () => {
    const head = [
      "11-01 10:00:00.000  100  100 E AndroidRuntime: FATAL EXCEPTION: main",
      "11-01 10:00:00.000  100  100 E AndroidRuntime: java.lang.StackOverflowError: stack size 8MB",
    ];
    const frames = Array.from(
      { length: 60 },
      (_, index) =>
        `11-01 10:00:00.001  100  100 E AndroidRuntime: \tat com.example.app.Loop.f${index}(Loop.kt:${index})`,
    );
    const found = detect([...head, ...frames]);
    expect(found[0]?.at).toBe(42);
    expect(found[0]?.crash.frames).toHaveLength(8);
  });

  it("shortens a title to the exception class without its package", () => {
    expect(shortCrashTitle("java.lang.IllegalStateException: Fragment not attached")).toBe(
      "IllegalStateException: Fragment not attached",
    );
    expect(shortCrashTitle("TypeError: x is undefined")).toBe("TypeError: x is undefined");
  });
});
