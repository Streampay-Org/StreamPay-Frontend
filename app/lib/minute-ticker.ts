// Simple fixed 60-second cadence. It avoids minute-boundary timeout complexity
// and keeps the ticker deterministic in browsers and Jest fake timers.
const MINUTE_MS = 60_000;

let revision = 0;
let intervalId: number | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  revision += 1;
  const subscribers = Array.from(listeners);
  subscribers.forEach((listener) => {
    if (listeners.has(listener)) {
      listener();
    }
  });
}

export function subscribeToMinuteTicker(listener: () => void): () => void {
  listeners.add(listener);

  if (listeners.size === 1 && typeof window !== "undefined" && intervalId === null) {
    intervalId = window.setInterval(publish, MINUTE_MS);
  }

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);

    if (listeners.size === 0 && intervalId !== null) {
      if (typeof window !== "undefined") {
        window.clearInterval(intervalId);
      }
      intervalId = null;
    }
  };
}

export function getMinuteTickerSnapshot(): number {
  return revision;
}

export function getMinuteTickerServerSnapshot(): number {
  return 0;
}

export function notifyMinuteTicker(): void {
  publish();
}

export const subscribe = subscribeToMinuteTicker;
export const getSnapshot = getMinuteTickerSnapshot;
export const getServerSnapshot = getMinuteTickerServerSnapshot;
export const notify = notifyMinuteTicker;
