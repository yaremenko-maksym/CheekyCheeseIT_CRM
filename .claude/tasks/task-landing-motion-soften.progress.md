# task-landing-motion-soften — progress sentinel (hotfix round)

status: DONE
branch: fix/landing-motion-soften
pr: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/409
spec: docs/design/landing-redesign.md §M.0/M.1.1a/M.2a/M.3/M.3.0/M.4/M.5/M.6 (PR #408)

## Trigger

Owner feedback after PR #406 merged: yellow page-transition flash "very fast,
hits the eyes, epilepsy risk for some"; process connector-line crosses out
step-label text; vacancy-card hover "jumps" on first frame.

## Fixes (4 items)

1. **§M.3/§M.3.0 — page-transition redesign.** Full-screen `bg-primary` fill
   REMOVED entirely. New: dark scrim (`var(--background)`, opacity 0→0.94→0)
   - thin (`w-16`=64px) gradient caret-line (`transparent→primary→transparent`)
     sweeping `-15vw → 105vw`. New module `apps/landing/app/lib/scrim-transition.ts`
     (replaces `wipe-transition.ts`) — same cancellation-guard architecture
     (generation counter + `.stop()`) extended to track/cancel BOTH layers.
     `apps/landing/app/components/marketing/page-transition-overlay.tsx`
     rewritten as a 2-layer component exposing `{scrim, caret}` via
     `useImperativeHandle`. `apps/landing/app/lib/page-transition.ts`:
     variant type renamed `'wipe'|'light'` → `'full'|'light'`.
     **Live-verified quantitatively** (rAF-sampled scrim opacity + caret
     translateX every frame during a real navigation): scrim peaks at exactly
     0.94 (never 1.0), smooth non-linear ramp (EASE_SOFT), full lifecycle
     ≈500-520ms (target 500ms = top of 350-500ms range), caret sweeps
     -216px(-15vw of 1440px) → 1512px(105vw) and back to idle — both layers
     reset to idle after navigation resolves. No console errors/unhandled
     rejections during the cycle.
2. **§M.0 — smoothness.** `EASE_SOFT=[0.65,0,0.35,1]` (symmetric
   easeInOutCubic) replaces `EASE_STANDARD`/`EASE_EXIT` (removed) as the
   ONLY easing for time-based JS animations (page-transition, smooth-scroll).
   Durations up: DUR_SCRIM_IN=0.23 + DUR_SCRIM_OUT=0.27 = 500ms (was 460ms
   wipe), DUR_CARET_SWEEP=0.42, DUR_LIGHT_TRANSITION=0.26 (was 0.18).
   Every §M.2 hover-transition got an explicit `ease-out` Tailwind class
   (button.tsx, nav.tsx/footer.tsx link+burger, card.tsx, chip.tsx,
   vacancy-card.tsx) — CV-dropzone explicitly excluded per spec ("без
   изменений"). Input/Textarea border-color hover bumped 150ms→180ms
   (was exactly on the "≥150ms" boundary) with literal
   `cubic-bezier(0,0,0.2,1)` (raw arbitrary-property syntax, not a Tailwind
   utility class).
3. **§M.1.1a — connector-line.** Root cause: `absolute` line painted OVER
   `static` (non-positioned) card grid regardless of DOM order (CSS 2.1
   stacking rule) — line crossed through step-label text. Fix: `relative
z-10` on the grid wrapper + `z-0` on the line (structural) + `top-[34px]`
   → `top-[60px]` (geometry defense-in-depth for the ScrollReveal fade-in
   window). **Live-verified**: computed styles confirm `position:relative,
z-index:10` on grid vs `z-index:0` on line; screenshot shows the line
   visible ONLY in the card gaps, not crossing any label text.
4. **§M.2a — hover jump.** `will-change-transform` added to `ui/card.tsx`'s
   `hover` variant and `vacancy-card.tsx`'s `<Link>` (always-hover-active) —
   pre-promotes the element to its own compositor layer before the first
   `:hover`, avoiding the documented Chrome/compositor first-frame
   layer-promotion jump for a nested transform inside an
   already-transformed `ScrollReveal` ancestor. **Live-verified**: computed
   `will-change: transform` present on rendered ServiceCard; compiled
   stylesheet confirms the `.will-change-transform` rule exists (same class
   used verbatim in `vacancy-card.tsx`'s source).

## Gate

- eslint MCP: clean on every touched file (checked incrementally).
- `tsc --noEmit`: clean.
- vitest: 101/101 (`page-transition.spec.ts` + `smooth-scroll.spec.ts` updated
  for renamed variant/`EASE_SOFT`; `wipe-transition.spec.ts` deleted, replaced
  by `scrim-transition.spec.ts` — double/triple-click cancellation now covers
  BOTH scrim+caret layers, plus an explicit unhandled-rejection fix found
  during test-writing: `caretSweep`'s promise needed its own `.then(noop,noop)`
  since it isn't part of the main `Promise.all` gate).
- `pnpm lint`: clean (full `eslint app` sweep).
- `build:prerender`: green (local unreachable API origin, graceful empty-
  vacancies fallback — never touched prod).
- Lighthouse (CI methodology, `@lhci/cli@0.15.1`, `scripts/devops/lighthouserc.json`,
  prerendered `dist/`, median of 3 runs, `/` + `/careers/`):
  - Mobile: performance 0.92, accessibility 0.96-1.0, best-practices 0.96, seo 1.0
  - Desktop: performance 1.0, accessibility 0.96-1.0, best-practices 0.96, seo 1.0
  - All ≥0.90 — gate green on both profiles (mobile perf 0.93→0.92, negligible,
    not a regression concern).

ac_verified: 1,2,3,4
