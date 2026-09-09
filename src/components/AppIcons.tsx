import type { ReactNode } from "react";
import { Folder, FolderOpen } from "lucide-react";

interface IconProps {
  className?: string;
  title?: string;
}

function Svg({
  className,
  title,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden={title ? undefined : true}
      className={className ?? "h-3.5 w-3.5"}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function TaxzyMark({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <title>Taxzy</title>
      <path d="M16 2.1 28.4 9.1v13.8L16 29.9 3.6 22.9V9.1L16 2.1Z" fill="#2563EB" />
      <path d="M11.8 10.15h8.4v1.95h-3.2V21.9h-2V12.1h-3.2v-1.95Z" fill="#ffffff" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3.2v9.6M3.2 8h9.6" {...stroke} />
    </Svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Folder
      className={props.className ?? "h-3.5 w-3.5"}
      strokeWidth={1.5}
      aria-hidden={props.title ? undefined : true}
      aria-label={props.title}
    />
  );
}

export function IconGit(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="3.6" r="1.5" {...stroke} />
      <circle cx="4.2" cy="12.2" r="1.5" {...stroke} />
      <circle cx="11.8" cy="12.2" r="1.5" {...stroke} />
      <path d="M8 5.2v5.4M8 8.4 4.8 11M8 8.4l3.2 2.6" {...stroke} />
    </Svg>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.6" y="3.2" width="12.8" height="9.6" rx="1.4" {...stroke} />
      <path d="M4.2 6.4 6.6 8 4.2 9.6M8.2 10.4h3.4" {...stroke} />
    </Svg>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.4" {...stroke} />
      <path d="M2.6 8h10.8M8 2.6c1.6 1.8 2.4 3.6 2.4 5.4S9.6 11.6 8 13.4C6.4 11.6 5.6 9.8 5.6 8S6.4 4.4 8 2.6Z" {...stroke} />
    </Svg>
  );
}

export function IconSplitRight(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.3" {...stroke} />
      <path d="M8 3v10" {...stroke} />
    </Svg>
  );
}

export function IconSplitDown(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.3" {...stroke} />
      <path d="M2 8h12" {...stroke} />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" {...stroke} />
    </Svg>
  );
}

export function IconFolderOpen(props: IconProps) {
  return (
    <FolderOpen
      className={props.className ?? "h-3.5 w-3.5"}
      strokeWidth={1.5}
      aria-hidden={props.title ? undefined : true}
      aria-label={props.title}
    />
  );
}

export function IconSidebar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.2" y="2.7" width="11.6" height="10.6" rx="1.8" {...stroke} />
      <path d="M6.1 2.9v10.2" {...stroke} />
    </Svg>
  );
}

export function IconMaximize(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 2.8H2.8v3.4M9.8 2.8h3.4v3.4M6.2 13.2H2.8V9.8M9.8 13.2h3.4V9.8" {...stroke} />
    </Svg>
  );
}

export function IconMinimize(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.8 6.2h3.4V2.8M13.2 6.2H9.8V2.8M2.8 9.8h3.4v3.4M13.2 9.8H9.8v3.4" {...stroke} />
    </Svg>
  );
}

export function IconBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.6 3.6 4.4 8l5.2 4.4" {...stroke} />
    </Svg>
  );
}

export function IconForward(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.4 3.6 11.6 8 6.4 12.4" {...stroke} />
    </Svg>
  );
}

export function IconReload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.6 8A4.6 4.6 0 1 1 11.2 4.2" {...stroke} />
      <path d="M11.1 2.4v2.6h2.6" {...stroke} />
    </Svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 3.4H3.8A1.4 1.4 0 0 0 2.4 4.8v7.4A1.4 1.4 0 0 0 3.8 13.6h7.4a1.4 1.4 0 0 0 1.4-1.4V9.6" {...stroke} />
      <path d="M9.2 2.8h4v4M13.2 2.8 7.4 8.6" {...stroke} />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.4 8.2 6.6 11.4 12.6 4.6" {...stroke} />
    </Svg>
  );
}

