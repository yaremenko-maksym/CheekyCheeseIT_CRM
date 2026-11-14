# CRM Redesign v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CRM screen redesigned to App Store-level phone/tablet UX and a polished desktop, each passing the council at ≥ 9.5/10 per device class, shipped wave by wave to all users.

**Architecture:** One codebase and one data layer; where interaction differs, a breakpoint hook mounts exactly one layout (mobile / tablet / desktop) over the same query key. Wave 0 builds the shell, the primitives, the stack changes and the measuring tools; waves 1–8 run the per-screen loop (capture → design → mockup council → implement → verify → implementation council → owner "merge").

**Tech Stack:** React 19 + React Compiler, Vite 6, TanStack Router (1.170.15 EXACT) / Query / Form, Tailwind v4, shadcn + Radix, Base UI `Drawer`, `motion` (LazyMotion), sonner, cmdk, recharts 3, Lingui (uk + en), Zod v4, vite-plugin-pwa, Vitest (happy-dom), Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` (owner approved 2026-11-11). Benchmarks and rubric: `docs/design/research/2026-11-11-mobile-benchmarks.md`.

## Global Constraints

- Pins per `.claude/rules/common/version-pins.md`; every dependency change updates that file in the same PR. TanStack router pair stays EXACT.
- Stack changes 1–4 (spec §3) are each their own PR, with a full test run, revertible alone.
- No new business data, no new KPIs, no removed capability, no change to business rules / API / RBAC — except the Wave 1 idempotency-key task (spec §4.5b).
- Every new or changed visible string: Lingui macro, both `uk` and `en` catalogs (`pnpm --filter @crm/web i18n:extract`). Repo text and code comments in English.
- Dark theme only; brand yellow is the only high-energy accent; WCAG 2.2 AA; touch targets ≥ 44 px on mobile; inputs ≥ 16 px font.
- Device classes: mobile `< 640`, tablet `640–1023`, desktop `≥ 1024` (px, CSS width).
- One layout mounted; one query key per dataset for both layouts (`select` per layout); same `limit` on both layouts; 0 duplicate requests per screen flow (spec §4.6).
- A money create is never auto-retried; an unknown outcome is resubmitted only with the same `idempotencyKey`.
- WCAG 2.1.4: a single-key shortcut never fires while focus is in an `input`, `textarea`, `select` or `[contenteditable]` (CodeMirror included); the `?` sheet has an off switch stored in `localStorage`.
- Pull-to-refresh refetches the list query only; never reloads the page; disabled while any sheet/dialog is open.
- The service worker never reloads the page while a form is dirty, an upload runs, or a mutation is in flight.
- Every legacy screen keeps working inside the new shell, for every role (spec §10b).
- Data: scratch/QA DB with seed only (`live-db-access.md`); no real personal or financial data in council material.
- Gates per PR: design-gate, responsive-design, design-fidelity-review, code-reviewer, spec-reviewer, security-reviewer (finance / RBAC / auth / contracts), copy-reviewer, local E2E before push, merge only on the owner's explicit "merge".
- Council: second-opinion goal mode, quorum 3; mockup gate ≥ 9.0, implementation gate ≥ 9.5 per device class; hard floor < 5 on "never blocks" or "forms and input" (implementation gate only).

## Review Focus

1. **iOS photo picker returns after a deploy, with a half-filled form.** Expected: no reload, input intact; the reload happens later on an idle navigation. Pinned in Task 0.6 (`does not reload on visibilitychange while busy`).
2. **Device class changes mid-flow** (iPad rotation, desktop window resize) with a sheet open or a dirty form. Expected: no refetch, no new cache entry, no lost input. Pinned in Task 0.5 (`same query key across classes`) and Task 0.4 (`keeps form state when the sheet switches presentation`).
3. **A role whose route has no tab** (including a teamless SENIOR, who loses `/projects` and `/interviews`). Expected: every route the role may open is reachable through tab bar or "More" (and Cmd+K on desktop), and none it may not open is shown; a role without create actions gets no "+". Pinned in Task 0.9 (`nav shows exactly the routes the role may open`), Task 0.10 (`palette lists exactly the nav routes for the role`) and Task 0.12 (`no quick-add for a role without create actions`).
4. **Typing in a text field or the CodeMirror contract editor.** Expected: a single-key shortcut (`c`, `/`, `?`) never fires. Pinned in Task 0.10 (`ignores keys from editable targets`).
5. **Pull or sheet drag at `scrollTop` 0 on iOS Safari.** Expected: the list refetches or the sheet closes; the page never reloads; edge back-swipe does not fight a horizontal scroller. Pinned in Task 0.11 (unit) and the Task 0.13 Simulator AC.

---

## How tasks map to the project flow

- Each task below becomes a task file `.claude/tasks/task-redesign-w<wave>-<n>.md` (Master writes it at dispatch, from this plan; acceptance criteria = the task's steps and tests).
- Writers (`coder`, `ui-ux-designer`, `autotest`, `devops`) run with `isolation="worktree"`; model per `jev.mjs route`.
- One PR per task unless the task says otherwise. Commit message ends with `ac_verified:`; push with `DATABASE_URL= git push`.
- Test commands: `pnpm --filter @crm/web test -- <path>`, `pnpm --filter @crm/web typecheck`, `pnpm --filter @crm/web lint`, `pnpm --filter @crm/e2e test -- <spec> --project=<project>`.
- Design tasks follow `docs/design/screens/_TEMPLATE.md` and `.claude/skills/claude-design-workflow/`; HTML prototypes rendered to PNG when Claude Design is unavailable (`design-gate: degraded`).

## Wave 0 dependency order

```
0.1 React 19 ─┐                     0.8 design (foundation v2, rubric calibration, shell + primitive mockups, owner OK)
0.2 motion   ─┤                          │
0.3 jsdom    ─┤  (stack PRs, parallel)    ▼
0.14 E2E infra┘ ──► 0.5 breakpoint ──► 0.4 sheet ──► 0.9 shell ──► 0.10 Cmd+K/shortcuts
0.6 reload guard (after the iOS-freeze PR merges)                 ──► 0.11 list/form/feedback primitives
0.7 PWA hardening                                                 ──► 0.12 quick-add
                                                                  ──► 0.13 legacy-in-shell sweep + Simulator proof
                                                                  ──► 0.15 showcase + implementation council
