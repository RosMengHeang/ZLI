import type { MobileLicense, MobileSetupStep } from "@zli-v2/contracts";

import type { HostArch, HostOs } from "./host.js";

export const ANDROID_REPOSITORY_BASE = "https://dl.google.com/android/repository/";
export const ANDROID_REPOSITORY_URL = `${ANDROID_REPOSITORY_BASE}repository2-1.xml`;
export const GOOGLE_APIS_SYSTEM_IMAGES_URL = `${ANDROID_REPOSITORY_BASE}sys-img/google_apis/sys-img2-1.xml`;

/** API 35 is the newest level with Google APIs images for both x86_64 and arm64 hosts. */
export const DEFAULT_SYSTEM_IMAGE_API = 35;
export const DEFAULT_AVD_NAME = "ZLI_Pixel_API_35";
export const DEFAULT_AVD_DEVICE = "pixel_7";

export type RepositoryArchive = {
  readonly url: string;
  readonly size: number;
  /** SHA-1, the only checksum the repository publishes. */
  readonly sha1: string;
  readonly hostOs?: string;
  readonly hostArch?: string;
};

export type RepositoryPackage = {
  readonly path: string;
  readonly displayName: string;
  readonly revision: string;
  readonly channel: string;
  readonly licenseIds: readonly string[];
  readonly archives: readonly RepositoryArchive[];
};

export type Repository = {
  readonly packages: readonly RepositoryPackage[];
  readonly licenses: ReadonlyMap<string, string>;
};

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name] ?? entity;
  });
}

function element(source: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "u").exec(source);
  return match?.[1] === undefined ? undefined : decodeXml(match[1].trim());
}

/**
 * Reads the Android SDK repository manifest (repository2-1.xml and the sys-img manifests). Their layout has
 * been stable for years, so a small reader of the elements ZLI needs avoids shipping an XML parser.
 */
export function parseRepository(xml: string): Repository {
  const licenses = new Map<string, string>();
  for (const match of xml.matchAll(/<license\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/license>/gu)) {
    if (match[1] && match[2] !== undefined) licenses.set(match[1], decodeXml(match[2]).trim());
  }
  const channels = new Map<string, string>();
  for (const match of xml.matchAll(/<channel\s+id="([^"]+)"[^>]*>([^<]*)<\/channel>/gu)) {
    if (match[1] && match[2] !== undefined) channels.set(match[1], match[2].trim());
  }
  const packages: RepositoryPackage[] = [];
  for (const match of xml.matchAll(/<remotePackage\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/gu)) {
    const [, path, body = ""] = match;
    if (!path) continue;
    const revisionBlock = element(body, "revision") ?? "";
    const revision = ["major", "minor", "micro"]
      .map((part) => element(revisionBlock, part))
      .filter((part): part is string => part !== undefined)
      .join(".");
    const channelRef = /<channelRef\s+ref="([^"]+)"/u.exec(body)?.[1] ?? "channel-0";
    const licenseIds = [...body.matchAll(/<uses-license\s+ref="([^"]+)"/gu)].flatMap((entry) =>
      entry[1] ? [entry[1]] : [],
    );
    const archives: RepositoryArchive[] = [];
    for (const archive of body.matchAll(/<archive>([\s\S]*?)<\/archive>/gu)) {
      const archiveBody = archive[1] ?? "";
      const complete = element(archiveBody, "complete");
      if (!complete) continue;
      const url = element(complete, "url");
      const sha1 = element(complete, "checksum");
      const size = Number(element(complete, "size"));
      if (!url || !sha1 || !Number.isFinite(size)) continue;
      const hostOs = element(archiveBody, "host-os");
      const hostArch = element(archiveBody, "host-arch");
      archives.push({
        url,
        sha1: sha1.toLowerCase(),
        size,
        ...(hostOs ? { hostOs } : {}),
        ...(hostArch ? { hostArch } : {}),
      });
    }
    packages.push({
      path: decodeXml(path),
      displayName: element(body, "display-name") ?? path,
      revision,
      channel: channels.get(channelRef) ?? channelRef,
      licenseIds,
      archives,
    });
  }
  return { packages, licenses };
}

