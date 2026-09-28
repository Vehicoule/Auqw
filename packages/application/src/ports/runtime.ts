export interface IdPort {
  next(prefix: string): string;
}

/** Uniform entropy source; deterministic fakes keep draws reproducible. */
export interface RandomPort {
  /** A uniform draw in [0, 1). */
  unit(): number;
}
