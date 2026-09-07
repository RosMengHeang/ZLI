export type Cancelable<T extends (...args: never[]) => void> = T & { cancel: () => void };

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): Cancelable<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = ((...args: Parameters<T>) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  }) as Cancelable<T>;
  wrapped.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

export function rafThrottle<T extends (...args: never[]) => void>(fn: T): Cancelable<T> {
  let frame = 0;
  let lastArgs: Parameters<T> | null = null;
  const wrapped = ((...args: Parameters<T>) => {
    lastArgs = args;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const pending = lastArgs;
      lastArgs = null;
      if (pending) fn(...pending);
    });
  }) as Cancelable<T>;
  wrapped.cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastArgs = null;
  };
  return wrapped;
}