export function repositoryHostOs(os: HostOs): string {
  return os === "macos" ? "macosx" : os;
}

/** The stable package for this host, or undefined when the repository has none. */
export function findPackage(repository: Repository, path: string): RepositoryPackage | undefined {
  return repository.packages.find((entry) => entry.path === path && entry.channel === "stable");
}

export function archiveFor(pkg: RepositoryPackage, os: HostOs, arch: HostArch): RepositoryArchive | undefined {
  const wantedOs = repositoryHostOs(os);
  const wantedArch = arch === "arm64" ? "aarch64" : "x64";
  const forOs = pkg.archives.filter((archive) => archive.hostOs === undefined || archive.hostOs === wantedOs);
  return (
    forOs.find((archive) => archive.hostArch === wantedArch) ??
    forOs.find((archive) => archive.hostArch === undefined) ??
    undefined
  );
}

export function archiveUrl(archive: RepositoryArchive, base = ANDROID_REPOSITORY_BASE): string {
  return /^https:\/\//u.test(archive.url) ? archive.url : new URL(archive.url, base).toString();
}

/** arm64 Macs and Linux boards run arm64 images natively; everything else runs x86_64 images. */
export function systemImagePackage(arch: HostArch, api = DEFAULT_SYSTEM_IMAGE_API): string {
  return `system-images;android-${api};google_apis;${arch === "arm64" ? "arm64-v8a" : "x86_64"}`;
}

export const TEMURIN_LICENSE_ID = "temurin-gpl2-classpath";

export const TEMURIN_LICENSE_TEXT = [
  "Eclipse Temurin 17 (a build of OpenJDK) is distributed by the Eclipse Foundation's Adoptium project under",
  "the GNU General Public License, version 2, with the Classpath Exception.",
  "",
  "ZLI downloads it from api.adoptium.net only to run the Android SDK command-line tools, which need Java 17",
  "or newer. It is stored in ZLI's own data folder and is not added to your PATH.",
  "",
  "Full license: https://openjdk.org/legal/gplv2+ce.html",
].join("\n");

const LICENSE_TITLES: Record<string, string> = {
  "android-sdk-license": "Android Software Development Kit License Agreement",
  "android-sdk-preview-license": "Android SDK Preview License Agreement",
  "android-sdk-arm-dbt-license": "Android SDK License for ARM system images",
  [TEMURIN_LICENSE_ID]: "Eclipse Temurin (OpenJDK) license",
};

export type AndroidSetupNeeds = {
  readonly cmdlineTools: boolean;
  readonly java: boolean;
  readonly platformTools: boolean;
  readonly emulator: boolean;
  readonly systemImage: boolean;
  readonly avd: boolean;
};

export type JavaDownload = {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly name: string;
};

export type AndroidSetupPlanDetails = {
  readonly steps: MobileSetupStep[];
  readonly licenses: MobileLicense[];
  readonly systemImage: string;
  readonly cmdlineTools?: RepositoryArchive;
  readonly java?: JavaDownload;
  /** sdkmanager packages to install, in order. */
  readonly sdkPackages: string[];
};

/**
 * Works out what to install and which licenses cover it. The licenses are the union of every package's
 * uses-license, read from the manifest at plan time, so a license Google adds later is shown too.
 */
