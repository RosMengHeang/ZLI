import type { MobileDevice } from "@zli-v2/contracts";
import type { CSSProperties, ReactNode } from "react";

import { deviceSkin, type SideButton, type SideButtonName, skinGeometry } from "./deviceSkin.js";
import type { Zoom } from "./useDeviceZoom.js";

/**
 * A generic phone or tablet body drawn around the screen: a metal rim, black glass, rounded screen corners,
 * the camera, and side buttons that press the device's own. Without a frame size, or with the frame turned
 * off, the wrappers take no space and the screen lays out on its own.
 *
 * The screen keeps the first place in the body, so turning the frame on or off never remounts the canvas
 * the video draws on.
 */
export function DeviceFrame({
  device,
  frame,
  shown,
  zoom,
  blocked,
  onPress,
  children,
}: {
  device: Pick<MobileDevice, "platform" | "name">;
  /** The screen's size in its own pixels, once the first frame has arrived. */
  frame: { width: number; height: number } | undefined;
  shown: boolean;
  zoom: Zoom;
  /** True while an agent holds the device, so the buttons show they will not press right away. */
  blocked: boolean;
  onPress(button: SideButtonName): void;
  children: ReactNode;
}) {
  if (!shown || !frame || frame.width <= 0 || frame.height <= 0)
    return (
      <div className="mobile-device">
        <div className="mobile-device-screen">{children}</div>
      </div>
    );
  const skin = deviceSkin(device, frame);
  const body = skinGeometry(skin, frame);
  const short = Math.min(body.width, body.height);
  const cqmin = (value: number) => `${((value / short) * 100).toFixed(3)}cqmin`;
  const share = (value: number, of: number) => `${((value / of) * 100).toFixed(4)}%`;
  const scale = window.devicePixelRatio || 1;
  const bodyStyle = {
    "--skin-ratio": (body.width / body.height).toFixed(5),
    "--skin-radius": cqmin(body.radius),
    "--skin-screen-radius": cqmin(body.screenRadius),
    "--skin-rim": cqmin(body.rim),
    ...(zoom === "actual" ? { width: body.width / scale, height: body.height / scale } : {}),
  } as CSSProperties;
  const screenStyle: CSSProperties = {
    left: share(body.bezel, body.width),
    top: share(body.bezel, body.height),
    width: share(frame.width, body.width),
    height: share(frame.height, body.height),
  };
  const camera: CSSProperties =
    skin.orientation === "portrait"
      ? { top: share(body.bezel / 2, body.height) }
      : { left: share(body.bezel / 2, body.width) };
  return (
    <div
      className={`mobile-device is-framed is-${skin.shape} is-${skin.orientation}${blocked ? " is-blocked" : ""}`}
      style={bodyStyle}
    >
      <div className="mobile-device-screen" style={screenStyle}>
        {children}
        {skin.cutout === "none" ? null : (
          <span className={`mobile-device-cutout is-${skin.cutout}`} aria-hidden="true" />
        )}
      </div>
      <span className="mobile-device-glass" aria-hidden="true" />
      {skin.shape === "tablet" ? <span className="mobile-device-camera" style={camera} aria-hidden="true" /> : null}
      {skin.buttons.map((button) =>
        button.pressable ? (
          <button
            key={button.name}
            type="button"
            className={`mobile-device-key is-${button.edge}`}
            style={keyStyle(button)}
            aria-label={button.label}
            data-tooltip={blocked ? `${button.label}. Take over first.` : button.label}
            onClick={() => onPress(button.name)}
          />
        ) : (
          <span
            key={button.name}
            className={`mobile-device-key is-${button.edge} is-static`}
            style={keyStyle(button)}
            aria-hidden="true"
          />
        ),
      )}
    </div>
  );
}

function keyStyle(button: SideButton): CSSProperties {
  const start = `${(button.start * 100).toFixed(2)}%`;
  const length = `${(button.length * 100).toFixed(2)}%`;
  return button.edge === "left" || button.edge === "right"
    ? { top: start, height: length }
    : { left: start, width: length };
}
