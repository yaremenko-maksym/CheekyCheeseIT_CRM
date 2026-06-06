# Documents PR-1 — Audit removal + ToS marker + view toggle — Implementation Plan

> **For agentic workers:** TDD task-by-task (test → red → implement → green → commit). Checkbox steps. Spec: `docs/superpowers/specs/2026-06-05-documents-redesign-design.md` §3.

**Goal:** Remove the user-facing audit journal (top-level page + profile tab + backend module), keep the server-side `AuditInterceptor`, add an ADMIN-visible ToS-acceptance marker on the profile, and add a list/grid view toggle (default list) on `/crm/documents`.

**Architecture:** Mostly deletion + unwiring (frontend routes/components/nav + backend audit module) with routeTree regen; plus two additive bits — `tosAcceptedAt`/`tosVersion` on the user-profile endpoint + marker UI, and a `?view=` toggle with a new `DocumentRow`.

**Tech Stack:** NestJS + Drizzle (api), Zod v4 (shared), React + TanStack Router/Query (web), Vitest, Playwright. Russian UI.

**Branch:** `feat/documents-pr1` (off main a173151). Chunked `wip:` pushes; final `ac_verified:`.

---

## Task 1 — Backend: remove audit-journal module (keep AuditInterceptor)

**Files:** Remove `apps/api/src/audit/{audit.controller,audit.module,audit.service,audit.service.spec}.ts`; modify `apps/api/src/app.module.ts` (unwire `AuditModule`); `packages/shared` audit-log schema (remove if only used by the journal). Test: new/extended integration spec.