export function IconAgents(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.2" cy="5.4" r="2" {...stroke} />
      <circle cx="10.8" cy="5.4" r="2" {...stroke} />
      <path d="M2.4 12.6c.4-1.8 1.6-2.7 2.8-2.7s2.4.9 2.8 2.7M8 12.6c.4-1.8 1.6-2.7 2.8-2.7s2.4.9 2.8 2.7" {...stroke} />
    </Svg>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.6 7.4 8 2.8l5.4 4.6V13.4A1.2 1.2 0 0 1 12.2 14.6H3.8A1.2 1.2 0 0 1 2.6 13.4V7.4Z" {...stroke} />
      <path d="M6.2 14.4V9.6h3.6v4.8" {...stroke} />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.4" {...stroke} />
      <path d="M8 5.2V8l2.1 1.4" {...stroke} />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1" {...stroke} />
      <rect x="9" y="2.4" width="4.6" height="4.6" rx="1" {...stroke} />
      <rect x="2.4" y="9" width="4.6" height="4.6" rx="1" {...stroke} />
      <rect x="9" y="9" width="4.6" height="4.6" rx="1" {...stroke} />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.2" {...stroke} />
      <path d="M8 2.6v1.5M8 11.9v1.5M2.6 8h1.5M11.9 8h1.5M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M11.9 4.1l-1.1 1.1M5.2 10.8l-1.1 1.1" {...stroke} />
    </Svg>
  );
}

export function IconHelp(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.4" {...stroke} />
      <path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 2.1c-.6.3-.9.7-.9 1.3" {...stroke} />
      <path d="M8 11.6h.01" {...stroke} />
    </Svg>
  );
}

export function IconGrip(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.4" cy="4.2" r="0.85" fill="currentColor" />
      <circle cx="10.6" cy="4.2" r="0.85" fill="currentColor" />
      <circle cx="5.4" cy="8" r="0.85" fill="currentColor" />
      <circle cx="10.6" cy="8" r="0.85" fill="currentColor" />
      <circle cx="5.4" cy="11.8" r="0.85" fill="currentColor" />
      <circle cx="10.6" cy="11.8" r="0.85" fill="currentColor" />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.2 4.6h9.6M6.2 4.6V3.4h3.6v1.2M5 4.6l.6 8.2h4.8L11 4.6" {...stroke} />
    </Svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.4" {...stroke} />
      <path d="M8 7.3V12" {...stroke} />
      <path d="M8 5.2h.01" {...stroke} />
    </Svg>
  );
}

export function IconLayoutFocus(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="2.8" width="5.2" height="10.4" rx="1.2" {...stroke} />
      <rect x="8.6" y="2.8" width="5.6" height="4.7" rx="1.1" {...stroke} />
      <rect x="8.6" y="8.5" width="5.6" height="4.7" rx="1.1" {...stroke} />
    </Svg>
  );
}

export function IconLayoutGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="2.8" width="5.6" height="4.7" rx="1.1" {...stroke} />
      <rect x="8.6" y="2.8" width="5.6" height="4.7" rx="1.1" {...stroke} />
      <rect x="1.8" y="8.5" width="5.6" height="4.7" rx="1.1" {...stroke} />
      <rect x="8.6" y="8.5" width="5.6" height="4.7" rx="1.1" {...stroke} />
    </Svg>
  );
}

export function IconLayoutEven(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="2.8" width="5.6" height="10.4" rx="1.2" {...stroke} />
      <rect x="8.6" y="2.8" width="5.6" height="10.4" rx="1.2" {...stroke} />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="3.8" {...stroke} />
      <path d="M10 10.2 13.4 13.6" {...stroke} />
    </Svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6.2 8 10.2 12 6.2" {...stroke} />
    </Svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.2 8h9.6M9 4.2 12.8 8 9 11.8" {...stroke} />
    </Svg>
  );
}

export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4" cy="8" r="0.9" {...stroke} />
      <circle cx="8" cy="8" r="0.9" {...stroke} />
      <circle cx="12" cy="8" r="0.9" {...stroke} />
    </Svg>
  );
}

export function IconRestart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.6 8A4.6 4.6 0 1 1 11.2 4.2" {...stroke} />
      <path d="M11.1 2.4v2.6h2.6" {...stroke} />
      <path d="M8 5.7v4.6" {...stroke} />
    </Svg>
  );
}
