# task-landing-motion-v3 — progress sentinel

current_milestone: 7/7 DONE
last_commit: (this commit)
last_push: (this push)
pr: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/419

## Milestones

1. [x] §M v3.0 motion tokens (motion.ts) — lift/morph tokens replace scrim/caret tokens.
2. [x] §M v3.1 lift cross-fade — `page-transition.ts` (direction rename), `lift-transition.ts`
       (new, testable exit player), `__root.tsx` orchestrator rewrite (single key-remounted
       wrapper, no AnimatePresence/scrim). `scrim-transition.ts` +
       `page-transition-overlay.tsx` deleted + their spec removed.
3. [x] §M v3.2 shared-element title morph — `title-morph.ts` (new: capture/consume/route-pair
       eligibility/overlay player), wired into `VacancyCard` (h3 capture), `careers_.$slug.tsx`
       (h1 capture on BackLink + forward consumer), `careers-list.tsx` (back consumer).
4. [x] §M v3.3 iOS-perf — `use-coarse-pointer.ts` (new hook), wired into `ScrollReveal` (touch ->
       one-shot `useInView`), `case-study-card.tsx` (metric-lag disabled on touch),
       `process-steps-grid.tsx` + `tech-stack-chips.tsx` (static fallback merged with reduced),
       `routes/index.tsx` (hero-glow/terminal-docking merged with reduced), `nav.tsx` (CSS-only
       `[@media(hover:none)]` backdrop-filter removal + opacity bump).
5. [x] §M v3.4 mobile audit fixes — `chip.tsx` (items-start + dot mt-offset),
       `case-study-card.tsx` (text-[1.35rem] min-[400px]:text-[1.9rem]).
6. [x] Unit tests — `lift-transition.spec.ts`, `title-morph.spec.ts`, `use-coarse-pointer.spec.ts`
       (new) + `page-transition.spec.ts`/`back-link.spec.tsx` updated for the rename. 122/122
       green (17 files).
7. [x] E2E — new opt-in `apps/e2e/tests/landing/motion-v3.spec.ts` (18 tests, §M v3.5 checklist);
       existing `responsive.spec.ts` (22 tests) still green. 40/40 on scratch DB
       (`crm_scratch_motionv3`, dropped after) + scratch API (:3301) + landing dev (:3300).
       Real bug caught + fixed during this pass: `focusMainLandmark()` was firing on
       `transition.pathname` state change / `onAnimationComplete`, both of which resolve at
       `onBeforeNavigate` time — BEFORE the router's async loader swaps in the real destination
       `<main>` (reliably reproduced under `prefers-reduced-motion`, no animation duration to
       mask the race). Fixed by gating focus on the router's `onResolved` event instead (same
       pattern the pre-v3 §M.3 orchestrator used).

## Verification (M v3.5 checklist — all confirmed)

- [x] No `AnimatePresence` anywhere in page-transition code (grep + code review).
- [x] Lift exit/enter — only `opacity`/`translateY`, no new overlay layer (scrim/caret files
      deleted; E2E asserts no `z-index:999`-style artifacts).
- [x] Back-direction (`popstate` + `<BackLink>`) enters with negative `y`, forward positive —
      code review (`__root.tsx` ternary) + E2E back-navigation test green.
- [x] Title-morph plays ONLY on `/careers <-> /careers/:slug`, only from `VacancyCard`/`BackLink`
      — all 6 fallback rows covered (E2E: direct load, Home-teaser source, reduced-motion;
      unit: ineligible route pair, multi-line source/dest, staleness).
- [x] Title-morph overlay `pointer-events:none` always; `willChange` never left in inline style
      after cleanup (overlay element itself is removed from DOM on completion).
- [x] iOS-perf: `useCoarsePointer()===true` -> `ScrollReveal` uses one-shot `useInView`, not
      continuous `useScroll`/`useTransform` (code review + E2E functional check).
- [x] Nav sticky header on touch — `getComputedStyle(nav).backdropFilter === 'none'`, opacity
      raised to ~95% (E2E assertion, both touch-true and touch-false variants).
- [x] Hero eyebrow Chip — dot/first-line alignment ≤3px at 320/375/390 (E2E
      `getBoundingClientRect()` + `Range.getClientRects()` measurement, all 3 widths).
- [x] Case-study metrics — zero column overlap at 320/375/390, all 3 cards (E2E measurement).
- [x] Lighthouse mobile/desktop — all 4 categories ≥90 median of 5 runs (local, scratch API
      origin, `build:prerender` + `@lhci/cli@0.15.1` same config/methodology as CI).

## Files changed

See PR #419 diff (26 files, +1299/-617).
