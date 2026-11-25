/**
 * "Stops with the app": a host started for a herdr-app mod has no reason to live once the app is gone, and
 * a crashed app never runs the mod's cleanup. So the host watches its own client count and calls `onIdle`
 * once nobody has been connected for `graceMs`, counted from start-up and from every drop to zero.
 */
export interface IdleExitOptions {
  readonly graceMs: number;
  readonly onIdle: () => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class IdleExit {
  readonly #options: IdleExitOptions;
  #handle: unknown = null;
  #fired = false;

  constructor(options: IdleExitOptions) {
    this.#options = options;
  }

  /** Arms the timer: call once the host is up, before any client has had a chance to connect. */
  start(): void {
    this.#arm();
  }

  /** Report the number of connected clients whenever it changes. */
  clients(count: number): void {
    if (count > 0) this.#disarm();
    else this.#arm();
  }

  stop(): void {
    this.#disarm();
    this.#fired = true;
  }

  #arm(): void {
    if (this.#fired || this.#handle != null) return;
    const set = this.#options.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); handle.unref(); return handle; });
    this.#handle = set(() => {
      this.#handle = null;
      if (this.#fired) return;
      this.#fired = true;
      this.#options.onIdle();
    }, this.#options.graceMs);
  }

  #disarm(): void {
    if (this.#handle == null) return;
    (this.#options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(this.#handle);
    this.#handle = null;
  }
}
