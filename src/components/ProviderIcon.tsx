import type { CSSProperties } from "react";
import { canonicalProviderId } from "../lib/providerPresentation";

/** Simple Icons (CC0) and official public brand marks, rendered at a consistent size. */
const ANTHROPIC =
  "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";

const OPENAI =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const GEMINI =
  "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81";

const CURSOR =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";

interface Tile {
  bg: string;
  fg: string;
  label: string;
}

const TILES: Record<string, Tile> = {
  "claude-code": { bg: "#1a1714", fg: "#f3e6d8", label: "Anthropic Claude" },
  claude: { bg: "#1a1714", fg: "#f3e6d8", label: "Anthropic Claude" },
  codex: { bg: "#111111", fg: "#f4f4f4", label: "OpenAI Codex" },
  "cursor-agent": { bg: "#0a0a0a", fg: "#f5f5f5", label: "Cursor" },
  cursor: { bg: "#0a0a0a", fg: "#f5f5f5", label: "Cursor" },
  opencode: { bg: "#131010", fg: "#f7f4f0", label: "OpenCode" },
  gemini: { bg: "#1b1528", fg: "#c4b5e8", label: "Google Gemini" },
  aider: { bg: "#9a3412", fg: "#fff7ed", label: "Aider" },
  goose: { bg: "#102016", fg: "#3ecc5f", label: "Goose" },
  shell: { bg: "#141a14", fg: "#7dce55", label: "Terminal" },
};

const FALLBACK_TILE: Tile = { bg: "#21262d", fg: "#93c5fd", label: "Provider" };

type IconSize = "sm" | "md" | "lg";

const SIZE_PX: Record<IconSize, number> = { sm: 24, md: 24, lg: 24 };

interface ProviderIconProps {
  provider: string;
  size?: IconSize;
  className?: string;
}

function MonoPath({ d, title }: { d: string; title: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[62%] w-[62%]">
      <title>{title}</title>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

function OpenCodeMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[68%] w-[68%]">
      <title>OpenCode</title>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M19.5 20.5H4.5V3.5h15v17Zm-3.2-13H7.7v10.2h8.6V7.5Z"
        clipRule="evenodd"
      />
      <path fill="currentColor" opacity="0.45" d="M15.5 10.2v6.4H8.5v-6.4h7Z" />
    </svg>
  );
}

function AiderMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[68%] w-[68%]">
      <title>Aider</title>
      <path
        fill="currentColor"
        d="M12 3.2 4.8 19h3.15l1.28-2.9h5.54L15.99 19H19.2L12 3.2Zm0 5.15 2.02 4.65H9.98L12 8.35Z"
      />
    </svg>
  );
}

function GooseMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[78%] w-[78%]">
      <title>Goose</title>
      <ellipse cx="9.4" cy="15.2" rx="6.4" ry="5" fill="#3ECC5F" />
      <path
        d="M13.2 14.2c2.6-.6 5.2-3.1 5.4-6.2.2-2.2-1.3-3.8-3.3-3.5-1.7.3-2.6 1.9-2.8 3.6"
        fill="#3ECC5F"
      />
      <circle cx="16.9" cy="6.3" r="2.35" fill="#3ECC5F" />
      <circle cx="17.55" cy="5.85" r="0.55" fill="#102016" />
      <path d="M19 6.15 22.4 7.05 19 8.05Z" fill="#FFFF50" />
    </svg>
  );
}

function ShellMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[68%] w-[68%]">
      <title>Terminal</title>
      <path
        fill="currentColor"
        d="M5.2 6.4h13.6A1.8 1.8 0 0 1 20.6 8.2v7.6a1.8 1.8 0 0 1-1.8 1.8H5.2A1.8 1.8 0 0 1 3.4 15.8V8.2A1.8 1.8 0 0 1 5.2 6.4Zm2.3 3.05 2.35 1.75-2.35 1.75.9 1.2 3.7-2.75a.9.9 0 0 0 0-1.5L8.4 8.25l-.9 1.2Zm5.1 5.35h4.4v1.4h-4.4v-1.4Z"
      />
    </svg>
  );
}

function FallbackMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[64%] w-[64%]">
      <title>Unknown provider</title>
      <path
        fill="currentColor"
        d="M7 4.5h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Zm1.7 4.2v1.5h6.6V8.7H8.7Zm0 3.4v1.5h4.4v-1.5H8.7Z"
      />
    </svg>
  );
}

function markFor(id: string) {
  switch (id) {
    case "claude-code":
    case "claude":
      return <MonoPath d={ANTHROPIC} title="Anthropic" />;
    case "codex":
      return <MonoPath d={OPENAI} title="OpenAI" />;
    case "gemini":
      return <MonoPath d={GEMINI} title="Google Gemini" />;
    case "cursor-agent":
    case "cursor":
      return <MonoPath d={CURSOR} title="Cursor" />;
    case "opencode":
      return <OpenCodeMark />;
    case "aider":
      return <AiderMark />;
    case "goose":
      return <GooseMark />;
    case "shell":
      return <ShellMark />;
    default:
      return <FallbackMark />;
  }
}

export function ProviderIcon({ provider, size = "md", className = "" }: ProviderIconProps) {
  const id = canonicalProviderId(provider);
  const tile = TILES[id] ?? FALLBACK_TILE;
  const px = SIZE_PX[size];
  const style: CSSProperties = {
    width: px,
    height: px,
    background: tile.bg,
    color: tile.fg,
  };

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] ${className}`}
      style={style}
      role="img"
      aria-label={tile.label}
      title={tile.label}
    >
      {markFor(id)}
    </span>
  );
}
