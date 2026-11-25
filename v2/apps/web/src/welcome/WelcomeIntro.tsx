import { Fragment, useEffect, useRef } from "react";

import { Button } from "../ui/Button.js";

/**
 * The first thing a fresh install shows. The ZLI tile scales in and its Z is drawn, the greeting rises in
 * word by word, and the line under it fills as ZLI looks for agents, the GitHub CLI and past sessions.
 * The bar is real progress, not a timer. "Get started" shows once those checks are back.
 */
export function WelcomeIntro({
  progress,
  status,
  ready,
  onContinue,
}: {
  /** 0 to 1: how many of the first-run checks have answered. */
  progress: number;
  status: string;
  ready: boolean;
  onContinue(): void;
}) {
  const start = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ready) start.current?.focus();
  }, [ready]);
  const percent = Math.round(progress * 100);
  return (
    <div className="welcome-intro">
      <IntroMark />
      <h1 className="intro-title">
        {["Welcome", "to", "ZLI"].map((word, index) => (
          <Fragment key={word}>
            {index > 0 ? " " : null}
            <span
              className={index === 2 ? "intro-word is-name" : "intro-word"}
              style={{ animationDelay: `${640 + index * 80}ms` }}
            >
              {word}
            </span>
          </Fragment>
        ))}
      </h1>
      <p className="intro-sub">One window for every coding agent you run.</p>
      <div className="intro-load">
        <div
          className="intro-bar"
          role="progressbar"
          aria-label="Setting up"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className="intro-bar-fill" style={{ transform: `scaleX(${Math.max(progress, 0.04)})` }} />
        </div>
        <p className="intro-status" aria-live="polite">
          {status}
        </p>
      </div>
      <div className={ready ? "intro-cta is-ready" : "intro-cta"}>
        <Button ref={start} variant="primary" size="lg" disabled={!ready} onClick={onContinue}>
          Get started
        </Button>
        <span className="intro-hint" aria-hidden="true">
          or press Enter
        </span>
      </div>
    </div>
  );
}

/** The app icon, built from its parts so the tile can land first and the Z can be drawn on it. */
function IntroMark() {
  return (
    <svg className="intro-mark" viewBox="0 0 1024 1024" width={72} height={72} aria-hidden="true" focusable={false}>
      <defs>
        <linearGradient id="intro-mark-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4F7CFF" />
          <stop offset="1" stopColor="#2D4CE0" />
        </linearGradient>
      </defs>
      <rect className="intro-mark-tile" width="1024" height="1024" rx="230" fill="url(#intro-mark-fill)" />
      <path
        className="intro-mark-z"
        d="M300 315 H724 L300 709 H724"
        pathLength={1}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={128}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
