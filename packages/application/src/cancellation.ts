export interface CancellationSignal {
  readonly cancelled: boolean;
  /** Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export class CancellationSource {
  #cancelled = false;
  #listeners = new Set<() => void>();

  readonly signal: CancellationSignal;

  constructor() {
    const source = this;
    this.signal = {
      get cancelled(): boolean {
        return source.#cancelled;
      },
      subscribe(listener: () => void): () => void {
        if (source.#cancelled) {
          source.#notify(listener);
          return () => { };
        }
        source.#listeners.add(listener);
        let active = true;
        return () => {
          if (active) {
            active = false;
            source.#listeners.delete(listener);
          }
        };
      },
    };
  }

  cancel(): void {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    const pending = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of pending) {
      this.#notify(listener);
    }
  }

  #notify(listener: () => void): void {
    try {
      listener();
    } catch {
      // A throwing listener must not prevent the remaining listeners.
    }
  }
}

export type OperationContext = {
  readonly requestId: string;
  readonly deadlineMs: number;
  readonly signal: CancellationSignal;
};
