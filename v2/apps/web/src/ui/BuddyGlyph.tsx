/**
 * The buddies' own icon: a buddy's rounded square with its two bar eyes, drawn as an outline in the current
 * color, so it sits with the other line icons in a menu.
 */
export function BuddyGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg className="buddy-glyph" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="25" height="25" rx="7.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <rect x="10.6" y="11" width="3.4" height="9" rx="1.2" fill="currentColor" />
      <rect x="18" y="11" width="3.4" height="9" rx="1.2" fill="currentColor" />
    </svg>
  );
}
