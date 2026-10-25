import type { MobileDevice, MobilePanelInput, MobileStreamEvent, MobileStreamInfo } from "@zli-v2/contracts";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, LoadingState } from "../ui/Pane.js";
import { errorText, framePoint, keyInput, type TouchStep, wheelPixels, wheelSwipe } from "./mobile.js";

type Size = { width: number; height: number };
type Point = { x: number; y: number };

/** How often the panel asks for a screenshot itself when this computer cannot decode the video. */
const CLIENT_STILL_MS = 1_000;
/** Wheel events this close together scroll as one swipe. */
const WHEEL_BURST_MS = 120;
const WHEEL_STEP_MS = 16;
/** The finger rests at the end of a wheel swipe before lifting, so Android scrolls by the distance and does not fling. */
const WHEEL_SETTLE_MS = 60;
/** Screenshot mode swipes with adb, which takes the time between press and release as the swipe's duration. */
const WHEEL_STILLS_HOLD_MS = 250;

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
  const stageRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<HTMLElement | null>(null);
  /** Where a drag started and where the pointer is now, drawn while the screen shows screenshots. */
  const [trail, setTrail] = useState<{ from: Point; to: Point }>();
  const wheelRef = useRef<{ delta: Point; point: Point; size: Size; timer: number } | undefined>(undefined);
  const swipesRef = useRef<Promise<void>>(Promise.resolve());
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (wheelRef.current) window.clearTimeout(wheelRef.current.timer);
      wheelRef.current = undefined;
    };
  }, []);

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
  /** The backend builds a swipe from the press and release alone, so moves are not sent. */
  const pressAndReleaseOnly = info?.mode !== "video";
  // Screenshots shown in place of the video are full resolution; scrcpy measures touches in its own frame.
  const inputSize = (info?.mode === "video" ? streamSizeRef.current : undefined) ?? frame;
  const pointFor = (client: Point, rect: DOMRect): Point | undefined => {
    if (!frame || !inputSize) return undefined;
    const point = framePoint(client, rect, frame);
    if (!point || (inputSize.width === frame.width && inputSize.height === frame.height)) return point;
    return {
      x: Math.round((point.x * inputSize.width) / frame.width),
      y: Math.round((point.y * inputSize.height) / frame.height),
    };
  };
  const trailPoint = (client: Point, screenRect: DOMRect): Point | undefined => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return undefined;
    // The trail stays on the screen even when the pointer leaves it mid-drag.
    const x = Math.max(screenRect.left, Math.min(screenRect.right, client.x));
    const y = Math.max(screenRect.top, Math.min(screenRect.bottom, client.y));
    return { x: x - stage.left, y: y - stage.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.focus();
    if (event.button !== 0) return;
    if (inputBlocked) {
      onBlockedInput();
      return;
    }
    const client = { x: event.clientX, y: event.clientY };
    const rect = event.currentTarget.getBoundingClientRect();
    const point = pointFor(client, rect);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDownRef.current = true;
    if (!video) {
      const start = trailPoint(client, rect);
      setTrail(start ? { from: start, to: start } : undefined);
    }
    send({ deviceId, type: "touch", action: "down", ...point });
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!pointerDownRef.current) return;
    const client = { x: event.clientX, y: event.clientY };
    const rect = event.currentTarget.getBoundingClientRect();
    if (!video) {
      const to = trailPoint(client, rect);
      if (to) setTrail((current) => (current ? { ...current, to } : current));
    }
    if (pressAndReleaseOnly) return;
    const point = pointFor(client, rect);
    if (point) send({ deviceId, type: "touch", action: "move", ...point });
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (!pointerDownRef.current) return;
    pointerDownRef.current = false;
    setTrail(undefined);
    const point = pointFor({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect());
    if (point) send({ deviceId, type: "touch", action: "up", ...point });
  };

  const playSwipe = (steps: readonly TouchStep[], onlyPressAndRelease: boolean) => {
    const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    swipesRef.current = swipesRef.current.then(async () => {
      for (const [index, step] of steps.entries()) {
        if (onlyPressAndRelease && step.action === "move") continue;
        if (step.action === "up") await wait(onlyPressAndRelease ? WHEEL_STILLS_HOLD_MS : WHEEL_SETTLE_MS);
        else if (index > 0) await wait(WHEEL_STEP_MS);
        if (unmountedRef.current) return;
        send({ deviceId, type: "touch", ...step });
      }
    });
  };
  const onWheelRef = useRef<(event: WheelEvent) => void>(() => undefined);
  onWheelRef.current = (event: WheelEvent) => {
    event.preventDefault();
    if (inputBlocked) {
      onBlockedInput();
      return;
    }
    if (pointerDownRef.current || !inputSize || !(event.currentTarget instanceof HTMLElement)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pixels = wheelPixels(event, rect);
    const delta = { x: (pixels.x * inputSize.width) / rect.width, y: (pixels.y * inputSize.height) / rect.height };
    const burst = wheelRef.current;
    if (burst) {
      burst.delta = { x: burst.delta.x + delta.x, y: burst.delta.y + delta.y };
      return;
    }
    const point = pointFor({ x: event.clientX, y: event.clientY }, rect);
    if (!point) return;
    const onlyPressAndRelease = pressAndReleaseOnly;
    const timer = window.setTimeout(() => {
      const ended = wheelRef.current;
      wheelRef.current = undefined;
      if (ended) playSwipe(wheelSwipe(ended.delta, ended.point, ended.size), onlyPressAndRelease);
    }, WHEEL_BURST_MS);
    wheelRef.current = { delta, point, size: inputSize, timer };
  };
  // React listens to wheel passively, and only an active listener can keep the panel from scrolling.
  useEffect(() => {
    if (!screen) return;
    const listener = (event: WheelEvent) => onWheelRef.current(event);
    screen.addEventListener("wheel", listener, { passive: false });
    return () => screen.removeEventListener("wheel", listener);
  }, [screen]);
  const canvasNode = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    setScreen(node);
  }, []);
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
      <div className="mobile-stage" ref={stageRef}>
        {!frame ? <LoadingState className="mobile-stage-loading" label={`Connecting to ${device.name}`} /> : null}
        {video ? (
          <canvas
            {...screenProps}
            ref={canvasNode}
            hidden={!frame}
            style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined}
          />
        ) : still && frame ? (
          <img
            {...screenProps}
            ref={setScreen}
            src={still}
            alt={`${device.name} screen`}
            draggable={false}
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
          />
        ) : null}
        {trail ? (
          <svg className="mobile-trail" aria-hidden="true">
            <line className="mobile-trail-shade" x1={trail.from.x} y1={trail.from.y} x2={trail.to.x} y2={trail.to.y} />
            <line className="mobile-trail-line" x1={trail.from.x} y1={trail.from.y} x2={trail.to.x} y2={trail.to.y} />
            <circle className="mobile-trail-start" cx={trail.from.x} cy={trail.from.y} r={4} />
            <circle className="mobile-trail-end" cx={trail.to.x} cy={trail.to.y} r={9} />
          </svg>
        ) : null}
      </div>
      {note ? <p className="mobile-note">{note}</p> : null}
    </div>
  );
}
