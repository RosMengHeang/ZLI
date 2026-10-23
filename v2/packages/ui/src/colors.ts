/**
 * Theme colours that code outside CSS needs: the native window frame and the terminal renderer.
 * Each one equals a custom property in tokens.css, and a test keeps the two in step.
 */
export const themeColors = {
  /** --zli-canvas */
  canvas: "#0a0a0b",
  /** --zli-muted */
  muted: "#a3a3a3",
  /** --zli-terminal */
  terminal: "#141416",
} as const;

export const themeColorTokens: Record<keyof typeof themeColors, string> = {
  canvas: "--zli-canvas",
  muted: "--zli-muted",
  terminal: "--zli-terminal",
};
