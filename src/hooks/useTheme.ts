import { useEffect } from "react";
import { resolveTheme } from "../lib/theme";
import { useUiStore } from "../stores/uiStore";

export function useTheme(): void {
  const mode = useUiStore((state) => state.themeMode);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(mode, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
}
