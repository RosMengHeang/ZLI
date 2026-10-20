import type { RuntimeProjection } from "@zli-v2/contracts";

import type { ZliBridge } from "./bridge.js";

export type RuntimeStore = {
  getSnapshot(): RuntimeProjection | undefined;
  subscribe(listener: () => void): () => void;
};

/**
 * Holds the latest projection outside React so components can subscribe to the parts they read.
 * Projections pushed by the runtime always apply. The first fetch only applies when nothing newer
 * arrived while it was in flight, since a slow reply would otherwise roll the state back.
 */
export function createRuntimeStore(bridge: ZliBridge | undefined): RuntimeStore & { start(): () => void } {
  let projection: RuntimeProjection | undefined;
  const listeners = new Set<() => void>();
  const publish = (incoming: RuntimeProjection) => {
    const next = projection ? shareUnchanged(projection, incoming) : incoming;
    if (next === projection) return;
    projection = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => projection,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (!bridge) return () => undefined;
      let active = true;
      const unsubscribe = bridge.runtime.onProjection((next) => {
        if (active) publish(next);
      });
      void bridge.runtime
        .getProjection()
        .then((initial) => {
          if (!active || !initial) return;
          if (projection && projection.lastSequence >= initial.lastSequence) return;
          publish(initial);
        })
        .catch(() => undefined);
      return () => {
        active = false;
        unsubscribe();
      };
    },
  };
}

/**
 * Returns `next` with every part that equals the matching part of `previous` replaced by the
 * previous object. Projections cross the context bridge as fresh copies, so without this every
 * array and object would look changed to reference comparisons on each update.
 */
export function shareUnchanged<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length;
    const shared = next.map((item, index) => {
      const value = index < previous.length ? shareUnchanged(previous[index], item) : item;
      if (value !== previous[index]) same = false;
      return value;
    });
    return (same ? previous : shared) as T;
  }
  if (!isPlainObject(previous) || !isPlainObject(next)) return next;
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  let same = previousKeys.length === nextKeys.length;
  const shared: Record<string, unknown> = {};
  for (const key of nextKeys) {
    const value = Object.hasOwn(previous, key) ? shareUnchanged(previous[key], next[key]) : next[key];
    if (value !== previous[key] || !Object.hasOwn(previous, key)) same = false;
    shared[key] = value;
  }
  return (same ? previous : shared) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type Selection<T> = { source: RuntimeProjection | undefined; selector: unknown; value: T };

/**
 * Returns a getSnapshot function for useSyncExternalStore that maps the projection through `selector`.
 * The previous result is returned again while the projection is the same object, or while `isEqual`
 * says the new result matches it, so subscribers re-render only when their slice changes.
 */
export function createSelection<T>(
  getProjection: () => RuntimeProjection | undefined,
  isEqual: (left: T, right: T) => boolean = Object.is,
) {
  let cached: Selection<T> | undefined;
  return (selector: (projection: RuntimeProjection | undefined) => T): T => {
    const source = getProjection();
    if (cached && cached.source === source && cached.selector === selector) return cached.value;
    const value = selector(source);
    if (cached && isEqual(cached.value, value)) {
      cached = { source, selector, value: cached.value };
      return cached.value;
    }
    cached = { source, selector, value };
    return value;
  };
}

export function shallowArrayEqual<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

const SHELL_IGNORED = new Set<keyof RuntimeProjection>(["messages", "activities", "requests", "lastSequence"]);

/**
 * Equality for the workspace shell. Chat views read messages, activities, and requests themselves,
 * so the shell only needs the first user message of each thread, which names the agent.
 */
export function sameShellProjection(
  left: RuntimeProjection | undefined,
  right: RuntimeProjection | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof RuntimeProjection)[]);
  for (const key of keys) {
    if (SHELL_IGNORED.has(key)) continue;
    if (left[key] !== right[key]) return false;
  }
  return sameTitles(left.messages, right.messages);
}

const titlesCache = new WeakMap<NonNullable<RuntimeProjection["messages"]>, ReadonlyMap<string, string>>();

function firstUserMessages(messages: RuntimeProjection["messages"]): ReadonlyMap<string, string> {
  const cached = messages ? titlesCache.get(messages) : undefined;
  if (cached) return cached;
  const titles = new Map<string, string>();
  for (const message of messages ?? []) {
    if (message.role !== "user" || titles.has(message.threadId) || !message.text.trim()) continue;
    titles.set(message.threadId, message.text);
  }
  if (messages) titlesCache.set(messages, titles);
  return titles;
}

function sameTitles(left: RuntimeProjection["messages"], right: RuntimeProjection["messages"]): boolean {
  if (left === right) return true;
  const a = firstUserMessages(left);
  const b = firstUserMessages(right);
  if (a.size !== b.size) return false;
  for (const [threadId, text] of a) if (b.get(threadId) !== text) return false;
  return true;
}