```

0.1–0.3, 0.6, 0.7, 0.14 and 0.8 have no code dependency on each other and run in parallel (concurrency ≤ 3–4 agents). Tasks are numbered by topic, not by run order: run 0.5 before 0.4. Task 0.9 needs 0.4, 0.5 and 0.7 merged and 0.8's owner approval. Tasks 0.10–0.12 each mount their own components in the shell slots that 0.9 provides (`TopBarSlots`).

---

## Wave 0 — Foundation

### Task 0.1: React 19 + React Compiler

**Files:**

- Modify: `apps/web/package.json` (`react`, `react-dom` → `^19`; `@types/react`, `@types/react-dom` → `^19`; add dev `babel-plugin-react-compiler` and dev `eslint-plugin-react-hooks` ≥ 6, which ships the compiler rules; the repo has no react-hooks plugin today)
- Modify: `apps/web/eslint.config.mjs` (register `react-hooks`, enable its recommended rule set including the compiler rules, scoped to `app/**/*.tsx?`)
- Modify: `apps/web/vite.config.ts` (the `react({ babel: { plugins } })` block: add `['babel-plugin-react-compiler', {}]` **first**, before the Lingui macro plugin)
- Modify: `.claude/rules/common/version-pins.md`, `pnpm-lock.yaml`
- Test: existing suites; new `apps/web/app/test/react-version.spec.ts`

**Interfaces:**

- Produces: React 19 APIs available to every later task (`use`, `useOptimistic`, ref-as-prop). Later tasks must not add `useMemo` / `useCallback` / `memo` for performance alone.

- [ ] **Step 1: Peer-range audit.** Run `pnpm --filter @crm/web why react` and list every package with a `react` peer range; record in the PR body which ones exclude 19. Any blocker → stop and report (spec: blocks the PR, not the program).
- [ ] **Step 2: Write the failing test** `react-version.spec.ts`: `expect(Number(React.version.split('.')[0])).toBe(19)`.
- [ ] **Step 3: Run it.** `pnpm --filter @crm/web test -- app/test/react-version.spec.ts` → FAIL (`18`).
- [ ] **Step 4: Bump** packages, add the compiler plugin, fix type errors from `@types/react` 19 (removed global `JSX` namespace → `React.JSX`; `useRef` requires an argument; `ReactElement` props default `unknown`). Fix code the compiler rule reports (it skips non-compliant components; report count in the PR).
- [ ] **Step 5: Verify.** `test`, `typecheck`, `lint` green (non-zero test count); `pnpm --filter @crm/web build` succeeds; `pnpm --filter @crm/e2e test --project=chromium` green locally; bundle-size before/after in the PR body.
- [ ] **Step 6: Commit** `build(web): React 19 + React Compiler` with `ac_verified:`.

### Task 0.2: `framer-motion` → `motion` + LazyMotion

**Files:**

- Modify: `apps/web/package.json` (remove `framer-motion`, add `motion` at the same major 12)
- Modify: the 57 files importing `framer-motion` (import path → `motion/react`; `motion.<tag>` → `m.<tag>`)
- Modify: `apps/web/app/routes/__root.tsx` (wrap the tree in `<LazyMotion features={domAnimation} strict>`)
- Modify: `apps/web/vite.config.ts` (`manualChunks`: the `node_modules/framer-motion/` match becomes `node_modules/motion/` + `node_modules/motion-dom/` + `node_modules/motion-utils/`, same chunk name)
- Modify: ESLint config of `apps/web` (`no-restricted-imports`: ban `framer-motion`, and ban the `motion` named export from `motion/react` with message "use m + LazyMotion")
- Modify: `version-pins.md`, lockfile

**Interfaces:**

- Produces: the rule "animate with `m.*` under the root `LazyMotion`; simple enter/exit as CSS (`@starting-style` / Tailwind `transition-*`)". `strict` makes a stray `motion.*` throw in dev.

- [ ] **Step 1: Codemod** imports and `motion.` → `m.` (ast-grep rule, not sed; record the rule in the PR body).
- [ ] **Step 2: Move trivial transitions to CSS** only where the component animates opacity/translate on mount/unmount with no layout or gesture props; leave `layout`, `drag`, `AnimatePresence` users on `m`.
- [ ] **Step 3: Verify.** `grep -rn "framer-motion" apps/web/app` → 0 lines (confirm grep read the dir: `ls apps/web/app` non-empty); `test`, `typecheck`, `lint`, `build` green; E2E chromium green; initial JS chunk size before/after in the PR body (expect a drop).
- [ ] **Step 4: Commit** `build(web): framer-motion -> motion with LazyMotion`.

### Task 0.3: Remove `jsdom`

**Files:**

- Modify: `apps/web/package.json` (remove dev `jsdom`), lockfile, `version-pins.md` if listed

- [ ] **Step 1:** `grep -rn "jsdom" apps/web --include='*.ts' --include='*.tsx' --include='*.json' --exclude-dir=node_modules` → only `package.json` (any `@vitest-environment jsdom` docblock: switch to happy-dom and make the test pass).
- [ ] **Step 2:** Remove; `pnpm install`; `pnpm --filter @crm/web test` green with the same passed-test count as before (state both counts).
- [ ] **Step 3: Commit** `build(web): drop unused jsdom`.

### Task 0.4: Base UI Drawer + `ResponsiveSheet` primitive

**Files:**

- Modify: `apps/web/package.json` (add `@base-ui/react`), `version-pins.md`, lockfile
- Create: `apps/web/app/components/ui/responsive-sheet.tsx`
- Create: `apps/web/app/components/ui/bottom-sheet.tsx` (Base UI `Drawer` skin: handle, detents, safe-area padding)
- Test: `apps/web/app/components/ui/__tests__/responsive-sheet.test.tsx`

**Interfaces:**

- Consumes: `useDeviceClass()` (Task 0.5).
- Produces:

  ```ts
  interface ResponsiveSheetProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: React.ReactNode // rendered as the accessible name on every class
    description?: React.ReactNode
    detents?: ('content' | 'half' | 'full')[] // mobile only; default ['content', 'full']
    side?: 'right' | 'center' // tablet/desktop presentation; default 'right'
    dismissible?: boolean // default true; false while a write is in flight
    footer?: React.ReactNode // sticky action bar, above the keyboard on mobile
    children: React.ReactNode
  }
  export function ResponsiveSheet(props: ResponsiveSheetProps): React.JSX.Element
  ```

  Mobile → `BottomSheet` (swipe to dismiss, detents); tablet/desktop → existing Radix `Sheet` (`side`) or `Dialog` (`center`). Content renders through one child slot so state lives in the caller.

- [ ] **Step 1: Write failing tests:**
  - `renders a bottom sheet on mobile and a side panel on desktop` — mock `useDeviceClass` → `'mobile'` → `getByRole('dialog')` has `data-presentation="bottom"`; `'desktop'` → `data-presentation="side"`.
  - `keeps form state when the sheet switches presentation` — type `"42"` into an input inside; rerender with class `'desktop'`; input value is still `"42"` (state held by the caller's form, children keyed stably).
  - `does not close while dismissible is false` — press `Escape`; `onOpenChange` not called.
  - `labels the dialog with title on every class` — `getByRole('dialog', { name: 'T' })` on all three classes.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement.** Base UI `Drawer` for `bottom-sheet.tsx`; `ResponsiveSheet` picks presentation from `useDeviceClass()`. The `dialog` role and `data-state="open"` must be present on the bottom sheet too, so `useAnyDialogOpen()` (`hooks/use-any-dialog-open.ts`) keeps seeing it — add a test `useAnyDialogOpen is true while the bottom sheet is open`.
- [ ] **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(web): ResponsiveSheet on Base UI Drawer`.

