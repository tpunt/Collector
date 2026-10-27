import { setTimeout } from 'node:timers/promises';

export type BrowserAction = 'navigation' | 'load';
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
const realClock: Clock = {
  now: Date.now,
  sleep: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); },
};
export interface PauseState { reason: string; notBefore: number | null }
export class BrowserPausedError extends Error {
  readonly state: PauseState;
  constructor(state: PauseState) {
    super(`Browser paused: ${state.reason}`);
    this.state = state;
  }
}

/** One instance must be shared by all Reddit jobs. Callback resolves only after bounded readiness. */
export class BrowserLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private lastReady: number | null = null;
  private paused: PauseState | null = null;
  private clock: Clock;
  private spacing: Record<BrowserAction, number>;

  constructor(options: { clock?: Clock; navigationMs?: number; loadMs?: number } = {}) {
    this.clock = options.clock ?? realClock;
    this.spacing = { navigation: options.navigationMs ?? 10_000, load: options.loadMs ?? 5_000 };
  }

  get pauseState(): PauseState | null { return this.paused ? { ...this.paused } : null; }

  pause(reason: string, notBefore: number | null = null): void {
    this.paused = {
      reason: this.paused?.reason ?? reason,
      notBefore: Math.max(this.paused?.notBefore ?? 0, notBefore ?? 0) || null,
    };
  }

  resume(sessionRevalidated: boolean): void {
    if (!sessionRevalidated) throw new Error('Explicit session revalidation is required');
    if (this.paused?.notBefore && this.clock.now() < this.paused.notBefore) {
      throw new BrowserPausedError({ ...this.paused });
    }
    this.paused = null;
  }

  run<T>(kind: BrowserAction, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(async () => {
      this.assertRunning(signal);
      if (this.lastReady !== null) {
        const wait = Math.max(0, this.lastReady + this.spacing[kind] - this.clock.now());
        if (wait) await this.clock.sleep(wait, signal);
      }
      this.assertRunning(signal);
      try {
        const value = await action();
        this.assertRunning(signal);
        return value;
      } finally {
        this.lastReady = this.clock.now();
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertRunning(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.paused) throw new BrowserPausedError({ ...this.paused });
  }
}

/** Operational header only; does not inspect response bodies. */
export function retryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  if (/^\d+(?:\.\d+)?$/.test(header.trim())) {
    const delay = Number(header) * 1_000;
    return Number.isSafeInteger(Math.ceil(delay)) ? now + Math.ceil(delay) : null;
  }
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : null;
}
