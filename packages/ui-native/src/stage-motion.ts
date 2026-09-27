// Stage-sheet morph staging — the OpenTune-adapted transition the CMP deck
// used: one continuous progress (0 = collapsed pill, 1 = expanded sheet)
// drives the pill fade, the content reveal, the corner morph, and the
// release decision, so a tracked drag and a programmatic open land in the
// same choreography. Pure functions — unit-tested, no RN imports.

/** Coupled phase: margin/corner morph completes here. */
export const STAGE_COUPLED_END = 0.18;

/** The collapsed pill is fully faded out at this progress. */
export const STAGE_PILL_GONE = 0.25;

/** Expanded content finishes its reveal (and input opens) here. */
export const STAGE_CONTENT_GATE = 0.5;

/** Release commit: dragging this fraction of the travel past the start
 *  anchor flips the decision (deck edge — tighter than the generic 0.4). */
export const STAGE_COMMIT_FRACTION = 0.3;

/** Fling override: px/s beyond which the release direction wins outright. */
export const STAGE_FLING_VELOCITY = 600;

export type StageAnchor = 'expanded' | 'collapsed';

const clamp01 = (v: number): number => {
  'worklet';
  return Math.min(1, Math.max(0, v));
};

/**
 * The collapsed pill's opacity: 1 at rest, 0 at STAGE_PILL_GONE — its fade
 * window ends exactly where the expanded content's reveal begins.
 */
export function stageCollapsedAlpha(progress: number): number {
  'worklet';
  if (!Number.isFinite(progress)) return 1;
  return 1 - clamp01(
    (progress - STAGE_COUPLED_END) / (STAGE_PILL_GONE - STAGE_COUPLED_END),
  );
}

/**
 * The expanded content's opacity: invisible through the pill's fade window
 * so the rising sheet reads as a surface first, then fades in and is fully
 * revealed exactly at the input gate.
 */
export function stageContentAlpha(progress: number): number {
  'worklet';
  if (!Number.isFinite(progress)) return 0;
  return clamp01(
    (progress - STAGE_PILL_GONE) / (STAGE_CONTENT_GATE - STAGE_PILL_GONE),
  );
}

/** Scrim over the uncovered region: rises with the sheet, stays subtle. */
export function stageScrimAlpha(progress: number): number {
  'worklet';
  if (!Number.isFinite(progress)) return 0;
  return clamp01(progress) * 0.5;
}

/**
 * Top-corner radius over the coupled phase: the pill's card radius at rest,
 * the sheet radius mid-rise, snapping square only at the completed expanded
 * anchor (the same corner rule the CMP deck used).
 */
export function stageTopRadius(
  progress: number,
  restRadius: number,
  sheetRadius: number,
): number {
  'worklet';
  if (!Number.isFinite(progress)) return restRadius;
  if (progress >= 0.999) return 0;
  const coupled = clamp01(progress / STAGE_COUPLED_END);
  return restRadius + (sheetRadius - restRadius) * coupled;
}

/**
 * Release decision — the shared sheet contract: fling wins on direction,
 * otherwise the drag must cross the commit fraction from its start anchor;
 * an ambiguous release settles back to the start side.
 */
export function resolveStageAnchor(
  dragStart: number,
  current: number,
  velocityY: number,
  commitFraction?: number,
  flingVelocity?: number,
): StageAnchor {
  'worklet';
  // Default values via `??` in the body, not the signature — a worklet's
  // default-parameter initializers can't reference module scope (the
  // transform captures body refs into __closure only), so the signature
  // form throws ReferenceError on the UI runtime.
  const commit = commitFraction ?? STAGE_COMMIT_FRACTION;
  const fling = flingVelocity ?? STAGE_FLING_VELOCITY;
  if (Number.isFinite(velocityY) && velocityY <= -fling) {
    return 'expanded';
  }
  if (Number.isFinite(velocityY) && velocityY >= fling) {
    return 'collapsed';
  }
  if (dragStart <= 0.5 && current - dragStart >= commit) {
    return 'expanded';
  }
  if (dragStart >= 0.5 && dragStart - current >= commit) {
    return 'collapsed';
  }
  return dragStart >= 0.5 ? 'expanded' : 'collapsed';
}