### Task 0.5: Device-class hook

**Files:**

- Create: `apps/web/app/hooks/use-device-class.ts`
- Test: `apps/web/app/hooks/__tests__/use-device-class.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type DeviceClass = 'mobile' | 'tablet' | 'desktop'
  export const DEVICE_QUERIES: Record<Exclude<DeviceClass, 'mobile'>, string>
  // tablet: '(min-width: 640px)', desktop: '(min-width: 1024px)'
  export function getDeviceClass(): DeviceClass // pure read of matchMedia; 'desktop' when window is undefined
  export function useDeviceClass(): DeviceClass // useSyncExternalStore over matchMedia 'change'
  export function ByDevice(props: {
    mobile: React.ReactNode
    tablet?: React.ReactNode
    desktop: React.ReactNode
  }): React.ReactNode
  // renders exactly one branch; tablet falls back to desktop
  ```

- [ ] **Step 1: Write failing tests** (stub `window.matchMedia` with a controllable fake):
  - `maps widths to classes` — 375 → `'mobile'`, 639 → `'mobile'`, 640 → `'tablet'`, 1023 → `'tablet'`, 1024 → `'desktop'`.
  - `re-renders on a media change` — start 375, fire change to 1024 → hook returns `'desktop'`.
  - `ByDevice mounts only one branch` — render with spies in each branch; at 375 only the mobile spy has mounted; the desktop component's mount spy was never called.
  - `same query key across classes` — a child of both branches calls `useQuery({ queryKey: ['x'] })`; switch 375 → 1024; `queryClient.getQueryCache().findAll({ queryKey: ['x'] })` has length 1 and the fetcher was called once (`staleTime: 30_000`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `useSyncExternalStore` (subscribe to both media queries).
- [ ] **Step 4: Run** → PASS; lint.
- [ ] **Step 5: Commit** `feat(web): useDeviceClass + ByDevice (one layout mounted)`.

### Task 0.6: Service-worker reload guard

Starts after the iOS-freeze PR (`fix/ios-file-input-freeze`) merges; if that PR already added a deferral, this task generalises it instead of duplicating it.

**Files:**

- Create: `apps/web/app/lib/reload-guard.ts`
- Modify: `apps/web/app/lib/sw-reload.ts`, `apps/web/app/client.tsx` (SW block), `apps/web/app/router.tsx` (navigation subscription)
- Modify: `apps/web/app/lib/query-client.ts` (add `export const queryClient = createQueryClient()`, the app singleton) and `apps/web/app/routes/__root.tsx` (import it instead of its module-level `const queryClient = createQueryClient()`), so `client.tsx` can read `queryClient.isMutating()`
- Modify: the legacy create-transaction form (`routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx`) and `finance/components/ReceiptInput.tsx`: `useReloadGuard(form dirty, 'dirty-form')` and `useReloadGuard(upload in flight, 'upload')`, so Step 5 tests a real guarded form before the Wave 1 redesign
- Create: `apps/web/app/hooks/use-reload-guard.ts`
- Test: `apps/web/app/lib/__tests__/reload-guard.spec.ts`, extend `apps/web/app/lib/sw-reload.spec.ts`

**Interfaces:**

- Produces:
  ```ts
  // reload-guard.ts — module state, readable outside React (client.tsx)
  export function holdReload(reason: 'dirty-form' | 'upload' | 'mutation'): () => void // returns release; idempotent
  export function isReloadHeld(): boolean
  export function onReloadReleased(cb: () => void): () => void
  // use-reload-guard.ts
  export function useReloadGuard(active: boolean, reason: 'dirty-form' | 'upload'): void
  // sw-reload.ts — extended
  export interface SWReloadOptions {
    hadControllerAtLoad: boolean
    alreadyReloading: boolean
    pageVisible: boolean
    busy: boolean // new: isReloadHeld() || queryClient.isMutating() > 0 (the singleton exported from lib/query-client.ts)
    navigating: boolean // new: true when called from a router navigation
  }
  // returns true iff hadControllerAtLoad && !alreadyReloading && !busy && (!pageVisible || navigating)
  ```
- Consumers: every form primitive (Task 0.11 `FormField` host form) calls `useReloadGuard(form.state.isDirty, 'dirty-form')`; the upload queue (Task 0.11) calls `holdReload('upload')` per job.

- [ ] **Step 1: Write failing tests:**
  - `does not reload on visibilitychange while busy` — `{hadControllerAtLoad:true, alreadyReloading:false, pageVisible:false, busy:true, navigating:false}` → `false`.
  - `reloads on the next idle navigation` — `{…, pageVisible:true, busy:false, navigating:true}` → `true`.
  - `still reloads on hide when idle` — `{…, pageVisible:false, busy:false, navigating:false}` → `true`.
  - `release is idempotent` — `const r = holdReload('upload'); r(); r(); expect(isReloadHeld()).toBe(false)` with a second, unreleased hold → `true`.
  - `onReloadReleased fires once when the last hold drops`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; in `client.tsx`, `flushPendingReload` passes `busy` and `navigating`; subscribe `router.subscribe('onResolved', …)` with `navigating:true`, and `onReloadReleased` re-checks with `navigating:false`.
- [ ] **Step 4: Run** → PASS; existing `sw-reload.spec.ts` cases updated to the new options and still green.
- [ ] **Step 5: Simulator AC.** iOS Simulator Safari on a preview build: open the transaction form, type an amount, trigger a deploy (bump SW), open and close the photo picker → no reload, amount intact; navigate → reload happens. Screen recording path in the PR body.
- [ ] **Step 6: Commit** `fix(web): defer SW reload while a form, upload or mutation is busy`.

### Task 0.7: PWA hardening

**Files:**

- Modify: `apps/web/index.html` (`viewport` → `width=device-width, initial-scale=1, viewport-fit=cover`; add `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-mobile-web-app-title`)
- Modify: `apps/web/public/site.webmanifest` (add `"id": "/"`, `"start_url": "/"`, `"scope": "/"`)
- Modify: `apps/web/app/styles/globals.css` (`--safe-top|right|bottom|left: env(safe-area-inset-*)` custom properties)
- Create: `apps/web/app/hooks/use-standalone.ts`
- Test: `apps/web/app/hooks/__tests__/use-standalone.test.ts`, `apps/web/app/test/pwa-manifest.spec.ts`

**Interfaces:**

- Produces: `useStandalone(): boolean` (`display-mode: standalone` media query or `navigator.standalone`); the shell (Task 0.9) shows an in-app back button in the top bar when `useStandalone() && canGoBack` (`router.history.canGoBack()`); CSS vars `--safe-*` used by the shell only.

- [ ] **Step 1: Failing tests:** manifest JSON has `id`, `start_url`, `scope` equal to `"/"`, and `display` `"standalone"`; `index.html` viewport contains `viewport-fit=cover`; `useStandalone` true when the fake media query matches.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Google SSO in standalone (Simulator).** Install the PWA from Safari on the iOS Simulator, sign in through Google. Record the outcome in `docs/design/research/2026-11-11-pwa-ios-sso.md`: works / fails + the fix tried. If no fix keeps the flow in scope: document "PWA install: Android + desktop; iOS uses Safari" there and in `foundation.md` — not a blocker for other tasks.
- [ ] **Step 6: Commit** `feat(web): PWA hardening (safe areas, manifest scope, standalone back)`.

### Task 0.8: Design foundation v2, rubric calibration, shell and primitive mockups

Agent: `ui-ux-designer` (+ Master runs the councils). No product code.

**Files:**

- Modify: `docs/design/foundation.md` → v2 (fix "Russian UI" → "uk default + en"; §12 relaxed per spec §4.5; token changes: spacing scale, radius, type scale, surface steps, chart palette; device classes; motion rules from Task 0.2)
- Create: `docs/design/rubric-calibration.md` (anchors at 6 / 8 / 9 / 9.5 / 10 per rubric criterion; measured thresholds for interaction criteria copied from spec §5)
- Create: `docs/design/screens/_foundation/shell-v2.md` + `assets/` (tab bar per role, "More", tablet rail, desktop sidebar, Cmd+K, `?` sheet, quick-add; states; 320/375/768/1024/1440)
- Create: `docs/design/screens/_foundation/primitives-v2.md` + `assets/` (ResponsiveSheet, ListRow, section header, FormField, skeletons, undo toast, upload indicator, chart theme, pull-to-refresh, page transition)
- Modify: `docs/design/screens/INDEX.md` → new "v2 roadmap" table (waves 0–8, every screen from spec §7, status `pending`); the old table moves under "v1 (archived)"

**Tab-bar proposal for the mockups** (4 destinations + "More"; More holds every other allowed route; derived from `lib/route-access.ts`):

| Role       | Tabs                                             |
| ---------- | ------------------------------------------------ |
| ADMIN      | Finance · Users · Stats · Home · More            |
| SENIOR     | Home · Finance · Team · Projects · More          |
| JUNIOR     | My project · Finance · Legend · Documents · More |
| HR         | Home · Interviews · Vacancies · Team · More      |
| ACCOUNTANT | Finance · Stats · Home · Projects · More         |
| DROP       | Home · Finance · Documents · Team · More         |

- [ ] **Step 1: Calibration council.** Council round on public screenshots of 2–3 benchmark apps (from the benchmarks file) with the draft anchors; anchors adjusted until benchmarks land at 9–10. Record scores in `rubric-calibration.md`.
- [ ] **Step 2: foundation v2 + tokens** written; copy-reviewer not needed (no product copy).
- [ ] **Step 3: Mockups** for shell and primitives (all classes, all six roles' tab bars, states).
- [ ] **Step 4: Mockup council** ≥ 9.0 from every member (quorum 3; Wave 0 waits when short). Fix → repeat.
- [ ] **Step 5: Owner approval** of shell + primitive mockups (AskUserQuestion with the PNGs). INDEX rows → `approved`.
- [ ] **Step 6: Commit** `docs(design): foundation v2, rubric calibration, shell + primitives mockups` (`ac_verified: n/a (docs)` per git-policy).

### Task 0.9: App shell v2 (tab bar, "More", tablet rail, desktop sidebar)

**Files:**

- Create: `apps/web/app/lib/nav-model.ts` (moves `NAV_ITEMS` out of `nav-sidebar.tsx`)
- Create: `apps/web/app/components/shell/MobileTabBar.tsx`, `MoreSheet.tsx`, `TabletRail.tsx`, `TopBar.tsx` (title, standalone back, notifications bell, impersonation banner slot)
- Modify: `apps/web/app/components/crm/nav-sidebar.tsx` (desktop only; consumes `nav-model`; mobile drawer code removed)
- Modify: `apps/web/app/routes/_authenticated/route.tsx` (`CrmLayout` renders `ByDevice` shell; content container owns `--safe-*` padding and tab-bar clearance)
- Modify: `apps/web/app/components/layout/notifications-bell.tsx`, `apps/web/app/components/layout/ImpersonationBanner.tsx` (fit TopBar; no viewport positioning)
- Test: `apps/web/app/lib/__tests__/nav-model.test.ts`, `apps/web/app/components/shell/__tests__/*.test.tsx`, `apps/e2e/tests/shell-v2.spec.ts`

**Interfaces:**

- Consumes: `useDeviceClass`/`ByDevice` (0.5), `ResponsiveSheet` (0.4), `useStandalone` (0.7), `navRolesFor`, `isRouteAllowed`, `Role` from `lib/route-access.ts`.
- Produces:

  ```ts
  export interface NavItem {
    id: string
    label: MessageDescriptor
    icon: LucideIcon
    to: string
    roles: readonly Role[]
    activeOptions?: { exact: boolean }
  }
  export const NAV_ITEMS: readonly NavItem[]
  export interface NavContext {
    isTeamless: boolean
  } // from useActiveTeam(); teamless SENIOR loses /projects and /interviews (today's nav-sidebar gate)
  export const TAB_BAR: Record<Role, readonly string[]> // NavItem ids per role in priority order (≥ 5), from Task 0.8 (approved); the first 4 visible become tabs
  export function navItemsFor(role: Role, ctx: NavContext): NavItem[] // NAV_ITEMS filtered by roles and ctx, original order
  export function tabItemsFor(role: Role, ctx: NavContext): NavItem[] // first 4 of TAB_BAR[role] present in navItemsFor
  export function moreItemsFor(role: Role, ctx: NavContext): NavItem[] // navItemsFor minus tabItemsFor
  // components/shell/TopBar.tsx and MobileTabBar.tsx expose mount slots for later tasks
  export interface TopBarSlots {
    palette?: React.ReactNode
    shortcuts?: React.ReactNode
    quickAdd?: React.ReactNode
    uploads?: React.ReactNode
  } // mobile: quickAdd in the tab bar's centre, uploads above the tab bar; tablet/desktop: all in TopBar
  // components/shell/use-edge-swipe-back.ts — standalone PWA only (Safari tabs have the browser's own back swipe)
  export function useEdgeSwipeBack(enabled: boolean): void // touch starting ≤ 20px from the left edge, moving right > 80px, mostly horizontal → router.history.back(); ignored when the touch starts inside an element with horizontal overflow or while a sheet is open
  ```

- [ ] **Step 1: Failing unit tests:**
  - `nav shows exactly the routes the role may open` — for each role in `['ADMIN','SENIOR','JUNIOR','HR','ACCOUNTANT','DROP']` and `isTeamless` in `[false, true]`: for every `NAV_ITEMS` entry, it is in `navItemsFor(role, ctx)` iff `isRouteAllowed(item.to, role)` and not (`role === 'SENIOR' && ctx.isTeamless && ['/projects','/interviews'].includes(item.to)`) — the oracle is `route-access`, not `nav-model`; and `tabItemsFor ∪ moreItemsFor` equals `navItemsFor` with no overlap.
  - `tab bar has 4 items per role, also for a teamless SENIOR` (`/projects` replaced by the next id in `TAB_BAR.SENIOR`).
  - `nav-sidebar and tab bar share one source` — `NavSidebar` renders exactly `navItemsFor(role, ctx).length` links.
  - `edge swipe goes back only from the edge` — touch at x=10 moving to x=120 → `back` called once; at x=60 → not called; starting inside an `overflow-x: auto` element with scrollable width → not called; while `useAnyDialogOpen()` → not called.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the approved mockups. Pending badge count moves with its item (tab or More). One shell mounted per class (no `hidden md:*` duplicates).
- [ ] **Step 4: E2E `shell-v2.spec.ts`** (Chromium 375 / 768 / 1440 and WebKit iPhone project from 0.14), dev-login per role: every `navItemsFor(role, ctx)` route opens via the tab bar or "More" (mobile) / rail (tablet) / sidebar (desktop), renders its root `data-testid`, and no element overflows the viewport; tab bar never covers the last row of a long list (scroll to bottom, last row's bounding box above the tab bar's top).
- [ ] **Step 5: Network check:** HAR of the shell load at 375 and 1440 (0.14 helper) — 0 duplicates; switching 375 ↔ 1440 issues no request.
- [ ] **Step 6: Run** all → PASS; `i18n:extract`; screenshots per class/role in the PR.
- [ ] **Step 7: Commit** `feat(web): app shell v2 (tab bar, More, rail, sidebar)`.

### Task 0.10: Cmd+K palette, shortcut registry, `?` sheet

**Files:**

- Create: `apps/web/app/lib/shortcuts.ts`, `apps/web/app/components/shell/CommandPalette.tsx` (cmdk), `apps/web/app/components/shell/ShortcutsSheet.tsx`
- Modify: `apps/web/app/routes/_authenticated/route.tsx` (pass `palette` and `shortcuts` into `TopBarSlots`; mounted once for every class)
- Test: `apps/web/app/lib/__tests__/shortcuts.test.ts`, `apps/web/app/components/shell/__tests__/CommandPalette.test.tsx`

**Interfaces:**

- Produces:

  ```ts
  export interface Shortcut {
    key: string
    mod?: boolean
    label: MessageDescriptor
    run: () => void
    roles?: readonly Role[]
  }
  export function isEditableTarget(t: EventTarget | null): boolean // input, textarea, select, [contenteditable], .cm-editor descendant
  export function useShortcut(s: Shortcut): void // registers while mounted
  export function useSingleKeyShortcutsEnabled(): [boolean, (v: boolean) => void] // localStorage 'crm.shortcuts.singleKey', default true
  export interface PaletteAction {
    id: string
    label: MessageDescriptor
    group: 'navigate' | 'page'
    run: () => void
  }
  export function usePageActions(actions: PaletteAction[]): void // screens register page-aware actions
  ```

- [ ] **Step 1: Failing tests:**
  - `ignores keys from editable targets` — dispatch `keydown 'c'` on an `<input>`, a `<textarea>`, a `[contenteditable]` and an element inside `.cm-editor` → `run` not called; on `document.body` → called once.
  - `mod shortcuts fire inside inputs` — `Cmd+K` in an input opens the palette.
  - `single-key switch off disables them` — set off → `'c'` on body does nothing; `Cmd+K` still works.
  - `palette lists exactly the nav routes for the role` — for each role and `isTeamless` value, the palette's navigate entries equal `navItemsFor(role, ctx)` (e.g. `JUNIOR` → no `/users`; teamless `SENIOR` → no `/projects`).
- [ ] **Step 2–4:** run FAIL → implement → PASS. `/` focuses the screen's search input when one registered; `?` opens `ShortcutsSheet` with the switch.
- [ ] **Step 5: Commit** `feat(web): command palette and WCAG-safe shortcuts`.

### Task 0.11: List, form and feedback primitives

Split into three PRs (a reviewer may reject one alone): 0.11a list, 0.11b form, 0.11c feedback.

**Files (0.11a list):** Create `components/ui/list-row.tsx`, `components/ui/section-header.tsx`, `components/ui/pull-to-refresh.tsx`, `components/ui/skeletons.tsx` (row / card / chart / form variants, replacing ad-hoc spinners in new code).
**Files (0.11b form):** Create `components/ui/form-field.tsx`, `hooks/use-keyboard-inset.ts` (VisualViewport), `components/ui/sticky-action-bar.tsx`.
**Files (0.11c feedback):** Create `lib/undo-toast.ts`, `lib/upload-queue.ts`, `components/shell/UploadIndicator.tsx`, `components/stats/chart-theme.ts`, `lib/view-transition.ts`; Modify `routes/_authenticated/route.tsx` (`uploads` slot ← `UploadIndicator`). Tests beside each under `__tests__/`.

**Interfaces:**

- Consumes: `useAnyDialogOpen` (existing), `holdReload` (0.6), `useDeviceClass` (0.5).
- Produces:

  ```ts
  // list
  export function ListRow(p: {
    title: React.ReactNode
    subtitle?: React.ReactNode
    meta?: React.ReactNode
    leading?: React.ReactNode
    onPress?: () => void
    href?: string
    swipeActions?: { label: MessageDescriptor; tone: 'default' | 'destructive'; run: () => void }[]
  }): React.JSX.Element // min-h 44px
  export function PullToRefresh(p: {
    onRefresh: () => Promise<unknown>
    children: React.ReactNode
  }): React.JSX.Element // inert when useAnyDialogOpen() or class !== 'mobile'
  export function TwoPane(p: {
    list: React.ReactNode
    detail: React.ReactNode | null
    emptyDetail: React.ReactNode
  }): React.JSX.Element
  // tablet/desktop: side by side; mobile: never used (list → detail is a route push)
  // form
  export function FormField(p: {
    label: React.ReactNode
    error?: string
    hint?: React.ReactNode
    required?: boolean
    children: React.ReactElement
  }): React.JSX.Element // wires id/aria-describedby/aria-invalid; input font >= 16px
  export function useKeyboardInset(): number // px the on-screen keyboard covers (0 on desktop)
  // feedback
  export function undoToast(p: { message: MessageDescriptor; undo: () => Promise<void> }): void // only for actions with a real reversal endpoint
  export interface UploadJob {
    id: string
    label: string
    progress: number
    state: 'queued' | 'uploading' | 'done' | 'error'
    retry: () => void
  }
  export function enqueueUpload<T>(
    label: string,
    run: (onProgress: (pct: number) => void) => Promise<T>,
  ): { id: string; result: Promise<T> } // result resolves with run's value (e.g. the uploaded document id), rejects on error, and re-settles after retry; holds reload while active; progress throttled to whole percents
  export function useUploads(): UploadJob[]
  export const CHART_THEME: {
    palette: readonly string[]
    grid: string
    axis: string
    tooltip: string
  } // from foundation v2 tokens
  export function navigateWithTransition(go: () => void): void // document.startViewTransition when supported and not reduced-motion
  ```

- [ ] **Step 1: Failing tests (0.11a):** `ListRow min height is 44px` (rendered class contains `min-h-11`); `TwoPane shows emptyDetail when detail is null`; `PullToRefresh calls onRefresh on a pull past threshold at scrollTop 0`; `PullToRefresh is inert while a dialog is open`; `PullToRefresh never calls location.reload` (spy).
- [ ] **Step 2: Failing tests (0.11b):** `FormField links label, hint and error` (`getByLabelText`, `aria-describedby` contains hint and error ids, `aria-invalid="true"` with error); `useKeyboardInset returns innerHeight - visualViewport.height`.
- [ ] **Step 3: Failing tests (0.11c):** `upload holds reload while active` (`isReloadHeld()` true until resolve, false after); `progress updates only on whole-percent change` (10 calls between 4.1 and 4.9 → 1 state update); `upload survives route change` (job still in `useUploads()` after unmounting the caller); `result resolves with the run value` (`run` resolves `{ id: 'doc-1' }` → `await result` equals it); `result rejects on failure and resolves after retry`; `navigateWithTransition falls back when startViewTransition is missing`.
- [ ] **Step 4:** run FAIL → implement per mockups → PASS; lint, typecheck.
- [ ] **Step 5: Commit** one per sub-PR (`feat(web): list primitives` / `form primitives` / `feedback primitives`).

### Task 0.12: Role-aware quick-add

**Files:** Create `apps/web/app/lib/quick-add.ts`, `apps/web/app/components/shell/QuickAddButton.tsx`; Modify `apps/web/app/routes/_authenticated/route.tsx` (`quickAdd` slot ← `QuickAddButton`, rendered only when `quickAddActionsFor` is non-empty); Test `apps/web/app/lib/__tests__/quick-add.test.ts`.

**Interfaces:**

- Produces:

  ```ts
  export interface QuickAddAction {
    id: string
    label: MessageDescriptor
    icon: LucideIcon
    roles: readonly Role[]
    open: () => void
  }
  export function quickAddActionsFor(role: Role): QuickAddAction[]
  ```

  Wave 0 registers only create actions that already exist (e.g. the current create-transaction dialog for the roles that may open it today, from the same RBAC helpers the screen uses). Wave 1 swaps the transaction action for the receipt-first sheet.

- [ ] **Step 1: Failing tests:** `no quick-add for a role without create actions` (button not rendered); `actions match what the screen allows` — for each role, every action's roles ⊆ the roles the screen's own create button checks (import the same helper; no second role list).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(web): role-aware quick-add`.

### Task 0.13: Legacy screens inside the new shell + iOS gesture proof

**Files:** Modify the files that position against the viewport — list produced in Step 1 and written into the task file; Test `apps/e2e/tests/legacy-in-shell.spec.ts`.

- [ ] **Step 1: List** — `grep -rlE "(^|[\" ])(fixed|sticky|h-screen|min-h-screen|h-dvh)([\" ]|$)|100vh" apps/web/app --include='*.tsx' --include='*.css'`; keep only real class/CSS uses (spec counts 14 files, e.g. `onboarding/route.tsx`, `JobQueueCard.tsx`, dialog/sheet primitives). Paste the list into the task file.
- [ ] **Step 2: Failing E2E** `legacy-in-shell.spec.ts` (Chromium 375 + 1440, WebKit iPhone): for each role and each route from `navItemsFor(role, ctx)`, open the route, open its first legacy dialog when the route has one (testid list in the task file), assert the dialog is fully inside the visual viewport and above the tab bar, and close it.
- [ ] **Step 3: Fix** each listed file (container-relative sizing, `dvh`, safe-area vars).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Simulator AC (manual, recorded):** on iOS Simulator Safari and the installed PWA — pull on a list at `scrollTop` 0 → in-app refresh, no page reload; drag a bottom sheet down at `scrollTop` 0 → sheet closes, no page reload; edge back-swipe on a screen with a horizontal scroller → back navigation, scroller unaffected. Recording paths in the PR.
- [ ] **Step 6: Commit** `fix(web): legacy screens fit the v2 shell`.

### Task 0.14: E2E infrastructure (WebKit iPhone, network log, INP)

Agent: `autotest` (or `devops` for CI wiring).

**Files:**

- Modify: `apps/e2e/playwright.config.ts` (add project `webkit-iphone`: `devices['iPhone 15']`; existing projects unchanged)
- Modify: `apps/e2e/package.json` (dev `web-vitals`), `version-pins.md`
- Create: `apps/e2e/fixtures/network-log.ts`, `apps/e2e/fixtures/inp.ts`
- Test: `apps/e2e/tests/infra-network-log.spec.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface NetworkSummary {
    requests: number
    duplicates: { key: string; count: number }[]
    waterfallDepth: number
    bytes: number
  }
  export function recordNetwork(page: Page): { stop(): Promise<NetworkSummary> } // key = METHOD + URL incl. sorted query; API calls only (/api/)
  export function expectNoDuplicates(s: NetworkSummary): void
  export function measureInp(
    page: Page,
    action: () => Promise<void>,
    opts?: { cpuThrottle?: number },
  ): Promise<{ inp: number; longestTask: number }> // Chromium CDP throttle, default 4
  ```
- [ ] **Step 1: Failing spec:** a fixture page that fires the same GET twice → `duplicates` length 1 with count 2; a page with one GET → 0 duplicates; `measureInp` on a button whose handler busy-waits 300 ms → `inp >= 300`.
- [ ] **Step 2–4:** FAIL → implement → PASS on `chromium` and `webkit-iphone` (INP: Chromium only; document it).
- [ ] **Step 5: Commit** `test(e2e): WebKit iPhone project, network log and INP helpers`.

### Task 0.15: Showcase route + Wave 0 implementation council

**Files:** Create `apps/web/app/routes/_authenticated/admin/showcase.tsx` (ADMIN-only via existing `/admin` entry in `ROUTE_ACCESS`; seed data only); `docs/design/screens/_foundation/council-w0.md`.

- [ ] **Step 1:** Showcase renders every Wave 0 primitive in every state, per class; `route-access` coverage test still green (the route sits under `/admin`).
- [ ] **Step 2:** Material per spec §5: screenshots 320/375/768/1024/1440 per role for the shell; Simulator recordings (0.6, 0.13); INP + long tasks for opening a sheet, switching tabs, opening Cmd+K; network summaries.
- [ ] **Step 3: Implementation council** ≥ 9.5 per class from every member (quorum 3, waits when short). Fix → repeat; scores in `council-w0.md` and INDEX.
- [ ] **Step 4:** manual-qa UT on the real stack (scratch DB) per role; owner "merge" for each open Wave 0 PR.
- [ ] **Step 5: Commit** `feat(web): design-system showcase` + docs.

---

## The per-screen loop (waves 1–8)

Every screen task in waves 1–8 is one pass of spec §6. Its steps are the same and are not repeated per task:

- [ ] **Capture** — iOS Simulator Safari 375, Android emulator, desktop 1440; blocks, actions, RBAC variants per role; modals/sheets list; dual-mount list for the screen's files (`grep -nE "hidden (sm|md|lg):(block|flex|grid)|(sm|md|lg):hidden"`; every pair that renders the same data twice is converted to `ByDevice` in this pass — the repo has more than the 2 the spec counted, e.g. `NotificationSettingsTab.tsx`, `projects/index.tsx`, `admin/login-as.tsx`, `vacancies/*`); baseline `recordNetwork` summary of the main flow (Task 0.14). Output: `docs/design/screens/<slug>.md` "Current" section + `assets/baseline/`.
- [ ] **Design** — `ui-ux-designer`, Tier 1: spec + mockups at 320/375/768/1024/1440, all states, per role variant, built from the approved primitives (0.4, 0.9–0.12) and benchmark patterns.
- [ ] **Mockup council** ≥ 9.0 → fixes → repeat. **Owner look:** Wave 1 screens need the owner's approval before code (Wave 0's is Task 0.8 Step 5); later waves continue unless the owner objects (spec §6 step 4).
- [ ] **Implement** — `coder`, worktree; `ByDevice` layouts over one query key (`select` per layout, same `limit`); optimistic writes via `onMutate` / `setQueryData` + exact invalidation of derived keys; every form host calls `useReloadGuard`; `@tanstack/react-virtual` only if a measured long list janks on the phone (its own pinned dependency change); tests first (unit for logic, E2E for flows); `i18n:extract`.
- [ ] **Verify** — Playwright 320/375/768/1024/1280/1440/1920 (Chromium + `webkit-iphone`); iOS Simulator Safari + installed PWA; Android emulator; `measureInp` of the main flow (INP < 200 ms, no long task > 200 ms); `recordNetwork` after vs baseline (0 duplicates, no unused fetch, waterfall justified).
- [ ] **Reviews** — design-fidelity (Mode B), code-reviewer, spec-reviewer, security-reviewer (finance / people-RBAC / contracts / auth), copy-reviewer.
- [ ] **Implementation council** ≥ 9.5 per class → fixes → repeat (max 10 rounds; at the cap → owner).
- [ ] **UT + merge** — manual-qa per role on the real stack (scratch DB); for screens in the owner's five flows (finance transaction with receipt, add employee, edit contract, edit profile, stats), the owner checks the flow on their own iPhone before "merge" (spec §8: the final check; Simulator timings are indicative only); owner "merge"; INDEX row → `implemented` with final scores.

Each screen's E2E spec must include, beyond its flows: `no duplicate requests on load and primary action` (`expectNoDuplicates`), `breakpoint change does not refetch` (375 → 1440 → 0 new API requests), and, for a form, `input survives an accidental sheet close` where the screen spec promises it.

## Wave 1 — Finance (sequential; patterns reused by every later wave)

### Task 1.1: `idempotencyKey` for expense, admin-income, admin-transfer, company deposit

Agents: `coder` + `security-reviewer` (mandatory). Critical-path zone: finance.

**Files:**

- Modify: `packages/shared/src/schemas/finance/income.ts` (`createExpenseSchema`, `createAdminIncomeSchema`, `createAdminTransferSchema`: add `idempotencyKey: z.string().uuid()`), `packages/shared/src/schemas/finance/company-account.ts` (`createCompanyDepositSchema`: same)
- Modify: the service methods behind the four routes: `TransactionsService.createExpense` and `TransactionsService.createAdminTransfer` (`apps/api/src/finance/transactions.service.ts`), `createAdminIncome` (`apps/api/src/finance/admin-income.service.ts`), and the deposit create in `company-account.service.ts`. Pattern: the replay guard in `apps/api/src/finance/senior-drop-income.service.ts` on `uq_transactions_senior_income_idempotency_key`.
- Reuse, do not recreate: the shared `transactions.idempotency_key` column and the existing `uq_transactions_admin_income_idempotency_key` (`type = 'ADMIN_INCOME'`, already in prod; see the DDL comment in `apps/api/src/database/schema/transactions.ts`). Admin income needs schema + service + web work only.
- Create: a manual-staged migration adding a partial unique index on `transactions (idempotency_key)` only for the row types without one: `EXPENSE` (`uq_transactions_expense_idempotency_key`), `COMPANY_DEPOSIT` (`uq_transactions_company_deposit_idempotency_key`; deposits are `transactions` rows), and the row type `createAdminTransfer` writes (read it first; if it writes two rows, the index covers the primary row only and the guard replays the pair). `CREATE UNIQUE INDEX IF NOT EXISTS`, prod DDL through the deploy flow.
- Modify: the web create hooks of the four forms (one `crypto.randomUUID()` per form open, reused on resubmit)
- Test: API integration specs (scratch DB), shared schema unit tests, web hook tests

- [ ] **Step 1: Failing tests:** `replays the same row for a repeated key` (two POSTs with one key → one row, both responses carry the same id) for each of the four routes; `rejects a create without a key` (400); `a different key creates a second row`; existing RBAC 403 specs stay green.
- [ ] **Step 2–4:** FAIL → implement (copy the senior-income guard) → PASS.
- [ ] **Step 5:** security-reviewer + code-reviewer; migration checked against the prod-DDL rules in `project-state.md`.
- [ ] **Step 6: Commit** `feat(finance): idempotency keys for expense, admin income, admin transfer, company deposit`.

### Task 1.2: Finance list (`finance/index.tsx` + its components)

Per-screen loop. Mobile: card stack grouped by day with sticky section headers, pull-to-refresh, filters in a bottom sheet held in the URL. Desktop: dense table, URL filters, chart-follows-filter where a chart exists today. The finance file among the legacy dual-mount files (spec §4.6) is converted here. Accountant views are role variants of this task.

### Task 1.3: Add / edit transaction with receipt (receipt-first sheet)

Per-screen loop. `ResponsiveSheet` (full height on mobile); receipt first (photo library and Files, no forced `capture`); upload through `enqueueUpload` (non-blocking, leave-able); one required field first, smart prefill. Optimistic insert + rollback with a visible error only for write kinds that carry an `idempotencyKey` (all of them after 1.1); submit disabled in flight; unknown outcome → "resubmit" with the same key; never auto-retry. Replaces the Wave 0 quick-add transaction action. security-reviewer mandatory.

Extra tests: `submit is disabled while the write is in flight`; `unknown outcome resubmits with the same idempotencyKey`; `optimistic row is replaced by the server row`; `optimistic row is rolled back with an error toast on failure`; `balance, partner-stats and dashboard keys are invalidated after a create` (spy on `invalidateQueries`, exactly those keys).

### Task 1.4: Public invoice (`routes/invoice.v.$transactionId.tsx`)

Per-screen loop on an unauthenticated surface (no shell). Mobile-first read view + share/print. security-reviewer for the public route.

## Wave 2 — People (sequential)

### Task 2.1: Users list + add employee (`users/index.tsx`)

Mobile list rows with role/status; add-employee as a full-height sheet (identity → role/team → compensation); desktop table + side-panel create. security-reviewer (RBAC).

### Task 2.2: Profiles (`profile/index.tsx`, `profile/$userId.tsx`)

Record-page pattern (summary header + sections); avatar and resume through `enqueueUpload`; per-role masking unchanged (explicit viewer → target matrix in the task file). security-reviewer.

### Task 2.3: Teams (`team/index.tsx`, `team/$teamId.tsx`)

Tablet two-pane list → detail; one council pass for both routes (shared layout), each scored ≥ 9.5.

## Wave 3 — Contracts & documents (design of wave 4 may overlap)

### Task 3.1: Admin layout (`admin/route.tsx` + tab navigation)

Mobile: a list or segmented scroller; desktop: tabs. AC: every Wave 7 admin child route, still legacy, stays reachable and working inside it (spec §10b; E2E over each `admin/*` route).

### Task 3.2: Contract templates and editor (`admin/contracts.index.tsx`, `admin/contracts.$role.tsx`)

Desktop-first CodeMirror editor; a read-optimised phone view with safe variable edits; shortcut guard re-verified inside the editor (Review Focus 4).

### Task 3.3: Documents (`documents.tsx`)

List rows by category; upload through `enqueueUpload`; preview in a sheet.

### Task 3.4: Onboarding contract flow (`onboarding/route.tsx`, `onboarding/index.tsx`)

Full-screen step flow on the phone (no shell chrome); ToS acceptance and signing; redesigns the viewport layout patched in 0.13.

### Task 3.5: ToS (`admin/tos.index.tsx`, `admin/tos.new.tsx`)

One council pass for both.

## Wave 4 — Stats & home

### Task 4.1: Stats (`stats.tsx`)

Partner balance + monthly net-profit chart on `CHART_THEME`; tap a bar to drill down; chart follows filters. Any aggregate endpoint follows spec §4.6 (masking before aggregation; security-reviewer).

### Task 4.2: Home + role dashboards (`_authenticated/index.tsx`, `routing.tsx`, `routing/components/*`)

One task; role variants as states; `routing.tsx` stays a redirect to `/`.

## Wave 5 — Projects & work

### Task 5.1: Projects list/detail (`projects.tsx`, `projects/index.tsx`, `projects/$projectId.tsx`)

### Task 5.2: My project + legend (`project.tsx`, `legend.tsx`) — JUNIOR surfaces; masking allowlist unchanged

### Task 5.3: Pending (`pending/index.tsx`)

## Wave 6 — Recruiting

### Task 6.1: Vacancies (`vacancies/index.tsx`, `vacancies/$vacancyId.tsx`)

### Task 6.2: Job queue (`job-queue/index.tsx`) — swipe to dismiss only where the endpoint exists

### Task 6.3: Interviews (`interviews/index.tsx`, `interviews/unmatched.tsx`) — status-segmented list on the phone; the board stays on desktop

## Wave 7 — Admin

### Task 7.1: Admin home, integrations, wallet (`admin/index.tsx`, `admin/integrations.index.tsx`, `admin/wallet.index.tsx`) — wallet: security-reviewer

### Task 7.2: Login-as (`admin/login-as.tsx`) — security-reviewer

### Task 7.3: Sources (`admin/sources.index.tsx`, `admin/sources.$sourceId.tsx`) — one wave-level council pass, each ≥ 9.5

## Wave 8 — Auth, system, final pass

### Task 8.1: Login (`routes/login.tsx`) — applies the standalone-SSO outcome of 0.7; security-reviewer

### Task 8.2: 404, error boundaries, empty states (`components/not-found.tsx`, `lib/telemetry/ErrorBoundary.tsx`, route error components)

### Task 8.3: Whole-app consistency council

Every screen at 375 and 1440 per role in one council round; regressions → fix tasks. Remove dead legacy code (old mobile-drawer paths, dialogs replaced by sheets). Final check of `version-pins.md` and `foundation.md`; every INDEX row `implemented`.
