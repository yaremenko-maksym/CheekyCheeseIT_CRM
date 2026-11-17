# CRM Redesign v2 — native-feel mobile + desktop (design)

Date: 2026-11-11 · Status: approved by the owner 2026-11-11 · Supersedes: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md` (phases 1–8 of that program that never shipped are folded into the waves below).

## 1. Intent and why

The owner runs the company from the phone. Today the mobile CRM is the desktop UI squeezed down (sidebar →
burger Sheet, tables → card stacks), so it never feels like an app, and some interactions block the page (the
iPhone freeze when a file is picked — fixed separately in `task-ios-file-input-freeze`). The owner also wants the
desktop experience raised to the same level for every user of the platform.

Goal: a complete, phased redesign of every screen so that on phones and tablets the CRM looks and behaves like a
top-tier App Store app, and on desktop like the best modern SaaS tools — judged against named benchmarks, not
against our own previous state.

The owner's daily phone flows, in priority order (this sets the wave order):

1. Finance — adds transactions often, with a receipt photo.
2. Adds new employees / users.
3. Edits contracts.
4. Edits people profiles.
5. Stats — the balance between the two partners and the monthly net-profit chart.

## 2. Goals, non-goals, anti-goals

**Goals**

- Every screen scores **≥ 9.5 / 10 from every council member (minimum 3 members)** against the benchmark rubric,
  scored **separately for mobile, tablet and desktop** (all three must pass).
- Nothing blocks interaction: no main-thread freeze on any user action; INP < 200 ms for the owner's five flows,
  measured as defined in §8 (the gate number is Playwright Chromium under 4× CPU throttling; WebKit stalls are
  caught on the iOS Simulator; the owner's iPhone is the final check); uploads, saves and navigation never lock
  the UI.
- Phones/tablets: native-app interaction model (§4.2). Desktop: power-user model (§4.3).
- Installable PWA on iOS and Android that behaves correctly in standalone mode.

**Non-goals**

- A native (App Store / Play Store) app. One codebase, one data layer.
- A light theme (dark only — owner decision 2026-08-16, `design-gate.md`).
- New business features, new KPIs, new data, RBAC / business-rule changes. API changes are allowed only for data
  shape and transport (§4.6: pagination, field selection, an aggregate endpoint that replaces N requests, a
  lighter payload for a list), never for business rules; each goes through the normal coder + reviewer +
  security flow as its own task.
- The landing app (`apps/landing`).

**Anti-goals (failure even if it "works")**

- Prettier but slower, or animations that delay input.
- A mobile shell that hides a capability a role has on desktop (feature parity per role is mandatory; mobile may
  reorder and progressively disclose, never remove).
- Any regression in RBAC masking (junior allowlist, counterparty masking, finance visibility).
- A template / shadcn-default look (`foundation.md` §11 anti-patterns still apply).

## 3. Constraints

- Stack: React + Vite SPA, TanStack Router/Query/Form, Tailwind v4, shadcn/ui + Radix, sonner, cmdk, recharts,
  CodeMirror stay. No new UI framework. Pins per `.claude/rules/common/version-pins.md`; every change below
  updates that file in the same PR.
- **Stack changes (owner approved 2026-11-11), each its own Wave 0 PR with a full test run, revertible alone:**
  1. **React 18.3 → 19 + React Compiler** (`babel-plugin-react-compiler` beside the Lingui macro in
     `@vitejs/plugin-react`'s Babel config). Why: automatic memoisation cuts re-renders (phone INP).
     Optimistic writes stay in TanStack Query (`onMutate` / `setQueryData`, §4.6), because several screens and
     derived data read the same cache; `useOptimistic` is only for state local to one form. The PR first checks every dependency's React
     19 peer range; a dependency that does not support 19 blocks the PR, not the program.
  2. **Bottom sheet on Base UI `Drawer`** (`@base-ui/react`, the primitive under shadcn's current `Drawer`): swipe
     to dismiss and snap points, which the Radix-Dialog `sheet.tsx` lacks. Only the drawer comes from Base UI; the
     other primitives stay Radix. Vaul is not used (not installed; shadcn moved off it).
  3. **`framer-motion` → `motion`** (same library, current package name) with `LazyMotion` + `m` to cut the
     startup bundle; simple enter/exit transitions move to CSS.
  4. **Remove `jsdom`** (dev dependency; tests run on happy-dom) after a green `pnpm --filter @crm/web test`.
     Conditional: `@tanstack/react-virtual` only if a measured long list janks on the phone. Platform features
     instead of libraries: View Transitions API, CSS scroll-snap, container queries, `dvh` / safe-area.
- Product i18n: `uk` default + `en` via Lingui; every new or changed string in both catalogs; copy-reviewer gate
  on those two catalogs (the "five languages" clause of `design-gate.md` is the landing only). `foundation.md`
  still says "Russian UI" — stale; Wave 0 corrects it.
- Dark theme only. Brand: dark neutrals with warm amber undertone + brand yellow as the only high-energy accent
  (`foundation.md` §1). WCAG 2.2 AA.
- All existing project gates apply per PR: design-gate, responsive-design (4 classes), design-fidelity-review,
  code-reviewer, spec-reviewer, security-reviewer for finance/RBAC/auth surfaces, copy-reviewer, local E2E before
  push, merge only on the owner's explicit "merge".
- Data: development, screenshots and council material use the seed on a scratch/QA database only, never live
  `crm_db` (`live-db-access.md`). Council members are external models; no real personal or financial data goes to
  them.

## 4. Decided design direction

### 4.1 Architecture (decided — owner approved 2026-11-11)

- **One codebase, shared data layer** (queries, mutations, schemas, RBAC helpers). Where responsive CSS is
  enough, one component. Where the interaction model differs, **separate mobile and desktop layouts** of the same
  screen, selected at a breakpoint (a layout split, not a fork of logic).
- **PWA**: installable on iOS/Android. Wave 0 hardens it: `viewport-fit=cover` + safe-area insets, manifest
  `id` / `start_url` / `scope`, in-app back navigation for standalone mode (no browser back button),
  `apple-mobile-web-app-*` meta where needed.
- **Google SSO in the installed iOS app is a known risk** (the OAuth redirect may leave the standalone container
  for Safari, whose cookie jar is separate). Wave 0 tests it first on the iOS Simulator; if it fails, Wave 0 tries
  a fix that keeps the flow inside the app's scope. If no fix works, the PWA install is documented as "Android +
  desktop; iOS uses Safari" and **the other waves are not blocked** — the redesign targets Safari tabs and
  standalone equally.
- **Service-worker update must never reload under the user.** Today `apps/web/app/client.tsx` reloads on the next
  `visibilitychange` once a new worker took control — and returning from the iOS photo picker is such an event, so
  a deploy can wipe a half-filled transaction form or an upload. Wave 0 defers the reload while any form is dirty
  or an upload / mutation is in flight (and on the next idle navigation instead).

### 4.2 Phone / tablet interaction model

Taken from the benchmarks (`docs/design/research/2026-11-11-mobile-benchmarks.md`):

- **Bottom tab bar**, role-adaptive (Linear pattern): the 4 most-used destinations for the role + "More". For
  ADMIN by default: Finance · People · Stats · Home/Projects · More (final set decided in Wave 0 from the nav map).
- **Quick-add "+"** (Things 3 / Ramp), **role-aware**: it offers only the create actions the role already has
  (ADMIN/ACCOUNTANT: transaction with receipt-first capture — photo library and Files available, no forced
  `capture` — smart prefill, one required field first; other roles: their own create actions, or no "+" at all
  when the role has none). Visibility comes from the same RBAC helpers the screens use.
- **Bottom sheets** (resizable detents; library per §3) instead of centered modals; full-screen pages for long forms.
- **List rows** in the iOS idiom: large tap targets (≥ 44 px), swipe actions where safe, sticky section headers.
- **Gestures**: edge back-swipe (no conflicts with horizontal scrollers), pull-to-refresh on lists. Pull-to-refresh
  is an in-app gesture on the list scroller only, refetching its query, never a page reload, and is off while a
  sheet is open. iOS Safari's own page pull-to-refresh is not reliably disabled by `overscroll-behavior`, so Wave 0
  proves on the iOS Simulator that a sheet drag at `scrollTop` 0 and a pull on a list never reload the page (an
  acceptance criterion).
- **Never block**: optimistic updates with undo toasts, skeletons instead of spinners, background uploads with
  progress the user can leave, inputs ≥ 16 px (no iOS zoom), keyboard never covers the focused field
  (VisualViewport), `dvh`/`svh` units.
- **Tablet**: two-pane (list + detail) where the screen is a list→detail flow; tab bar or a slim rail.

### 4.3 Desktop interaction model

- Grouped, collapsible sidebar (existing app-shell, polished) + **Cmd/Ctrl+K command palette** with page-aware
  actions (Attio / Linear), `/` to search, `?` for the shortcut sheet, single-key shortcuts on list screens.
  WCAG 2.1.4: single-key shortcuts never fire while focus is in a text field, and the `?` sheet has a switch that
  turns them off (stored locally).
- Dense tables with URL-held filters, inline edit where the field is simple and the role may already edit it,
  bulk actions only where the API already supports the action per item (Mercury / Ramp).
- Record pages: summary header + tabs/sections (Attio pattern); an activity history only where the data is
  already exposed today.
- Side panels (sheet from the right) for create/edit instead of modal stacks.
- Charts follow table filters (Mercury cashflow pattern); tap/click a bar to drill down (Copilot Money).

### 4.4 Visual identity (my call — owner may overrule)

Keep the identity (dark, warm-amber neutrals, yellow accent) and raise its execution: hierarchy, rhythm,
surfaces/depth, motion, data-viz. The benchmarks may push token-level changes (spacing scale, radius, type
scale, surface steps, chart palette); those are made once in Wave 0 and are allowed. A different brand direction
is not in scope.

### 4.5 Relation to the old "restyle only" principle

`foundation.md` §12 ("restyle existing blocks, add nothing") is **relaxed for this program**: interaction patterns
may change (navigation model, quick-add, sheets, inline edit, command palette, progressive disclosure, merged or
split views). Still forbidden: new business data, new KPIs, removing a capability, changing business rules /
API / RBAC. `foundation.md` is updated in Wave 0 to say so.

### 4.5b Scope calls on new patterns (my calls)

- **Undo** exists only where the role already has a reversible action (delete / revert endpoint it is allowed to
  call). No new backend undo, no delayed-send queue for finance writes: a finance create/edit is sent at once,
  shown optimistically, and rolled back with a visible error on failure. No double submit: the submit control is
  disabled while the write is in flight and a money create is never retried automatically. A money create whose
  outcome is unknown (timeout, dropped connection) is resubmitted only with the **same idempotency key** the first
  attempt carried, so the server replays the row instead of writing a second one. Today salary, senior / drop /
  USDT income and dividend creates already require a client UUID `idempotencyKey`; `expense`, `admin-income`,
  `admin-transfer` and company deposit do not. **The first Wave 1 task** adds the key to those four, copying the
  existing pattern (client UUID + unique index + replay guard): a transport change (§2) with a DB migration, its
  own task with security-reviewer, prod DDL through the deploy flow. Until it ships, those four forms keep
  today's behaviour (no optimistic insert, no resubmit offer on an unknown outcome). Paid-transaction cascade
  guards and `payoutRequestId` guards are untouched.
- **Saved filter views** are out of scope (they are new data). Filters live in the URL (shareable, back-button
  safe), which is the existing pattern.
- **Cmd+K** = navigation + page-aware actions + search over data already loaded on the screen. Cross-entity
  server search is out of scope (it needs a new endpoint and an RBAC masking review).
- **Non-blocking upload** means the user may keep working and leave the screen inside the app while the upload
  runs (in-memory queue with progress in a global indicator). Surviving app close / offline (IndexedDB,
  service-worker queue) is out of scope.
- The old registry's Interviews work (kanban "approved" 2026-06) is not carried over; Interviews is redesigned in
  Wave 6 like every other screen.

### 4.6 Network discipline (owner requirement 2026-11-11)

Phones and tablets may need data in a different shape than desktop (a list row shows fewer fields; a card stack
groups or orders rows differently). That must never turn into extra or duplicate traffic. Rules for every screen:

- **One layout mounted.** The mobile/desktop split renders exactly one layout (a breakpoint hook / route-level
  switch), never both with one hidden by CSS — a hidden layout still mounts and still fetches. Legacy code that
  mounts both (`hidden md:block` + `md:hidden`, 2 files today) is listed in step 1 of the loop and converted when
  its screen is redesigned.
- **One query per dataset, for both layouts.** Mobile and desktop call the same query with the same key (the same
  params are part of that key); a per-layout shape is a `select` over that one query, so a breakpoint change never
  creates a second cache entry or a refetch. Pagination params (`limit`, `cursor`) are chosen per screen, not per
  layout: both layouts page with the same `limit` (mobile renders the same pages as an infinite card stack). A
  server-side shape parameter or a new endpoint is allowed only when it replaces several requests (aggregate) or
  cuts a payload that measurably hurts mobile; it then serves **both** layouts under one key, so the rule above
  still holds. The server applies row-level visibility and field masking **before** any aggregation or
  projection: an aggregate returns exactly what summing the role's visible, masked rows would give, and a
  client-chosen field list can never unmask a field (security-reviewer on every such endpoint).
- **No duplicates.** On one screen load and on each user action: no two requests with the same method + URL +
  params, no refetch caused by a remount, a breakpoint change, a sheet opening, or a tab switch inside the screen
  (correct `staleTime`, `refetchOnWindowFocus`/`refetchOnMount` set deliberately per query).
- **No waterfalls.** Independent requests start in parallel (route loader / `useQueries`); a request that waits on
  another is justified in the spec.
- **No over-fetch.** No request whose data the screen does not render or need for the next likely action;
  prefetch on intent (hover / press-in / route preload) only for the next likely screen.
- **Mutations** update the cache (optimistic / `setQueryData`) and invalidate exactly the keys whose server data
  they change — including derived data (a transaction write must still refresh balances, partner stats and
  dashboards that depend on it). What is forbidden is a blanket invalidation of unrelated keys, and refetching
  queries that are not mounted.

Verified per screen (§6 steps 1 and 6): a network log of the main flow (initial load, each primary action,
breakpoint change, back navigation) captured as a Playwright HAR (Chromium and WebKit) and, for the iOS check,
through Safari Web Inspector attached to the Simulator. Recorded per screen:
request count, duplicates (must be 0), waterfall depth, total transferred bytes, before vs after. The log is
part of the council material and a code-reviewer check; a duplicate request or an unused fetch is a finding
that blocks the implementation gate.

## 5. Quality gate — the council (per screen)

Mechanism: the `second-opinion` skill in **goal mode** (owner-stated goal: 9.5+/10 from every member, min 3).
Members: the flagship seats of that skill's Goal members table, as the skill defines them at run time (the skill
lives in the owner's out-of-repo `~/.claude/skills/second-opinion/`; the orchestrator constitutes the council;
this document does not name models). **Quorum is 3 (owner):** when a seat is unavailable and the skill's spare
cannot fill it, that screen's gate pauses; the bar is never checked by fewer than 3 members. In waves 3–8 the
work moves to the next screen meanwhile. In waves 0–2 it waits (they define the patterns every later screen
reuses), and the orchestrator tells the owner.

**Calibration (Wave 0, before any screen is scored):** the rubric gets written anchors at 6 / 8 / 9 / 9.5 / 10
per criterion. Static criteria (time-to-task, navigation, lists, sheets, states, data-viz, platform fit, a11y)
are calibrated by one council round on public screenshots of 2–3 benchmark apps; if the benchmarks do not land
around 9–10, the anchors are fixed first. Interaction criteria that need a running app ("never blocks", the
input part of "forms") cannot be scored from public screenshots; their anchors are measured thresholds instead
(10 = INP < 100 ms and no long task > 50 ms during an interaction, no input lost; 9.5 = INP < 200 ms and no long
task > 200 ms; below that it scales down to the < 5 floor at a visible freeze or a lost input).

Each council round receives:

- the screen's spec, the rubric (benchmark file, "Scoring rubric": 10 weighted criteria, scored separately for
  mobile, tablet and desktop; a score < 5 on "never blocks" or "forms and input" fails the screen), the
  benchmark patterns for this screen, and the list of rejected findings from earlier rounds;
- screenshots of every state (default / empty / loading / error / long-content) at 320, 375, 768, 1024, 1440 (the
  §6 frame set; on the running screen 375 comes from the iOS Safari Simulator), **for every role that sees the
  screen differently** (ADMIN / SENIOR / JUNIOR / HR / ACCOUNTANT / DROP; masked views included);
- **implementation gate only** (a mockup has none of these): a short screen recording of the main flow on the iOS
  Simulator, and measured facts: INP / long tasks for the main flow, overflow scan, touch-target scan, and the
  network log summary (§4.6: request count, duplicates, waterfall depth, bytes, before vs after). At the mockup
  gate the interaction criteria are scored from the spec's stated behaviour against written qualitative anchors
  (optimistic vs blocking, what happens to input on error / close); the measured thresholds apply only at
  the implementation gate. The < 5 hard floor holds at both gates: at the mockup gate it is scored from the
  stated behaviour (a spec that auto-retries a money create is < 5 on "never blocks" whatever the total;
  council ruling, Task 0.8 round 1).

**What the score is (my call):** each member gives one overall score n/10 per device class (mobile, tablet,
desktop),
using the rubric as its guide (the weighted total out of 100 divided by 10, with criteria that do not apply to the
screen — e.g. data-viz on a form — dropped and the weights renormalised). The bar is the overall score, not every
criterion; the hard floors stay (< 5 on "never blocks" or "forms and input" fails the screen whatever the total).

Two council checkpoints per screen:

1. **Mockup gate** — on the design (before code): target **≥ 9.0** from every member. Cheap to fix on paper.
   _(My call: a 9.5 bar on mockups doubles the paper rounds for little gain; the 9.5 bar is enforced on the
   implemented screen.)_
2. **Implementation gate** — on the running screen: target **≥ 9.5** from every member, on every device class.
   Max 10 rounds; at the cap the open findings and last scores go to the owner.

The orchestrator verifies every finding before fixing it and keeps a `rejected` list (scope creep, nits that fight
the constraints). Scores and the per-round table are recorded in the screen's registry row.

## 6. Per-screen loop

1. **Capture** the current screen (iOS Simulator Safari 375, Android emulator, desktop 1440) and list its blocks,
   actions and RBAC variants (what each role sees); capture the baseline network log (§4.6).
2. **Design** (`ui-ux-designer`, design-gate Tier 1): spec `docs/design/screens/<slug>.md` + mockups for 320 /
   375 / 768 / 1024 / 1440 (the `responsive-design.md` frame set plus the iPhone width) with all states, built against the benchmarks. Claude Design when available; otherwise HTML
   prototypes rendered to PNG (`design-gate: degraded`).
3. **Mockup council** (≥ 9.0) → design fixes → repeat.
4. **Owner look** (wave 0 and wave 1 screens: owner approval required before code; later waves: the owner gets
   the mockups and the work continues unless the owner objects). _(My call.)_
5. **Implement** (`coder`, worktree, PR per screen or per tight group), tests per task file, responsive AC.
6. **Verify**: Playwright widths 320/375/768/1024/1280/1440/1920; iOS Simulator Safari and installed PWA; Android
   emulator Chrome; performance measurement of the main flow; network log after vs baseline (0 duplicates, no
   unused fetch, no avoidable waterfall).
7. **Fidelity review** (ui-ux-designer Mode B) + code-reviewer + spec-reviewer + security-reviewer (finance,
   people/RBAC, contracts, auth) + copy-reviewer.
8. **Implementation council** (≥ 9.5) → fixes → repeat.
9. **Owner "merge"** → merge; registry row → `implemented` with the final scores.

## 7. Waves and screen inventory

37 route screens + the app shell + shared dialogs. Wave order follows the owner's daily flows.

Paths are relative to `apps/web/app/routes/_authenticated/` unless they start with `__root`, `login` or
`invoice` (those sit directly in `apps/web/app/routes/`). A layout route (`*/route.tsx`) belongs to the wave of
its first child screen.

| Wave                             | Scope                                                                                                                                                                                                                                                                                                                             | Screens                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Foundation**               | PWA hardening; app shell (mobile tab bar + "More", tablet rail, desktop sidebar + Cmd+K); design-system primitives: responsive sheet (bottom sheet ↔ side panel), list row, form field, quick-add, skeleton, undo toast, non-blocking upload, chart theme, page transitions; `foundation.md` v2; a showcase route for the council | `_authenticated/route.tsx` (shell), `__root.tsx`, nav-sidebar, notifications-bell, impersonation banner                                                                                                                      |
| **1 — Finance**                  | Transactions list, add/edit transaction with receipt, filters, the accountant views; public invoice                                                                                                                                                                                                                               | `_authenticated/finance/index.tsx` (+ its components), `invoice.v.$transactionId.tsx`                                                                                                                                        |
| **2 — People**                   | Add employee, users list, profiles (own and other, avatar, resume), teams                                                                                                                                                                                                                                                         | `users/index.tsx`, `profile/index.tsx`, `profile/$userId.tsx`, `team/index.tsx`, `team/$teamId.tsx`                                                                                                                          |
| **3 — Contracts & documents**    | Contract templates and editor, documents, onboarding contract flow, ToS                                                                                                                                                                                                                                                           | `admin/route.tsx` (admin layout + its tab navigation), `admin/contracts.index.tsx`, `admin/contracts.$role.tsx`, `documents.tsx`, `onboarding/route.tsx`, `onboarding/index.tsx`, `admin/tos.index.tsx`, `admin/tos.new.tsx` |
| **4 — Stats & home**             | Partner balance, monthly net-profit chart, role dashboards                                                                                                                                                                                                                                                                        | `stats.tsx`, `_authenticated/index.tsx`, `routing.tsx` (a redirect to `/`; the role dashboards in `routing/components/` render on home)                                                                                      |
| **5 — Projects & work**          | Projects list/detail, my project, legend, pending                                                                                                                                                                                                                                                                                 | `projects.tsx`, `projects/index.tsx`, `projects/$projectId.tsx`, `project.tsx`, `legend.tsx`, `pending/index.tsx`                                                                                                            |
| **6 — Recruiting**               | Vacancies, external job queue, interviews                                                                                                                                                                                                                                                                                         | `vacancies/index.tsx`, `vacancies/$vacancyId.tsx`, `job-queue/index.tsx`, `interviews/index.tsx`, `interviews/unmatched.tsx`                                                                                                 |
| **7 — Admin**                    | Admin home and settings                                                                                                                                                                                                                                                                                                           | `admin/index.tsx`, `admin/integrations.index.tsx`, `admin/login-as.tsx`, `admin/sources.index.tsx`, `admin/sources.$sourceId.tsx`, `admin/wallet.index.tsx`                                                                  |
| **8 — Auth, system, final pass** | Login, 404 / error / empty states, a whole-app consistency council                                                                                                                                                                                                                                                                | `login.tsx`, `components/not-found.tsx`, error boundaries                                                                                                                                                                    |

Each wave's screens are registered in `docs/design/screens/INDEX.md` (a new "v2" roadmap table replaces the old
one) before design starts. The exact list of modals/sheets per screen is captured in step 1 of the loop.

Wave 0 gates all others. Waves 1–2 are sequential (they define the patterns the rest reuse); from wave 3 on,
design of wave N+1 may overlap implementation of wave N.

## 8. Verification environment

- iOS Simulator (Safari, and the installed PWA) and Android emulator through the T3 device tools; desktop through
  Playwright. Dev stack on a scratch DB with seed data; dev login per role.
- Performance: INP measured with the `web-vitals` attribution build in Playwright Chromium under 4× CPU
  throttling (the gate number: INP < 200 ms, no long task > 200 ms during an interaction); on the iOS Simulator,
  Safari Web Inspector's timeline is used to catch WebKit-only stalls (freezes, reloads, layout thrash). Simulator
  timings run on the Mac's CPU and are indicative only, not the gate number; the owner's own iPhone is the final
  check for the owner's five flows.
- Every PR carries mobile + desktop screenshots and the council's final score table.

## 9. Budget and pacing

The owner budgets about two weeks of agent work, phased, and said there is no rush. **The bar does not move;
time flexes** (owner, 2026-11-11: "не тороплю"). The plan covers all waves; progress is reported per wave with
the scores, and a screen never ships below 9.5 without the owner's explicit sign-off. Expected cost driver: council rounds (3
flagship members × up to 10 rounds × 2 checkpoints × ~40 surfaces). Mitigations: mockup gate catches most issues
on paper; screens of one pattern family are reviewed together when they share a layout; a wave-level council
pass is used instead of per-screen passes for trivially derived screens (e.g. `sources.$sourceId` after
`sources.index`) — each screen still has to score ≥ 9.5.

## 10. Left to the builder (planner)

- The exact task breakdown per wave, PR boundaries, and which screens share a council pass.
- Wave 0 primitive list details and their API, the tab-bar destinations per role (from the nav map and RBAC).
- How the council material (screenshots, recordings, traces) is produced and stored
  (`docs/design/screens/<slug>/assets/`).

## 10b. Rollout (owner decision 2026-11-11)

No feature flag, no parallel v2 shell. Each wave ships to all users in prod after the owner's "merge". The new
shell owns the safe-area insets and the bottom tab-bar clearance on its content container (legacy screens need
no change to clear the notch, the home indicator or the tab bar). Legacy elements that size or position against
the viewport instead of the container are the exception: Wave 0 lists them by a code search in `apps/web/app` for
`fixed`, `sticky`, `h-screen` / `min-h-screen` / `100vh` (14 files today, e.g. `onboarding/route.tsx`,
`JobQueueCard.tsx`, the dialog / sheet primitives), puts the list in its task file, and fixes each one. Therefore
Wave 0 must keep **every legacy screen fully working inside the new shell** (tab bar / "More" / Cmd+K reach every
route a role has today; legacy modals still work inside the new chrome on mobile and desktop) — this is a Wave 0
acceptance criterion, checked on every route per role.

The same holds for nested layouts: the Wave 3 admin layout (`admin/route.tsx` and its tab navigation) must keep
the Wave 7 admin screens, still legacy at that point, fully working and reachable inside it — a Wave 3
acceptance criterion, checked on each admin child route.

## 11. Open items (owner)

- None blocking. The calls marked "my call" above (§4.4 visual identity kept, §5 mockup gate 9.0, §6 step 4 owner
  approval only for waves 0–1) stand unless the owner overrules them.