- [ ] **Step 1 — failing test:** in an integration spec (real routes, mirror `contract-controllers.integration.spec.ts`, DB-skip-guard), assert `GET /api/me/audit-trail` and `GET /api/audit/all` → **404** (routes gone). (Red now = they still 200.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** delete the `audit/` module files; remove `AuditModule` from `app.module.ts` imports; `grep`-verify nothing else imports `AuditService`/`AuditModule`; remove audit-log shared schema export iff unused elsewhere (`grep` first). **Do NOT touch** `common/interceptors/audit.interceptor.ts` or its uses in `transactions.service.ts` / `users.*`.
- [ ] **Step 4 — run, expect PASS** (404s) + `pnpm --filter @crm/api test` green + app boots (`pnpm --filter @crm/api typecheck`).
- [ ] **Step 5 — commit** `feat(api): remove audit-journal module (keep AuditInterceptor)`.

## Task 2 — Frontend: remove audit UI (page + profile tab + nav)

**Files:** Remove `apps/web/app/routes/crm/audit-log/{index,route}.tsx`, `apps/web/app/routes/crm/profile/audit.tsx`, `apps/web/app/components/audit-log/AuditLogTab.tsx`, `apps/web/app/components/user-profile/tabs/AuditLogTab.tsx`, `apps/web/app/__tests__/audit-accordion.test.tsx`. Modify `components/crm/nav-sidebar.tsx` (remove «Аудит-журнал» item ~ln 93-98), `routes/crm/profile/$userId.tsx` + `routes/crm/profile/index.tsx` (remove `audit` from tab enum/list), `components/user-profile/UserProfileShell.tsx` (remove AuditLogTab wiring), regen `routeTree.gen.ts`.

- [ ] **Step 1 — failing test (web unit):** in a profile/nav test, assert the «Аудит-журнал» nav item is absent and the profile tab list has no `audit` entry. (Red now.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** delete the listed files; remove the nav entry; remove `audit` from the profile tab enum + any `TAB_*` visibility map; remove AuditLogTab import/branch from `UserProfileShell`; run `pnpm --filter @crm/web dev`-driven routeTree regen (or the generator) so `routeTree.gen.ts` drops the audit routes. `grep` for dangling `AuditLogTab` / `audit-log` / `/crm/audit-log` imports → none.
- [ ] **Step 4 — run, expect PASS** + `pnpm --filter @crm/web typecheck` + `mcp__eslint__lint-files` on changed.
- [ ] **Step 5 — commit** `feat(web): remove audit-journal page + profile tab + nav entry`.

## Task 3 — ToS marker on profile (backend data + UI)

**Files:** Modify the user-profile endpoint (`apps/api/src/users/users.controller.ts`/`users.service.ts` — the `GET /api/users/:id` profile path) to include `tosAcceptedAt: string|null` + `tosVersion: number|null` (latest `tos_acceptances` row for the user); `packages/shared` user-profile DTO/schema; frontend overview tab on `routes/crm/profile/$userId.tsx` (or its overview component). Tests: api unit + web unit.

- [ ] **Step 1 — failing test (api):** profile endpoint returns `tosAcceptedAt`/`tosVersion` = latest acceptance, or `null` when none. (Use the TosService/`tos_acceptances` query.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement (api):** add the fields to the profile response + shared schema (ADMIN-visible; self may see own). Reuse `TosService`/a `tos_acceptances` latest-by-user query.
- [ ] **Step 4 — run, expect PASS** (api).
- [ ] **Step 5 — failing test (web):** overview renders «Пользовательское соглашение принято: <дата>, v<версия>» when present, «не принято» when null; ADMIN-visible.
- [ ] **Step 6 — implement (web)** the marker in the overview header/section + run web test + eslint.
- [ ] **Step 7 — commit** `feat(api,web): ToS acceptance marker on profile`.

## Task 4 — Documents list/grid view toggle (default list)

**Files:** Modify `apps/web/app/routes/crm/documents/index.tsx` (or `documents.tsx`) — add `?view=list|grid` search param (validateSearch), default `list`, localStorage fallback; new `apps/web/app/components/documents/DocumentRow.tsx`; keep `DocumentCard` for grid. Test: web unit.

- [ ] **Step 1 — failing test (web):** documents page defaults to **list** view (renders `DocumentRow`s); toggling to grid renders `DocumentCard`s; `?view=grid` honored; choice persists (localStorage). Existing filters/search still present.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** `validateSearch` adds `view: z.enum(['list','grid']).catch('list').optional()`; a toggle control (segmented) sets `?view=` + writes localStorage; render `DocumentRow` (list) vs `DocumentCard` grid. `DocumentRow` = compact (icon + name + type + date + actions; badge slot reserved for PR-2). Reuse existing data query/filters.
- [ ] **Step 4 — run, expect PASS** + eslint.
- [ ] **Step 5 — commit** `feat(web): documents list/grid view toggle (default list)`.

## Task 5 — E2E + full verification

**Files:** Modify/add `apps/e2e/tests/crm/documents.spec.ts` (or existing) + a profile/nav spec; remove any E2E referencing the audit page.

- [ ] **Step 1 — E2E:** «Аудит-журнал» nav item absent; `/crm/audit-log` → 404/redirect; profile has no audit tab; ToS marker visible on a profile (ADMIN); documents page defaults to list, toggle to grid works.
- [ ] **Step 2 — RUN E2E locally 2× (start web :3000 first; kill stragglers):** relevant specs green, zero-flaky.
- [ ] **Step 3 — full gate:** `pnpm typecheck` (4/4); `pnpm --filter @crm/api --filter @crm/web --filter @crm/shared test` green; `mcp__eslint__lint-files` on all changed; `pnpm prettier --write` changed → `--check` clean.
- [ ] **Step 4 — commit** `test(e2e): documents view toggle + audit-gone + ToS marker` with `ac_verified:`.
- [ ] **Step 5 — push** `feat/documents-pr1`, open PR (base main), label `ai-review-ready`.

> After push: PM dispatches code-reviewer + manual-qa (live). Security-reviewer not needed (no new auth/finance surface; audit removal is deletion, ToS marker is read-only). #15/#21 are a separate follow-up (not in PR-1).

---

## Acceptance Criteria

1. Audit-journal fully removed: backend module + endpoints (404), top-level `/crm/audit-log` page, profile audit tab, nav entry, audit test — all gone; `AuditInterceptor` (logging) untouched.
2. App boots, typecheck 4/4, no dangling audit imports, routeTree regenerated.
3. Profile shows ToS acceptance marker (date + version, or «не принято»), ADMIN-visible.
4. `/crm/documents` defaults to **list**, toggle to grid works, `?view=` persists; existing filters/search intact.
5. Unit (api/web/shared) + E2E green (run locally 2×); manual QA passed live.

## Self-review notes

- Spec §3 coverage: audit removal→Tasks 1-2; ToS marker→Task 3; view toggle→Task 4; testing→Task 5. PR-2 (badges/unified) + PR-3 (receipts) + #15/#21 explicitly out of PR-1.
- Consistency: file paths from the main-reconciliation; `AuditInterceptor` KEPT (only the journal module removed); `DocumentRow` badge slot reserved for PR-2.
- Risk: routeTree regen must drop audit routes (verify no stale entries); grep for dangling imports before commit.
