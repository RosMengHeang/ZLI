import Svg, { Circle, Path, Rect } from "react-native-svg";

/** The desktop's line icons (apps/web/src/ui/Icon.tsx), so both apps draw the same glyphs. */
const paths = {
  arrowLeft: <Path d="m12 19-7-7 7-7M19 12H5" />,
  arrowUp: <Path d="m5 12 7-7 7 7M12 19V5" />,
  settings: (
    <>
      <Path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  plus: <Path d="M12 5v14M5 12h14" />,
  bell: (
    <>
      <Path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <Path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  terminal: (
    <>
      <Path d="m4 17 6-6-6-6" />
      <Path d="M12 19h8" />
    </>
  ),
  branch: (
    <>
      <Path d="M6 3v12" />
      <Circle cx="18" cy="6" r="3" />
      <Circle cx="6" cy="18" r="3" />
      <Path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  diff: (
    <>
      <Circle cx="5" cy="6" r="3" />
      <Path d="M12 6h5a2 2 0 0 1 2 2v7" />
      <Path d="m15 9-3-3 3-3" />
      <Circle cx="19" cy="18" r="3" />
      <Path d="M12 18H7a2 2 0 0 1-2-2V9" />
      <Path d="m9 15 3 3-3 3" />
    </>
  ),
  commit: (
    <>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M3 12h6M15 12h6" />
    </>
  ),
  upload: <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
  file: (
    <>
      <Path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <Path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  square: <Rect x="6" y="6" width="12" height="12" rx="2" />,
  check: <Path d="M20 6 9 17l-5-5" />,
  chevronRight: <Path d="m9 18 6-6-6-6" />,
  chevronDown: <Path d="m6 9 6 6 6-6" />,
  chevronUp: <Path d="m18 15-6-6-6 6" />,
  x: <Path d="M18 6 6 18M6 6l12 12" />,
  alert: (
    <>
      <Path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <Path d="M12 9v4M12 17h.01" />
    </>
  ),
  smartphone: (
    <>
      <Rect width="14" height="20" x="5" y="2" rx="2" />
      <Path d="M12 18h.01" />
    </>
  ),
  monitor: (
    <>
      <Rect width="20" height="14" x="2" y="3" rx="2" />
      <Path d="M8 21h8M12 17v4" />
    </>
  ),
  eye: (
    <>
      <Path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  shieldCheck: (
    <>
      <Path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <Path d="m9 12 2 2 4-4" />
    </>
  ),
  shieldAlert: (
    <>
      <Path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <Path d="M12 8v4M12 16h.01" />
    </>
  ),
  squarePen: (
    <>
      <Path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <Path d="M18.38 2.62a1 1 0 0 1 3 3l-9.01 9.02a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z" />
    </>
  ),
  folder: (
    <Path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  folderOpen: (
    <Path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  ),
  image: (
    <>
      <Rect width="18" height="18" x="3" y="3" rx="2" />
      <Circle cx="9" cy="9" r="2" />
      <Path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </>
  ),
  camera: (
    <>
      <Path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
      <Circle cx="12" cy="13" r="3" />
    </>
  ),
  trash: <Path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />,
  pencil: (
    <Path d="M21.17 6.81a1 1 0 0 0-3.99-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5zM15 5l4 4" />
  ),
  lock: (
    <>
      <Rect width="18" height="11" x="3" y="11" rx="2" />
      <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  lockOpen: (
    <>
      <Rect width="18" height="11" x="3" y="11" rx="2" />
      <Path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </>
  ),
  copy: (
    <>
      <Rect width="14" height="14" x="8" y="8" rx="2" />
      <Path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  reload: (
    <>
      <Path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <Path d="M21 3v5h-5" />
    </>
  ),
  cpu: (
    <>
      <Rect width="16" height="16" x="4" y="4" rx="2" />
      <Rect width="6" height="6" x="9" y="9" rx="1" />
      <Path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </>
  ),
  message: <Path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  scan: (
    <Path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 20,
  color,
  strokeWidth = 1.75,
}: {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
    >
      {paths[name]}
    </Svg>
  );
}
