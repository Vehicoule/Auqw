# Wave-3 shard report — mobile-app

Scope: `apps/mobile/src/**` (adapters, session composition, dev routes).
Base: `a675a7b` (pre-squash appshell tip — rebased onto `origin/main` for the PR).

## Result

22 files changed, +851/−1252 = **net −401 LoC** (tests untouched — they are the contract).

Every live src file was swept; only three files ended unchanged because they
are already minimal: `expo-connectivity.ts` (116 — refcounted watch
subscription with real rollback semantics), `pot-provider.ts` (32),
`home-card.ts` (31).

## What was done

- `controller.ts` (the largest cut): bundled-plugin triples collapsed to a
  `BUNDLED_PLUGINS` table; per-surface container preference hoisted to a
  named const (webm-first Android, mp4-only iOS); settings-defaults doc
  comment compressed into the object; provider-repair guard flattened.
- Repeated call guards folded across player / sync / transfer / secure-keys
  adapters — one shared guard shape per adapter family.
- Dead surface members dropped; type exports narrowed to actual
  cross-file use (self-only types un-exported, dead `Result` import gone).

## Deliberately not touched

- All `*.test.ts` — the behavior contract.
- `expo-connectivity.ts`, `pot-provider.ts`, `home-card.ts` — read and
  judged already-minimal; churn would only obscure them.
- Cancellation/dispose guards whose check sits at a distinct seam
  (pre-op vs post-await) — folding them into one helper would move the
  check point, which is exactly the class of drift the wave-3 review
  rounds caught elsewhere.

## Cross-shard notes

- `expo-connectivity` and the desktop connectivity adapter could share a
  refcounted-subscribe helper — it lives one level too high for this
  shard's boundary (ports differ).

## Gates

- `pnpm -C apps/mobile typecheck` — green.
- `pnpm -C apps/mobile test` — green ("mobile shell tests passed").
