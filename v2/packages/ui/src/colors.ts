/**
 * Theme colours that code outside CSS needs before the renderer applies a theme: the native window
 * frame the desktop app opens with. Each one equals a custom property in tokens.css (the Midnight
 * theme), and a test keeps the two in step.
 */
export const themeColors = {
  /** --zli-canvas */
  canvas: "#050505",
  /** --zli-muted */
  muted: "#a3a3a3",
  /** --zli-terminal */
  terminal: "#0f0f0f",
} as const;

export const themeColorTokens: Record<keyof typeof themeColors, string> = {
  canvas: "--zli-canvas",
  muted: "--zli-muted",
  terminal: "--zli-terminal",
};
