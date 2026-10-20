import type { SVGProps } from "react";

/** Monochrome glyphs that tell agents apart at a glance. Claude keeps its coral starburst. */
export function ProviderMark({
  provider,
  size = 16,
  ...rest
}: { provider: string; size?: number } & SVGProps<SVGSVGElement>) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    focusable: false,
    className: `provider-mark provider-mark-${provider}`,
    ...rest,
  } as const;
  switch (provider) {
    case "claude-code":
      return (
        <svg aria-hidden="true" {...common} fill="none" stroke="#d97757" strokeWidth={2.2} strokeLinecap="round">
          <path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M5.6 18.4l3.5-3.5M14.9 9.1l3.5-3.5" />
        </svg>
      );
    case "cursor-agent":
      return (
        <svg aria-hidden="true" {...common} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
          <path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4Z" />
          <path d="M4 7.4 12 12l8-4.6M12 12v9.2" />
        </svg>
      );
    case "codex":
      return (
        <svg
          aria-hidden="true"
          {...common}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="4" />
          <path d="m8 10 2.5 2L8 14M13 14h3" />
        </svg>
      );
    case "droid":
      return (
        <svg
          aria-hidden="true"
          {...common}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v3" />
          <rect x="4" y="6" width="16" height="13" rx="4" />
          <path d="M9 12v1.5M15 12v1.5" />
        </svg>
      );
    case "opencode":
      return (
        <svg aria-hidden="true" {...common} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
        </svg>
      );
    case "gemini":
      return (
        <svg aria-hidden="true" {...common} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
          <path d="M12 3c.7 4.6 3.4 7.3 9 9-5.6 1.7-8.3 4.4-9 9-.7-4.6-3.4-7.3-9-9 5.6-1.7 8.3-4.4 9-9Z" />
        </svg>
      );
    case "copilot":
      return (
        <svg
          aria-hidden="true"
          {...common}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 12.5v3.5c0 2.2 3.6 4 8 4s8-1.8 8-4v-3.5" />
          <circle cx="8.5" cy="9.5" r="3.5" />
          <circle cx="15.5" cy="9.5" r="3.5" />
          <path d="M10 15.5v1.5M14 15.5v1.5" />
        </svg>
      );
    case "kimi":
      return (
        <svg
          aria-hidden="true"
          {...common}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
          <path d="M9 7.5v9M15.5 7.5 9 12l6.5 4.5" />
        </svg>
      );
    case "qwen":
      return (
        <svg aria-hidden="true" {...common} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
          <path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4Z" />
          <path d="M12 8.2 15.4 14H8.6Z" />
        </svg>
      );
    case "goose":
      return (
        <svg
          aria-hidden="true"
          {...common}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 13V7.5a3 3 0 0 1 6 0" />
          <path d="M20 7.5h1.5" />
          <path d="M14 13c0 4-2.7 7-7 7H4c0-4.5 3.5-8 10-7Z" />
        </svg>
      );
    default:
      return (
        <svg aria-hidden="true" {...common} fill="none" stroke="currentColor" strokeWidth={1.7}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}