export function planAndroidSetup(input: {
  readonly os: HostOs;
  readonly arch: HostArch;
  readonly needs: AndroidSetupNeeds;
  readonly repository: Repository;
  readonly systemImages: Repository;
  readonly java?: JavaDownload;
}): AndroidSetupPlanDetails {
  const { os, arch, needs, repository } = input;
  const systemImage = systemImagePackage(arch);
  const steps: MobileSetupStep[] = [];
  const licenseIds = new Set<string>();
  const require = (pkg: RepositoryPackage | undefined, path: string) => {
    if (!pkg) throw new Error(`The Android repository no longer lists ${path}. Update ZLI and try again.`);
    for (const id of pkg.licenseIds) licenseIds.add(id);
    return pkg;
  };

  let cmdlineTools: RepositoryArchive | undefined;
  if (needs.java) {
    if (!input.java) throw new Error("No Java 17 runtime is available to download for this computer.");
    steps.push({ id: "java", label: "Eclipse Temurin 17 Java runtime", bytes: input.java.size });
    licenseIds.add(TEMURIN_LICENSE_ID);
  }
  if (needs.cmdlineTools) {
    const pkg = require(findPackage(repository, "cmdline-tools;latest"), "cmdline-tools;latest");
    cmdlineTools = archiveFor(pkg, os, arch);
    if (!cmdlineTools) throw new Error("The Android command-line tools are not published for this computer.");
    steps.push({ id: "cmdline-tools;latest", label: `${pkg.displayName} ${pkg.revision}`, bytes: cmdlineTools.size });
  }
  const sdkPackages: string[] = [];
  const addSdkPackage = (path: string, wanted: boolean, source: Repository) => {
    if (!wanted) return;
    const pkg = require(findPackage(source, path), path);
    const archive = archiveFor(pkg, os, arch);
    sdkPackages.push(path);
    steps.push({ id: path, label: `${pkg.displayName} ${pkg.revision}`, ...(archive ? { bytes: archive.size } : {}) });
  };
  addSdkPackage("platform-tools", needs.platformTools, repository);
  addSdkPackage("emulator", needs.emulator, repository);
  addSdkPackage(systemImage, needs.systemImage, input.systemImages);
  if (needs.avd) steps.push({ id: "avd", label: `Virtual device ${DEFAULT_AVD_NAME.replaceAll("_", " ")}` });

  const licenses: MobileLicense[] = [...licenseIds].sort().map((id) => {
    const text =
      id === TEMURIN_LICENSE_ID
        ? TEMURIN_LICENSE_TEXT
        : (repository.licenses.get(id) ?? input.systemImages.licenses.get(id));
    if (text === undefined) throw new Error(`The Android repository does not include the text of license ${id}.`);
    return { id, title: LICENSE_TITLES[id] ?? id, text };
  });
  return {
    steps,
    licenses,
    systemImage,
    ...(cmdlineTools ? { cmdlineTools } : {}),
    ...(needs.java && input.java ? { java: input.java } : {}),
    sdkPackages,
  };
}

/** Reads the Adoptium API answer for the latest Temurin 17 JRE. */
export function parseAdoptiumRelease(value: unknown): JavaDownload {
  const first = Array.isArray(value) ? value[0] : undefined;
  const pkg = (first as { binary?: { package?: Record<string, unknown> } } | undefined)?.binary?.package;
  const link = pkg?.link;
  const checksum = pkg?.checksum;
  const size = pkg?.size;
  const name = pkg?.name;
  if (typeof link !== "string" || !link.startsWith("https://"))
    throw new Error("Adoptium did not return a download link.");
  if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/iu.test(checksum))
    throw new Error("Adoptium did not return a SHA-256 checksum.");
  return {
    url: link,
    sha256: checksum.toLowerCase(),
    size: typeof size === "number" ? size : 0,
    name: typeof name === "string" ? name : "temurin-jre17",
  };
}

export function adoptiumReleaseUrl(os: HostOs, arch: HostArch): string {
  const query = new URLSearchParams({
    architecture: arch === "arm64" ? "aarch64" : "x64",
    image_type: "jre",
    os: os === "macos" ? "mac" : os,
    vendor: "eclipse",
  });
  return `https://api.adoptium.net/v3/assets/latest/17/hotspot?${query.toString()}`;
}
