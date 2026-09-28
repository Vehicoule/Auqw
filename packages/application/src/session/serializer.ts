/**
 * One serialized op lane: `run` queues work behind everything already
 * enqueued, and a rejection can never wedge the lane — the tail
 * swallows the outcome so the next queued op still runs. Replaces the
 * hand-rolled `tail.then(fn); tail = work.then(noop, noop)` idiom
 * every session op lane repeated.
 */
export class Serializer {
  #tail: Promise<void> = Promise.resolve();

  /** Queue `fn` behind everything enqueued so far. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(fn);
    this.#tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /** Settles once every op enqueued so far has finished. */
  idle(): Promise<void> {
    return this.#tail;
  }
}
