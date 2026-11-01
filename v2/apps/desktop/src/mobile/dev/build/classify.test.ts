import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyBuildLog, detectStack, stripAnsi } from "./classify.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.log`, import.meta.url), "utf8");

describe("build log classifier", () => {
  it.each([
    ["gradle-kotlin-metadata", "gradle", "version", 659, ":expo-modules-core:compileDebugKotlin"],
    ["gradle-unsupported-class-version", "gradle", "jdk-gradle", 40, undefined],
    ["gradle-duplicate-class", "gradle", "native-module", 818, ":app:checkDebugDuplicateClasses"],
    ["gradle-java-heap", "gradle", "memory", 486, ":app:mergeExtDexDebug"],
    ["eas-pods-incompatible", "eas", "cocoapods", 348, "INSTALL_PODS"],
    ["eas-config-plugin", "eas", "config-plugin", 230, "READ_APP_CONFIG"],
    ["xcode-no-signing", "xcode", "signing", 495, undefined],
    ["xcode-provisioning", "xcode", "signing", 397, undefined],
    ["rn-codegen-turbomodule", "gradle", "new-arch", 234, ":app:generateCodegenArtifactsFromSchema"],
    ["metro-unable-to-resolve", "metro", "native-module", 184, undefined],
    ["unknown-noise", "gradle", "unknown", 303, ":app:processDebugResources"],
  ] as const)("reads %s", (name, stack, category, lineNumber, phase) => {
    const text = fixture(name);
    const result = classifyBuildLog(text);
    expect(result).toMatchObject({ stack, category, phase });
    expect(result.firstError.lineNumber).toBe(lineNumber);
    expect(result.firstError.line).toBe(
      stripAnsi(text.split("\n")[lineNumber - 1] ?? "")
        .trim()
        .slice(0, 500),
    );
    expect(result.confidence).toBe(category === "unknown" ? "low" : "high");
  });

  it("keeps 20 lines on each side, without ANSI codes, and cuts long lines", () => {
    const result = classifyBuildLog(fixture("gradle-kotlin-metadata"));
    expect(result.firstError.context).toHaveLength(41);
    expect(result.firstError.context.join("\n")).not.toContain(`${String.fromCharCode(27)}[`);
    const xcode = classifyBuildLog(fixture("xcode-no-signing"));
    expect(Math.max(...xcode.firstError.context.map((line) => line.length))).toBeLessThanOrEqual(500);
  });

  it("knows the stack from its markers", () => {
    expect(detectStack(["> Task :app:compileDebugJavaWithJavac"])).toBe("gradle");
    expect(detectStack(["** BUILD FAILED **"])).toBe("xcode");
    expect(detectStack(["[RUN_GRADLEW] Running 'gradlew :app:assembleRelease'"])).toBe("eas");
    expect(detectStack(["error: Unable to resolve module ./Missing"])).toBe("metro");
    expect(detectStack(["hello"])).toBe("unknown");
  });

  it("falls back to the last line of a log with no error at all", () => {
    const result = classifyBuildLog("one\ntwo\nthree\n");
    expect(result).toMatchObject({ stack: "unknown", category: "unknown", confidence: "low" });
    expect(result.firstError).toMatchObject({ line: "three", lineNumber: 3 });
  });

  it("is medium confidence when it knows the class but not the stack", () => {
    expect(classifyBuildLog("java.lang.OutOfMemoryError: Java heap space").confidence).toBe("medium");
  });
});
