// Writes the pull request comment for the phone preview workflow to stdout.
//
// SHOTS_DIR holds one folder per artifact, preview-<ios|android>-<base|head>, as download-artifact
// leaves them. MEDIA_URL is where the same folders are published, so the images render in the comment.
import { existsSync } from "node:fs";
import { join } from "node:path";

const MARKER = "<!-- zli-mobile-preview -->";

const screens = [
  ["home", "Home"],
  ["approval", "Approval"],
  ["agent", "Agent chat"],
  ["start", "Start an agent"],
  ["terminal", "Terminal"],
  ["settings", "Settings"],
  ["pair", "Pair"],
];

const platforms = [
  {
    id: "ios",
    title: "iPhone",
    device: "iPhone 17 simulator",
    live: [
      ["lock", "Lock screen"],
      ["island", "Dynamic Island"],
      ["island-expanded", "Dynamic Island, expanded"],
    ],
  },
  {
    id: "android",
    title: "Android",
    device: "Android 16 emulator",
    live: [
      ["chip", "Status bar"],
      ["shade", "Notification shade"],
      ["lock", "Lock screen"],
    ],
  },
];

const env = process.env;
const shotsDir = env.SHOTS_DIR ?? "shots";
const mediaUrl = (env.MEDIA_URL ?? "").replace(/\/$/u, "");
const compare = env.COMPARE === "1";
const short = (sha) => (sha ?? "").slice(0, 7);

function image(platform, side, name, alt) {
  const file = `preview-${platform}-${side}/${name}.png`;
  if (!existsSync(join(shotsDir, file))) return "Not captured";
  return `<img src="${mediaUrl}/${file}" width="220" alt="${alt}">`;
}

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function screensTable(platform, theme) {
  if (compare) {
    return table(
      ["Screen", "Before", "After"],
      screens.map(([name, label]) => [
        label,
        image(platform, "base", `${name}-${theme}`, `${label}, before`),
        image(platform, "head", `${name}-${theme}`, `${label}, after`),
      ]),
    );
  }
  return table(
    ["Screen", "Light", "Dark"],
    screens.map(([name, label]) => [
      label,
      image(platform, "head", `${name}-light`, `${label}, light`),
      image(platform, "head", `${name}-dark`, `${label}, dark`),
    ]),
  );
}

function section(platform) {
  const result = env[`${platform.id.toUpperCase()}_RESULT`] ?? "unknown";
  const parts = [`### ${platform.title}`];
  if (result !== "success") {
    parts.push(
      `The ${platform.title} job ended with \`${result}\`. Whatever it captured is below; the run has the logs.`,
    );
  }
  if (compare) {
    parts.push("Light appearance, before and after this pull request.", screensTable(platform.id, "light"));
    parts.push(`<details><summary>Dark appearance</summary>\n\n${screensTable(platform.id, "dark")}\n\n</details>`);
  } else {
    parts.push(screensTable(platform.id));
  }
  parts.push(
    `**Live status** on the ${platform.device}, with this pull request.`,
    table(
      ["", "Light", "Dark"],
      platform.live.map(([name, label]) => [
        label,
        image(platform.id, "head", `${name}-light`, `${label}, light`),
        image(platform.id, "head", `${name}-dark`, `${label}, dark`),
      ]),
    ),
  );
  return parts.join("\n\n");
}

const intro = [
  "## Phone preview",
  `ZLI Remote built from ${short(env.HEAD_SHA)} in demo mode, on an iPhone 17 simulator and an Android 16 emulator. ` +
    "The data comes from the demo desktop in `v2/apps/mobile/src/lib/demoDesktop.ts`, not a real one.",
  compare ? `Before is the base, ${short(env.BASE_SHA)}.` : "",
  env.RUN_URL ? `[Workflow run, with the screenshots and logs as artifacts](${env.RUN_URL})` : "",
].filter(Boolean);

process.stdout.write(`${MARKER}\n${[...intro, ...platforms.map(section)].join("\n\n")}\n`);
