import { type AgentAlert, agentAlerts, isUrgentAlert } from "@zli-v2/client-runtime";
import type { RuntimeProjection } from "@zli-v2/contracts";

import type { DevicePush, MobileAccessStore } from "./MobileAccessStore.js";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo takes at most 100 messages per request. */
const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;
/** The phone's notification channel, created by the app on Android. */
const ANDROID_CHANNEL = "agents";

export type PushFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One message in Expo's push format. */
export type ExpoPushMessage = {
  to: string;
  title: string;
  subtitle: string;
  body: string;
  data: { threadId: string };
  channelId: string;
  priority: "high";
  sound?: "default";
};

export interface PhonePushOptions {
  store: Pick<MobileAccessStore, "enabled" | "devices" | "device" | "setPush">;
  /** Phones that show their own alerts right now, so pushing to them would alert twice. */
  attentive: () => Set<string>;
  fetch: PushFetch;
  /** A phone's push token was set or cleared. */
  onChange?: () => void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  timeoutMs?: number;
}

/** The phone's own local alert as an Expo push message, so both look the same. */
export function pushMessage(alert: AgentAlert, token: string): ExpoPushMessage {
  return {
    to: token,
    title: alert.title,
    subtitle: alert.state,
    body: alert.body,
    data: { threadId: alert.threadId },
    channelId: ANDROID_CHANNEL,
    priority: "high",
    ...(isUrgentAlert(alert) ? { sound: "default" as const } : {}),
  };
}

type Outgoing = { deviceId: string; push: DevicePush; message: ExpoPushMessage };

/**
 * Sends the phone's agent alerts through Expo's push service to paired phones that are not
 * connected, or whose app left the screen. Phones that are connected and on screen post their own.
 */
export class PhonePush {
  readonly #options: PhonePushOptions;
  #previous: RuntimeProjection | undefined;
  #sending: Promise<void> = Promise.resolve();

  constructor(options: PhonePushOptions) {
    this.#options = options;
  }

  update(projection: RuntimeProjection): void {
    const previous = this.#previous;
    this.#previous = projection;
    const { store } = this.#options;
    if (!previous || !store.enabled) return;
    const alerts = agentAlerts(previous, projection);
    if (alerts.length === 0) return;
    const attentive = this.#options.attentive();
    const outgoing: Outgoing[] = store.devices().flatMap((device) => {
      const push = device.push;
      if (!push || attentive.has(device.deviceId)) return [];
      return alerts.map((alert) => ({ deviceId: device.deviceId, push, message: pushMessage(alert, push.token) }));
    });
    if (outgoing.length === 0) return;
    // One batch at a time keeps alerts in the order they happened.
    this.#sending = this.#sending.then(() => this.#send(outgoing)).catch(() => undefined);
  }

  /** Resolves once every send started so far has finished. */
  async settled(): Promise<void> {
    await this.#sending;
  }

  async #send(outgoing: Outgoing[]): Promise<void> {
    for (let start = 0; start < outgoing.length; start += BATCH_SIZE) {
      await this.#sendBatch(outgoing.slice(start, start + BATCH_SIZE));
    }
  }

  async #sendBatch(batch: Outgoing[]): Promise<void> {
    const { log } = this.#options;
    let tickets: unknown;
    try {
      const response = await this.#options.fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch.map((entry) => entry.message)),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        log?.("phone push refused", { status: response.status, messages: batch.length });
        return;
      }
      tickets = ((await response.json()) as { data?: unknown } | null)?.data;
    } catch (error) {
      log?.("phone push failed", {
        error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        messages: batch.length,
      });
      return;
    }
    if (!Array.isArray(tickets)) return;
    const unregistered = new Map<string, string>();
    tickets.forEach((ticket: unknown, index) => {
      const entry = batch[index];
      const result = ticket as { status?: unknown; details?: { error?: unknown } } | null;
      if (!entry || result?.status !== "error") return;
      const reason = typeof result.details?.error === "string" ? result.details.error : "unknown";
      if (reason === "DeviceNotRegistered") unregistered.set(entry.deviceId, entry.push.token);
      else log?.("phone push not delivered", { deviceId: entry.deviceId, reason });
    });
    for (const [deviceId, token] of unregistered) await this.#forget(deviceId, token);
  }

  /** Drops a token Expo no longer delivers to, unless the phone sent a new one meanwhile. */
  async #forget(deviceId: string, token: string): Promise<void> {
    const { store } = this.#options;
    if (store.device(deviceId)?.push?.token !== token) return;
    const changed = await store.setPush(deviceId, undefined).catch(() => false);
    this.#options.log?.("phone push token no longer registered", { deviceId });
    if (changed) this.#options.onChange?.();
  }
}
