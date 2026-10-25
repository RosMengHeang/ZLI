import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adoptiumReleaseUrl,
  archiveFor,
  archiveUrl,
  findPackage,
  parseAdoptiumRelease,
  parseRepository,
  planAndroidSetup,
  systemImagePackage,
  TEMURIN_LICENSE_ID,
} from "./AndroidRepository.js";

const fixtures = join(import.meta.dirname, "fixtures");
const repository = parseRepository(readFileSync(join(fixtures, "repository2-1.xml"), "utf8"));
const systemImages = parseRepository(readFileSync(join(fixtures, "sys-img2-1.xml"), "utf8"));
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const allNeeds = { cmdlineTools: true, java: false, platformTools: true, emulator: true, systemImage: true, avd: true };

describe("Android repository manifest", () => {
  it("reads packages, channels, licenses, and per-host archives", () => {
    const tools = required(findPackage(repository, "cmdline-tools;latest"));
    expect(tools.revision).toBe("23.0");
    expect(tools.licenseIds).toEqual(["android-sdk-license"]);
    expect(archiveFor(tools, "linux", "x64")).toEqual({
      url: "commandlinetools-linux-16111833_latest.zip",
      sha1: "e025545c62a8e64c7559119566a569fb1dec5f60",
      size: 181052239,
      hostOs: "linux",
    });
    expect(archiveFor(tools, "macos", "arm64")?.sha1).toBe("112cf9618794a997ff273537d55bee02c22abffe");
    expect(archiveFor(tools, "windows", "x64")?.url).toBe("commandlinetools-win-16111833_latest.zip");
    expect(repository.licenses.get("android-sdk-license")).toMatch(/^Terms and Conditions/u);
  });

  it("prefers the stable channel when a package is listed in several", () => {
    const emulators = repository.packages.filter((entry) => entry.path === "emulator");
    expect(emulators.length).toBeGreaterThan(1);
    expect(findPackage(repository, "emulator")?.channel).toBe("stable");
  });

  it("resolves relative archive URLs against the repository", () => {
    const archive = required(archiveFor(required(findPackage(repository, "platform-tools")), "linux", "x64"));
    expect(archiveUrl(archive)).toMatch(
      /^https:\/\/dl\.google\.com\/android\/repository\/platform-tools_r[\d.]+-linux\.zip$/u,
    );
  });
});

describe("Android setup plan", () => {
  it("lists every step and the union of the licenses they use", () => {
    const plan = planAndroidSetup({ os: "linux", arch: "x64", needs: allNeeds, repository, systemImages });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "cmdline-tools;latest",
      "platform-tools",
      "emulator",
      "system-images;android-35;google_apis;x86_64",
      "avd",
    ]);
    expect(plan.licenses.map((license) => license.id)).toEqual(["android-sdk-license"]);
    expect(plan.sdkPackages).toEqual(["platform-tools", "emulator", "system-images;android-35;google_apis;x86_64"]);
    expect(plan.cmdlineTools?.sha1).toBe("e025545c62a8e64c7559119566a569fb1dec5f60");
  });

  it("shows the ARM system image license on arm64 hosts", () => {
    const plan = planAndroidSetup({ os: "macos", arch: "arm64", needs: allNeeds, repository, systemImages });
    expect(plan.systemImage).toBe("system-images;android-35;google_apis;arm64-v8a");
    expect(plan.licenses.map((license) => license.id)).toEqual(["android-sdk-arm-dbt-license", "android-sdk-license"]);
    expect(plan.licenses[0]?.text.length).toBeGreaterThan(10);
  });

  it("adds the Temurin license and download when Java is needed", () => {
    const java = {
      url: "https://github.com/adoptium/jre.tar.gz",
      sha256: "a".repeat(64),
      size: 45,
      name: "jre.tar.gz",
    };
    const plan = planAndroidSetup({
      os: "linux",
      arch: "x64",
      needs: { ...allNeeds, java: true },
      repository,
      systemImages,
      java,
    });
    expect(plan.steps[0]).toEqual({ id: "java", label: "Eclipse Temurin 17 Java runtime", bytes: 45 });
    expect(plan.licenses.map((license) => license.id)).toContain(TEMURIN_LICENSE_ID);
    expect(plan.java).toEqual(java);
  });

  it("plans nothing when everything is installed", () => {
    const none = {
      cmdlineTools: false,
      java: false,
      platformTools: false,
      emulator: false,
      systemImage: false,
      avd: false,
    };
    const plan = planAndroidSetup({ os: "linux", arch: "x64", needs: none, repository, systemImages });
    expect(plan.steps).toEqual([]);
    expect(plan.licenses).toEqual([]);
  });

  it("names the system image for each host architecture", () => {
    expect(systemImagePackage("x64")).toBe("system-images;android-35;google_apis;x86_64");
    expect(systemImagePackage("arm64")).toBe("system-images;android-35;google_apis;arm64-v8a");
  });
});

describe("Adoptium release lookup", () => {
  it("builds the query and reads the package", () => {
    expect(adoptiumReleaseUrl("macos", "arm64")).toBe(
      "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=aarch64&image_type=jre&os=mac&vendor=eclipse",
    );
    const release = parseAdoptiumRelease([
      {
        binary: {
          package: {
            link: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.17%2B10/OpenJDK17U-jre_x64_linux_hotspot_17.0.17_10.tar.gz",
            checksum: "B".repeat(64),
            size: 47_000_000,
            name: "OpenJDK17U-jre_x64_linux_hotspot_17.0.17_10.tar.gz",
          },
        },
      },
    ]);
    expect(release.sha256).toBe("b".repeat(64));
    expect(release.name).toBe("OpenJDK17U-jre_x64_linux_hotspot_17.0.17_10.tar.gz");
  });

  it("refuses answers without an HTTPS link or a SHA-256", () => {
    expect(() =>
      parseAdoptiumRelease([{ binary: { package: { link: "http://x", checksum: "a".repeat(64) } } }]),
    ).toThrow();
    expect(() => parseAdoptiumRelease([{ binary: { package: { link: "https://x", checksum: "abc" } } }])).toThrow();
    expect(() => parseAdoptiumRelease([])).toThrow();
  });
});
