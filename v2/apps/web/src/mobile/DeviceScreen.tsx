import type { MobileDevice, MobilePanelInput, MobileStreamEvent, MobileStreamInfo } from "@zli-v2/contracts";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, LoadingState } from "../ui/Pane.js";
import { errorText, framePoint, keyInput } from "./mobile.js";

type Size = { width: number; height: number };

/** How often the panel asks for a screenshot itself when this computer cannot decode the video. */
const CLIENT_STILL_MS = 1_000;

/**
 * The live screen of one running device. Android arrives as H.264 decoded with WebCodecs; iOS, and Android
 * when scrcpy could not start, arrives as screenshots. Pointer and keyboard input go back to the device.
 */
export function DeviceScreen({
  mobile,
  device,
  inputBlocked,
  onBlockedInput,
}: {
  mobile: MobileBridge;
  device: MobileDevice;
  /** True while an agent holds the device; the person must take over first. */
  inputBlocked: boolean;
  onBlockedInput(): void;
}) {
  const deviceId = device.deviceId;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [info, setInfo] = useState<MobileStreamInfo>();
  const [frame, setFrame] = useState<Size>();
  const [still, setStill] = useState<string>();
  const [ended, setEnded] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [inputError, setInputError] = useState<string>();
  /** Set when video arrives but this computer cannot decode it, so the panel polls screenshots instead. */
  const [decodeProblem, setDecodeProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  /** The stream's own frame size, which touch positions are measured in while scrcpy carries input. */
  const streamSizeRef = useRef<Size | undefined>(undefined);
  const pointerDownRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt restarts the stream after it failed or ended.
  useEffect(() => {
    let disposed = false;
    let decoder: VideoDecoder | undefined;
    let waitingForKey = true;
    let clientStills: number | undefined;
    setInfo(undefined);
    setFrame(undefined);
    setStill(undefined);
    setEnded(undefined);
    setStartError(undefined);
    setDecodeProblem(undefined);
    streamSizeRef.current = undefined;

    const startClientStills = (reason: string) => {
      decoder?.close();
      decoder = undefined;
      setDecodeProblem(reason);
      if (clientStills !== undefined) return;
      const poll = async () => {
        try {
          const shot = await mobile.screenshot(deviceId);
          if (disposed) return;
          setStill(`data:${shot.mimeType};base64,${shot.data}`);
          setFrame({ width: shot.width, height: shot.height });
        } catch {
          // The next poll tries again; a stopped device ends the stream and unmounts this view.
        }
      };
      void poll();
      clientStills = window.setInterval(() => void poll(), CLIENT_STILL_MS);
    };

    const drawFrame = (videoFrame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (!disposed && canvas) {
        if (canvas.width !== videoFrame.displayWidth || canvas.height !== videoFrame.displayHeight) {
          canvas.width = videoFrame.displayWidth;
          canvas.height = videoFrame.displayHeight;
          setFrame({ width: videoFrame.displayWidth, height: videoFrame.displayHeight });
        }
        canvas.getContext("2d")?.drawImage(videoFrame, 0, 0);
      }
      videoFrame.close();
    };

    const configure = (codec: string) => {
      if (clientStills !== undefined) return;
      if (typeof VideoDecoder === "undefined") {
        startClientStills("This computer cannot decode the live video, so the panel shows screenshots.");
        return;
      }
      decoder?.close();
      decoder = new VideoDecoder({
        output: drawFrame,
        error: (cause) => startClientStills(`The live video stopped decoding: ${cause.message}`),
      });
      decoder.configure({ codec, optimizeForLatency: true });
      waitingForKey = true;
    };

    const onEvent = (event: MobileStreamEvent) => {
      if (disposed) return;
      if (event.type === "info") {
        if (event.info.deviceId === deviceId) setInfo(event.info);
        return;
      }
      if (event.deviceId !== deviceId) return;
      switch (event.type) {
        case "config":
          streamSizeRef.current = { width: event.width, height: event.height };
          configure(event.codec);
          return;
        case "frame":
          if (decoder?.state !== "configured") return;
          // A decoder that joins mid-stream must start at a key frame.
          if (waitingForKey && !event.key) return;
          waitingForKey = false;
          decoder.decode(
            new EncodedVideoChunk({ type: event.key ? "key" : "delta", timestamp: event.timestamp, data: event.data }),
          );
          return;
        case "still":
          if (clientStills !== undefined) return;
          setStill(`data:image/png;base64,${event.data}`);
          setFrame({ width: event.width, height: event.height });
          return;
        case "ended":
          setEnded(event.reason);
          return;
      }
    };

    const unsubscribe = mobile.onStream(onEvent);
    mobile
      .startStream(deviceId)
      .then((started) => {
        if (!disposed) setInfo(started);
      })
      .catch((cause: unknown) => {
        if (!disposed) setStartError(errorText(cause, "The live view could not start."));
      });
    return () => {
      disposed = true;
      unsubscribe();
      if (clientStills !== undefined) window.clearInterval(clientStills);
      decoder?.close();
      void mobile.stopStream(deviceId).catch(() => undefined);
    };
  }, [mobile, deviceId, attempt]);

  const send = useCallback(
    (input: MobilePanelInput) => {
      mobile.input(input).then(
        () => setInputError(undefined),
        (cause: unknown) => setInputError(errorText(cause, "The device did not accept that input.")),
      );
    },
    [mobile],
  );

  const video = info?.mode === "video" && decodeProblem === undefined;
  const pointFor = (event: PointerEvent<HTMLElement>) => {
    if (!frame) return undefined;
    const point = framePoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      frame,
    );
    // Screenshots shown in place of the video are full resolution; scrcpy measures touches in its own frame.
    const target = info?.mode === "video" ? streamSizeRef.current : undefined;
    if (!point || !target || (target.width === frame.width && target.height === frame.height)) return point;
    return {
      x: Math.round((point.x * target.width) / frame.width),
      y: Math.round((point.y * target.height) / frame.height),
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.focus();
    if (event.button !== 0) return;
    if (inputBlocked) {
      onBlockedInput();
      return;
    }
    const point = pointFor(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDownRef.current = true;
    send({ deviceId, type: "touch", action: "down", ...point });
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    // Screenshots cannot show a drag, so only the press and release go to the device.
    if (!pointerDownRef.current || info?.mode !== "video") return;
    const point = pointFor(event);
    if (point) send({ deviceId, type: "touch", action: "move", ...point });
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (!pointerDownRef.current) return;
    pointerDownRef.current = false;
    const point = pointFor(event);
    if (point) send({ deviceId, type: "touch", action: "up", ...point });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const input = keyInput(deviceId, event);
    if (!input) return;
    event.preventDefault();
    if (inputBlocked) {
      onBlockedInput();
      return;
    }
    send(input);
  };

  if (startError)
    return (
      <EmptyState icon="alert" tone="danger" title="The live view could not start" detail={startError}>
        <Button size="sm" icon="reload" onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </EmptyState>
    );
  if (ended)
    return (
      <EmptyState icon="pause" title="The live view stopped" detail={ended}>
        <Button size="sm" icon="play" onClick={() => setAttempt((value) => value + 1)}>
          Show it again
        </Button>
      </EmptyState>
    );

  const screenProps = {
    className: `mobile-screen${inputBlocked ? " is-blocked" : ""}`,
    tabIndex: 0,
    "aria-label": `${device.name} screen. Click to tap, drag to swipe, and type to send keys.`,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onKeyDown,
  };
  const note = decodeProblem ?? info?.fallbackReason;

  return (
    <div className="mobile-viewer">
      {inputError ? (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert" size={14} />
          <span className="banner-message">{inputError}</span>
        </div>
      ) : null}
      <div className="mobile-stage">
        {!frame ? <LoadingState className="mobile-stage-loading" label={`Connecting to ${device.name}`} /> : null}
        {video ? (
          <canvas
            {...screenProps}
            ref={canvasRef}
            hidden={!frame}
            style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined}
          />
        ) : still && frame ? (
          <img
            {...screenProps}
            src={still}
            alt={`${device.name} screen`}
            draggable={false}
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
          />
        ) : null}
      </div>
      {note ? <p className="mobile-note">{note}</p> : null}
    </div>
  );
}
