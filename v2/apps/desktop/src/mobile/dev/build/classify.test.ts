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

  it("does not read normal codegen output or a CocoaPods warning as the failure", () => {
    const log = [
      "> Task :app:generateCodegenSchemaFromJavaScript",
      "[Codegen] Found codegenConfig in node_modules/react-native-fs/package.json",
      "[Codegen] Processing react-native-fs",
      "[!] Your project does not explicitly specify a Swift version for the 'App' target.",
      "** BUILD FAILED **",
      "The following build commands failed:",
    ].join("\n");
    const result = classifyBuildLog(log);
    expect(result).toMatchObject({ stack: "gradle", category: "unknown" });
  });

  it("reads the signing error below a CocoaPods warning, not the warning", () => {
    const log = [
      "[!] The `App` target overrides the `ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES` build setting.",
      'No signing certificate "iOS Development" found: No signing certificate matching the identity was found.',
    ].join("\n");
    expect(classifyBuildLog(log).category).toBe("signing");
  });

  it("does not read a MaxMetaspaceSize flag as out of memory", () => {
    const log = [
      "> Task :app:compileJava",
      "Daemon JVM options: -XX:MaxMetaspaceSize=512m",
      "FAILURE: Build failed with an exception.",
    ].join("\n");
    expect(classifyBuildLog(log).category).toBe("unknown");
  });

  it("cuts a very long line before matching, so one minified line cannot stall it", () => {
    const huge = `TurboModuleRegistry${"x".repeat(2_000_000)}`;
    const result = classifyBuildLog(`${huge}\nFAILURE: Build failed\nerror: boom`);
    expect(result.category).toBe("unknown");
    expect(result.firstError.line).toBe("FAILURE: Build failed");
  });

  it("is medium confidence when it knows the class but not the stack", () => {
    expect(classifyBuildLog("java.lang.OutOfMemoryError: Java heap space").confidence).toBe("medium");
  });
});
