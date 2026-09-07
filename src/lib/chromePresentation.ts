export type ToolbarDensity = "compact" | "comfortable";

export const SHELL_LIMITS = {
  sidebar: { default: "228px", min: "196px", max: "300px" },
  browser: { default: "30%", min: "320px", max: "48%" },
  git: { default: "34%", min: "220px", max: "68%" },
} as const;

export function toolbarDensityForWidth(width: number): ToolbarDensity {
  return width < 1100 ? "compact" : "comfortable";
}
