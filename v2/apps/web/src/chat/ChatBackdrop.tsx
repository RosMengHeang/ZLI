import { useEffect, useRef } from "react";

import { type ChatBackdrop as ChatBackdropSettings, useAppSettings } from "../settings/appSettings.js";
import { type BackdropPlace, drawBackdrop, hexToRgb, parseColor, type Rgb } from "./backdrop.js";
import { useBackdropImage } from "./backdropImage.js";
import "./backdrop.css";

const FALLBACK_ACCENT: Rgb = [74, 111, 220];

/**
 * Draws a background on a canvas that fills its positioned parent. The color is the one picked in
 * Settings, or the theme's accent. It redraws when the parent resizes and when anything it draws changes.
 */
export function BackdropCanvas({
  backdrop,
  place = "chat",
}: {
  backdrop: ChatBackdropSettings;
  /** The sidebar draws its own version of the look. */
  place?: BackdropPlace;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useAppSettings().theme;
  const image = useBackdropImage();
  const { style, intensity, color, imageEffect } = backdrop;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme is read from CSS, so a theme change must redraw.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || style === "off") return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height } = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const accent = getComputedStyle(canvas).getPropertyValue("--zli-accent").trim();
      const rgb =
        (color ? hexToRgb(color) : undefined) ?? (accent ? parseColor(ctx, accent, FALLBACK_ACCENT) : FALLBACK_ACCENT);
      drawBackdrop(ctx, width, height, { style, color: rgb, intensity, image, imageEffect, place });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    schedule();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(canvas);
    return () => {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [style, intensity, color, imageEffect, image, theme, place]);

  if (style === "off") return null;
  return <canvas ref={ref} className="backdrop-canvas" />;
}

/** The chat's background layer: the drawing, then soft washes of the surface where text sits. */
export function ChatBackdrop({ place = "chat" }: { place?: BackdropPlace } = {}) {
  const { chatBackdrop } = useAppSettings();
  if (chatBackdrop.style === "off") return null;
  return (
    <div
      className="chat-backdrop"
      data-style={chatBackdrop.style}
      data-effect={chatBackdrop.style === "image" ? chatBackdrop.imageEffect : undefined}
      aria-hidden="true"
    >
      <BackdropCanvas backdrop={chatBackdrop} place={place} />
      <div className="chat-backdrop-veil" />
    </div>
  );
}
