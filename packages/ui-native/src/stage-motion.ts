// Stage-sheet morph staging — the OpenTune-adapted transition the CMP deck
// used: one continuous progress (0 = collapsed pill, 1 = expanded sheet)
// drives the pill fade, the content reveal, the corner morph, and the
// release decision, so a tracked drag and a programmatic open land in the
// same choreography. Pure functions — unit-tested, no RN imports.

/** Coupled phase: margin/corner morph completes here. */
const STAGE_COUPLED_END = 0.18;

/** The collapsed pill is fully faded out at this progress. */
const STAGE_PILL_GONE = 0.25;

/** Expanded content finishes its reveal (and input opens) here. */
const STAGE_CONTENT_GATE = 0.5;

/** Fling override: px/s beyond which the release direction wins outright
 *  — OpenTune BottomSheet.kt's performFling threshold. */
const SHEET_FLING_VELOCITY = 250;

const clamp01 = (v: number): number => {
  'worklet';
  return Math.min(1, Math.max(0, v));
};

/**
 * The coupled-phase fraction: bounds, radius and background morphs all
 * interpolate over the same 0..1 slice of progress so the pill grows
 * into the sheet as one surface.
 */
export function stageCoupled(progress: number): number {
  'worklet';
  if (!Number.isFinite(progress)) return 0;
  return clamp01(progress / STAGE_COUPLED_END);
}

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
  const coupled = stageCoupled(progress);
  return restRadius + (sheetRadius - restRadius) * coupled;
}

// ---- Unified vertical axis (OpenTune BottomSheet.kt's single `value`) ----
//
// One continuous pixel position over the collapsed anchor drives the
// whole gesture: raw > 0 is above the rest anchor (climbing toward the
// expanded sheet), raw < 0 is below it (sinking into the dismiss slide).
// OpenTune keeps a single `value` between dismissedBound and
// expandedBound; raw = value - collapsedBound is the same measure shifted
// so zero sits on the pill. A drag can cross the collapsed→dismissed
// boundary without re-anchoring — the pill just keeps traveling with
// the finger into the slide-off.

export type SheetTarget = 'expanded' | 'collapsed' | 'dismissed';

/**
 * The shared-value pair the raw position maps onto: `progress` covers
 * raw > 0 (the morph), `gone` covers raw < 0 (the dismiss slide).
 */
export function stageSheetWrite(
  rawPx: number,
  travelPx: number,
  collapsedPx: number,
): { readonly progress: number; readonly gone: number } {
  'worklet';
  if (!Number.isFinite(rawPx)) return { progress: 0, gone: 0 };
  const travel = Math.max(1, travelPx);
  const collapsed = Math.max(1, collapsedPx);
  if (rawPx >= 0) {
    return { progress: clamp01(rawPx / travel), gone: 0 };
  }
  return { progress: 0, gone: clamp01(-rawPx / collapsed) };
}

/**
 * Release decision — OpenTune's performFling, verbatim semantics on the
 * raw axis: a fast enough fling commits by direction (down only dismisses
 * when the sheet is already below the collapsed anchor — the same
 * `value < collapsedBound` check), otherwise the zone midpoints decide:
 * above half the expand travel → expanded, below half the dismissed
 * strip → dismissed, between → collapsed.
 */
export function resolveSheetTarget(
  rawPx: number,
  travelPx: number,
  collapsedPx: number,
  velocityY: number,
): SheetTarget {
  'worklet';
  if (!Number.isFinite(rawPx)) return 'collapsed';
  const travel = Math.max(1, travelPx);
  const collapsed = Math.max(1, collapsedPx);
  if (Number.isFinite(velocityY)) {
    if (velocityY <= -SHEET_FLING_VELOCITY) return 'expanded';
    if (velocityY >= SHEET_FLING_VELOCITY) {
      return rawPx < 0 ? 'dismissed' : 'collapsed';
    }
  }
  if (rawPx >= travel / 2) return 'expanded';
  if (rawPx < -collapsed / 2) return 'dismissed';
  return 'collapsed';
}

// ---- Horizontal track-skip conveyor (the OpenTune-style sideswipe) ----
//
// The mini-player's row tracks the finger 1:1 while the incoming track's
// preview slides in from the edge it will occupy — a pager, not a button
// strip. Release past the commit fraction (or fling hard enough) runs the
// conveyor to the edge and commits the skip; anything less springs home.
// Directions: translationX < 0 = next, > 0 = previous — matching the
// physical page-forward/page-back of a horizontal pager.

/** Release commit: drag crossing this fraction of the row's width commits. */
export const SKIP_COMMIT_FRACTION = 0.36;

/** Fling override: px/s beyond which the release direction wins outright. */
export const SKIP_FLING_VELOCITY = 800;

/**
 * Edge rubber-band: with no track to land on the row still nudges so the
 * direction reads as a boundary — tanh() approaches the cap smoothly
 * instead of clamping dead (a linear dampener has a visible slope kink
 * where the resistance starts).
 */
const SKIP_RESIST_CAP = 48;

/**
 * Finger→conveyor translation for one drag event. `allowed` is whether
 * the dragged direction has a landing track at all; the row clamps to
 * one width either way so a full-width pull never overshoots the
 * incoming preview's seat.
 */
export function skipTravelPx(
  translationX: number,
  width: number,
  allowed: boolean,
): number {
  'worklet';
  const bound = Math.max(1, width);
  if (!Number.isFinite(translationX)) return 0;
  if (allowed) {
    return Math.min(bound, Math.max(-bound, translationX));
  }
  return SKIP_RESIST_CAP * Math.tanh(translationX / SKIP_RESIST_CAP);
}

/**
 * Release decision for the conveyor: a drag committed only when the
 * direction was allowed AND it crossed the width fraction or flung past
 * the velocity override. The velocity check keys on the drag's own
 * direction (sign of translationX) so a back-swipe into the release
 * can't commit the wrong side.
 */
export function resolveSkipCommit(
  translationX: number,
  velocityX: number,
  width: number,
  allowed: boolean,
): boolean {
  'worklet';
  if (!allowed || !Number.isFinite(translationX)) return false;
  const bound = Math.max(1, width);
  if (Math.abs(translationX) >= bound * SKIP_COMMIT_FRACTION) {
    return true;
  }
  return (
    Number.isFinite(velocityX) &&
    Math.abs(velocityX) >= SKIP_FLING_VELOCITY &&
    Math.sign(velocityX) === Math.sign(translationX)
  );
}

/** The conveyor's completion position for a committed direction. */
export function skipCommitEdge(translationX: number, width: number): number {
  'worklet';
  const bound = Math.max(1, width);
  return translationX < 0 ? -bound : bound;
}
