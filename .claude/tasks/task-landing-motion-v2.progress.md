# task-landing-motion-v2 — progress sentinel

current_milestone: 7/7 DONE (fix-round after code-review APPROVE + Mode B PASS)
last_commit: (pending — fix-round wip)
last_push: (pending — fix-round wip)
pr: https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/406

## Fix-round (post-review, 5 findings)

1. [x] MED `__root.tsx` orchestrator: double-click guard — extracted cancellable
       `lib/wipe-transition.ts` (module-level generation counter + `.stop()` on
       supersede); `cancelWipeTransition()` called unconditionally on EVERY
       `onBeforeNavigate` (not just wipe→wipe) so a wipe→light/reduced double-click
       also resets the overlay instead of leaving it stuck mid-sweep. Unit tests:
       double-click, triple-click, explicit cancel, no-op-safe. Live-verified
       (synchronous double `.click()` on two different nav links → overlay ends at
       `translateX(-100%)`, not stuck).
2. [x] MED `lib/smooth-scroll.ts`: module-level `activeScroll` handle, cancelled
       on repeat call AND on first `wheel`/`touchstart` during the animation
       (`{once:true}` + explicit cleanup on natural completion so no stale listener
       lingers). 4 new unit tests.
3. [x] MED `ui/input.tsx`+`textarea.tsx`: `transition-[border-color_150ms_ease,box-shadow_200ms_ease]`
       only ever compiles to `transition-property` (invalid value, silently
       dropped) — fixed via Tailwind arbitrary-PROPERTY syntax
       `[transition:border-color_150ms_ease,box-shadow_200ms_ease]` (sets the raw
       `transition` shorthand). Chose to KEEP both durations distinct (150ms
       border-color per §M.2's literal hover row, 200ms box-shadow = pre-existing
       focus-visible ring, unrelated to M.2) rather than collapsing to one value.
       Verified compiled CSS live: `transition: border-color 150ms ease,box-shadow 200ms ease;`.
4. [x] MED `routes/index.tsx` Services grid: `revealAt={0.6 + i * 0.1}` →
       `revealAt={0.6 + i * 0.05}` per §M.1.0 (matches case-study stagger).
5. [x] INFO cross-page hash landing (`/careers` → `/#contact`) had no
       HEADER_OFFSET (same-page `smoothScrollToId` path already accounted for it,
       cross-page native `scrollIntoView` didn't) — added `scroll-mt-[82px]`
       (= HEADER_OFFSET) to all 6 hash-anchor `<section>`s in `routes/index.tsx`.
       Verified compiled CSS (`scroll-margin-top: 82px`) + live cross-page nav:
       `#contact` lands at `rectTop: 81.9px` (was 0, hidden under header).

Gate: eslint MCP clean + `tsc --noEmit` clean + 101/101 vitest (92+9 new) +
`build:prerender` green (local scratch API origin, no prod touch) +
Lighthouse CI leg runs automatically on push (paths: `apps/landing/**`).

## Milestones

1. [x] §M.0 motion tokens + §M.3/§M.4 pure-function lib modules (page-transition.ts, smooth-scroll.ts) + unit tests
2. [x] §M.1 ScrollReveal + hero glow/terminal docking + process connector-line + case-study metric-lag + tech-stack chip-wave
3. [x] §M.3 page-transition-overlay + BackLink + \_\_root.tsx orchestrator + <main> wrap on all routes — manually verified live (dev server :3210, playwright): wipe overlay resets off-screen after nav, light back-nav works, no new console errors beyond pre-existing (no-API-running) vacancies fetch fail. Known benign dev-only framer-motion console warning ("non-static position") from useScroll(target) without custom container — cosmetic, stripped in prod build, doesn't affect behavior.
4. [x] §M.2 hover-language (nav/footer underline via shared `hashLinkProps` + shared `lib/hash-link-props.ts`, card glow, chip lift, vacancy-card arrow bg, input/textarea hover border) + §M.4 smooth-scroll wiring in nav/footer — manually verified live: `smoothScrollToId` lands section exactly at header-offset (82px = 66+16, confirmed via evaluate), Tailwind v4 uses native `scale`/`translate` CSS properties (not `transform`) for after:scale-x-\* utilities — confirmed hover-variant rule present in compiled stylesheet wrapped in `@media (hover: hover)` (touch-safe by construction).
5. [x] Full test/lint/typecheck pass + E2E (existing 22 responsive) — REAL bug caught: `TechStackChips` reduced-motion branch never attached the `useScroll` target ref → framer-motion "Target ref is defined but not hydrated" hard crash on `/` under `prefers-reduced-motion` (error boundary fallback, no footer → all home-page E2E timed out). Fixed (attach ref in both branches). Spun up isolated scratch DB (`crm_scratch_motionv2`, dropped after) + API on :3211 + landing on :3210 to seed 1 PUBLISHED vacancy and get real 22/22 (not just 15/22 skip-graceful) — never touched shared crm_db. 92 vitest still green, typecheck clean.
6. [x] Lighthouse: mobile perf 0.93/a11y 0.96-1.0/bp 0.96/seo 1.0 (median of 3, both routes); desktop perf 1.0/a11y 0.96-1.0/bp 0.96/seo 1.0 — all ≥0.90, gate green. Rebased onto origin/main (PR #405 landed meanwhile, zero file overlap with apps/landing) — 26 files changed, three-dot diff clean. Re-ran full 22/22 E2E + 92 vitest + typecheck/lint post-rebase — all green. Fixed unrelated apps/web routeTree.gen.ts staleness (gitignored, regenerated via `pnpm --filter @crm/web build`) that blocked the pre-push hook's full-repo typecheck. M.6 checklist fully verified live (bidirectional ScrollReveal, overlay pointer-events-none + reset, light-variant back/forward, focus-to-main, reduced-motion on all 3 routes via E2E). DONE — see final commit.

files_done:

- apps/landing/app/lib/motion.ts
- apps/landing/app/lib/page-transition.ts
- apps/landing/app/lib/smooth-scroll.ts
- apps/landing/app/**tests**/page-transition.spec.ts
- apps/landing/app/**tests**/smooth-scroll.spec.ts

files_pending:

- apps/landing/app/components/marketing/scroll-reveal.tsx
- apps/landing/app/components/marketing/page-transition-overlay.tsx
- apps/landing/app/components/marketing/back-link.tsx
- apps/landing/app/components/marketing/process-steps-grid.tsx
- apps/landing/app/components/marketing/case-study-card.tsx (metric-lag)
- apps/landing/app/components/marketing/tech-stack-chips.tsx (chip-wave)
- apps/landing/app/components/marketing/nav.tsx (hover + smooth-scroll)
- apps/landing/app/components/marketing/footer.tsx (hover + smooth-scroll)
- apps/landing/app/components/marketing/vacancy-card.tsx (arrow bg hover)
- apps/landing/app/components/ui/card.tsx (glow prop)
- apps/landing/app/components/ui/chip.tsx (hover lift)
- apps/landing/app/components/ui/input.tsx / textarea.tsx (hover border)
- apps/landing/app/routes/index.tsx (main wrap, ScrollReveal swap, hero effects)
- apps/landing/app/routes/\_\_root.tsx (orchestrator)
- apps/landing/app/routes/careers.tsx (main tabIndex)
- apps/landing/app/routes/careers\_.$slug.tsx (main tabIndex, BackLink)
