import { createServer, type Server } from "node:http";

/** Ports tried first, so a saved client registration (tied to its redirect address) can be reused. */
export const PREFERRED_CALLBACK_PORTS: readonly number[] = [47291, 47292, 47293];

export type CallbackResult = { code: string } | { error: string };

export type Loopback = {
  redirectUri: string;
  /** Resolves with the code or error the browser brings back for `state`. */
  waitForCallback(state: string, signal: AbortSignal): Promise<CallbackResult>;
  close(): void;
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

export function callbackPage(title: string, detail: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>ZLI</title>',
    "<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#f6f6f4}",
    "main{max-width:28rem;padding:2rem}h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;color:#555}",
    "@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}p{color:#aaa}}</style></head>",
    `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`,
  ].join("");
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * A one-time web server on this computer that the browser returns to after sign-in. The redirect uses
 * `localhost`, which most sign-in servers expect, so it listens on both IPv4 and IPv6 loopback.
 */
export async function startLoopback(
  options: { ports?: readonly number[]; serviceName?: string } = {},
): Promise<Loopback> {
  const waiting = new Map<string, (result: CallbackResult) => void>();
  const early = new Map<string, CallbackResult>();
  const service = options.serviceName ?? "the service";
  const handler: Parameters<typeof createServer>[1] = (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const known = waiting.has(state);
    const result: CallbackResult | undefined = code
      ? { code }
      : error
        ? { error: url.searchParams.get("error_description") || error }
        : undefined;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (!result || !known) {
      response.statusCode = 400;
      response.end(callbackPage("This sign-in link has expired", "Go back to ZLI and start the sign-in again."));
      if (result && state) early.set(state, result);
      return;
    }
    waiting.get(state)?.(result);
    waiting.delete(state);
    response.end(
      "code" in result
        ? callbackPage(`Signed in to ${service}`, "You can close this tab and go back to ZLI.")
        : callbackPage("Sign-in did not finish", `${result.error}. Go back to ZLI and try again.`),
    );
  };
  const primary = createServer(handler);
  let port = 0;
  for (const candidate of [...(options.ports ?? PREFERRED_CALLBACK_PORTS), 0]) {
    try {
      port = await listen(primary, candidate, "127.0.0.1");
      break;
    } catch (error) {
      if (candidate === 0) throw error;
    }
  }
  const secondary = createServer(handler);
  await listen(secondary, port, "::1").catch(() => undefined);
  const close = () => {
    primary.close();
    if (secondary.listening) secondary.close();
    primary.closeAllConnections?.();
    secondary.closeAllConnections?.();
  };
  return {
    redirectUri: `http://localhost:${port}/callback`,
    waitForCallback: (state, signal) =>
      new Promise<CallbackResult>((resolve, reject) => {
        const ready = early.get(state);
        if (ready) {
          resolve(ready);
          return;
        }
        const onAbort = () => {
          waiting.delete(state);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Sign-in stopped."));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        waiting.set(state, (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        });
      }),
    close,
  };
}
