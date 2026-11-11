# CRM Redesign — Screen Registry

> Registry of design mockups for the CRM redesign. Each row is a surface (route / modal / shell part):
> its artifact in the repo and its lifecycle status.
> **Current program: v2** — `docs/superpowers/specs/2026-11-11-crm-redesign-v2-design.md` (mobile-first,
> three device classes, council gate). Visual and interaction language: `docs/design/foundation.md` v2.
> Scoring: `docs/design/rubric-calibration.md`. Per-screen template: `docs/design/screens/_TEMPLATE.md`.
> The v1 program (2026-06-22) is kept below under **v1 (archived)**.

## Status lifecycle

| Status        | Meaning                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pending`     | Planned for capture, no mockup yet                                                                               |
| `captured`    | Mockup created (Claude Design, or Playwright HTML prototype when degraded) + artifact in the repo                |
| `approved`    | **Owner visually approved the mockup** (v2: after the mockup-gate council ≥ 9.0) — precondition for the dev loop |
| `implemented` | Code matches the mockup (after the feature merges; v2: implementation gate ≥ 9.5)                                |
| `stale`       | Code has moved ahead of the mockup — refresh capture needed                                                      |

**Rule (design-gate):** for a registered screen the orchestrator does NOT dispatch a coder until the
status is `approved` (see `.claude/rules/common/design-gate.md`). The mockup leads, the code follows.

---

## v2 roadmap

37 route screens + the app shell + shared dialogs (spec §7). Wave 0 gates all others. Waves 1–2 are
sequential; from wave 3 on, design of wave N+1 may overlap implementation of wave N. Council scores and
the per-round table go into each screen's row (spec §5) — the "Council" column.

| Wave  | Scope                                                                                | Wave status                                 |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| **0** | Foundation: PWA hardening, app shell, primitives, `foundation.md` v2, showcase route | in progress — shell + primitives `captured` |
| **1** | Finance                                                                              | pending                                     |
| **2** | People                                                                               | pending                                     |
| **3** | Contracts & documents                                                                | pending                                     |
| **4** | Stats & home                                                                         | pending                                     |
| **5** | Projects & work                                                                      | pending                                     |
| **6** | Recruiting                                                                           | pending                                     |
| **7** | Admin                                                                                | pending                                     |
| **8** | Auth, system, final pass                                                             | pending                                     |

Paths: relative to `apps/web/app/routes/_authenticated/` unless they start with `__root`, `login` or
`invoice` (directly in `apps/web/app/routes/`). A layout route (`*/route.tsx`) belongs to the wave of its
first child screen. The modals / sheets of each screen are added in step 1 of the per-screen loop.

### Wave 0 — Foundation

| Surface                                                            | File                             | Artifact                                           | Status     | Council |
| ------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------- | ---------- | ------- |
| Foundation v2 (tokens, rules)                                      | —                                | `docs/design/foundation.md`                        | `captured` | —       |
| Rubric calibration                                                 | —                                | `docs/design/rubric-calibration.md` (draft)        | `captured` | —       |
| App shell v2 (tab bar, More, quick-add, rail, sidebar, Cmd+K, `?`) | `_authenticated/route.tsx`       | `docs/design/screens/_foundation/shell-v2.md`      | `captured` | —       |
| Nav sidebar (desktop + collapsed)                                  | `components/crm/nav-sidebar.tsx` | `shell-v2.md` (`desktop-sidebar-*`)                | `captured` | —       |
| Impersonation banner                                               | shell                            | `shell-v2.md` (`state-impersonation-375`)          | `captured` | —       |
| Notifications bell (panel)                                         | shell                            | — (header icon only so far)                        | `pending`  | —       |
| Root / PWA hardening                                               | `__root.tsx`                     | — (no visual surface beyond the shell states)      | `pending`  | —       |
| Primitives v2                                                      | `components/ui/*`                | `docs/design/screens/_foundation/primitives-v2.md` | `captured` | —       |
| Showcase route                                                     | new (Wave 0 implementation)      | renders `primitives-v2.md`                         | `pending`  | —       |

### Wave 1 — Finance

| Surface                | File                                   | Artifact | Status    | Council |
| ---------------------- | -------------------------------------- | -------- | --------- | ------- |
| Finance (transactions) | `finance/index.tsx` (+ its components) | —        | `pending` | —       |
| Public invoice         | `invoice.v.$transactionId.tsx`         | —        | `pending` | —       |

### Wave 2 — People

| Surface       | File                  | Artifact | Status    | Council |
| ------------- | --------------------- | -------- | --------- | ------- |
| Users         | `users/index.tsx`     | —        | `pending` | —       |
| My profile    | `profile/index.tsx`   | —        | `pending` | —       |
| Other profile | `profile/$userId.tsx` | —        | `pending` | —       |
| Teams         | `team/index.tsx`      | —        | `pending` | —       |
| Team detail   | `team/$teamId.tsx`    | —        | `pending` | —       |

### Wave 3 — Contracts & documents

| Surface                       | File                        | Artifact | Status    | Council |
| ----------------------------- | --------------------------- | -------- | --------- | ------- |
| Admin layout + tab navigation | `admin/route.tsx`           | —        | `pending` | —       |
| Contract templates            | `admin/contracts.index.tsx` | —        | `pending` | —       |
| Contract editor (per role)    | `admin/contracts.$role.tsx` | —        | `pending` | —       |
| Documents                     | `documents.tsx`             | —        | `pending` | —       |
| Onboarding layout             | `onboarding/route.tsx`      | —        | `pending` | —       |
| Onboarding contract flow      | `onboarding/index.tsx`      | —        | `pending` | —       |
| ToS list                      | `admin/tos.index.tsx`       | —        | `pending` | —       |
| New ToS                       | `admin/tos.new.tsx`         | —        | `pending` | —       |

### Wave 4 — Stats & home

| Surface                             | File                       | Artifact | Status    | Council |
| ----------------------------------- | -------------------------- | -------- | --------- | ------- |
| Stats (partner balance, net profit) | `stats.tsx`                | —        | `pending` | —       |
| Home (role dashboards)              | `_authenticated/index.tsx` | —        | `pending` | —       |
| Routing (redirect to `/`)           | `routing.tsx`              | —        | `pending` | —       |

### Wave 5 — Projects & work

| Surface         | File                      | Artifact | Status    | Council |
| --------------- | ------------------------- | -------- | --------- | ------- |
| Projects layout | `projects.tsx`            | —        | `pending` | —       |
| Projects list   | `projects/index.tsx`      | —        | `pending` | —       |
| Project detail  | `projects/$projectId.tsx` | —        | `pending` | —       |
| My project      | `project.tsx`             | —        | `pending` | —       |
| Legend          | `legend.tsx`              | —        | `pending` | —       |
| Pending         | `pending/index.tsx`       | —        | `pending` | —       |

### Wave 6 — Recruiting

| Surface              | File                       | Artifact | Status    | Council |
| -------------------- | -------------------------- | -------- | --------- | ------- |
| Vacancies            | `vacancies/index.tsx`      | —        | `pending` | —       |
| Vacancy detail       | `vacancies/$vacancyId.tsx` | —        | `pending` | —       |
| External job queue   | `job-queue/index.tsx`      | —        | `pending` | —       |
| Interviews (kanban)  | `interviews/index.tsx`     | —        | `pending` | —       |
| Unmatched interviews | `interviews/unmatched.tsx` | —        | `pending` | —       |

### Wave 7 — Admin

| Surface        | File                           | Artifact | Status    | Council |
| -------------- | ------------------------------ | -------- | --------- | ------- |
| Admin home     | `admin/index.tsx`              | —        | `pending` | —       |
| Integrations   | `admin/integrations.index.tsx` | —        | `pending` | —       |
| Login as       | `admin/login-as.tsx`           | —        | `pending` | —       |
| Sources        | `admin/sources.index.tsx`      | —        | `pending` | —       |
| Source detail  | `admin/sources.$sourceId.tsx`  | —        | `pending` | —       |
| Company wallet | `admin/wallet.index.tsx`       | —        | `pending` | —       |

### Wave 8 — Auth, system, final pass

| Surface                         | File                                    | Artifact | Status    | Council |
| ------------------------------- | --------------------------------------- | -------- | --------- | ------- |
| Login                           | `login.tsx`                             | —        | `pending` | —       |
| 404                             | `apps/web/app/components/not-found.tsx` | —        | `pending` | —       |
| Error boundaries / empty states | route error boundaries                  | —        | `pending` | —       |
| Whole-app consistency council   | —                                       | —        | `pending` | —       |

---

## v1 (archived)

> The v1 program (`docs/superpowers/specs/2026-06-22-crm-redesign-program.md`, "restyle only"). Kept for
> history; its statuses are not updated any more. The v1 foundation it refers to was replaced by
> `foundation.md` v2; its app shell by `_foundation/shell-v2.md`.

### Phase roadmap

| Phase | Scope                                                          | Phase status                               |
| ----- | -------------------------------------------------------------- | ------------------------------------------ |
| **0** | Foundation / direction + app-shell (nav-sidebar/header/chrome) | **implemented** (#287, 2026-06-23)         |
| **1** | Interviews (kanban + 5 modals)                                 | in progress — kanban approved (2026-06-23) |
| **2** | Team & Users                                                   | pending                                    |
| **3** | Projects                                                       | pending                                    |
| **4** | Finance / Invoices / Accountant                                | pending                                    |
| **5** | Documents / Contracts / Onboarding                             | pending                                    |
| **6** | Profiles                                                       | pending                                    |
| **7** | Dashboards (admin / HR / role)                                 | ADMIN done outside the registry (#280)     |
| **8** | Auth/login, empty/404/error, final polish                      | pending                                    |

Phase 0 gates phases 1–8 (the direction is approved by the owner on the north-star screens).

### Phase 0 — Foundation

Direction source: `docs/design/foundation.md`. Artifacts: `docs/design/screens/_foundation/assets/`.

| Surface                               | Artifact                                                             | Claude Design URL                                                                   | Status        | Last synced |
| ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------- | ----------- |
| App-shell (nav-sidebar+header+chrome) | `docs/design/screens/_foundation/app-shell.md`                       | [CRM global shell](https://claude.ai/design/p/cb5277cf-5b56-44ff-9a6a-4404d8c92cea) | `implemented` | `04ffd90b`  |
| Dense data-table (north-star)         | covered by the showcase in `app-shell.md` (the "Пользователи" table) | —                                                                                   | `n/a`         | —           |
| Key dialog/form (north-star, opt.)    | deferred — generated on demand during domain phases                  | —                                                                                   | `n/a`         | —           |

> **Variant A "restrained" + flat navigation approved by the owner 2026-06-23.** The dashboard north-star
> is de facto closed by the merged ADMIN dashboard (#280); the dense table is shown inside the app-shell showcase;
> we do not duplicate separate data-table/dialog north-star mockups (domains are generated on demand later).

### Done outside the registry (pre-registry)

| Surface         | PR                                                                      | Status        | Notes                                                           |
| --------------- | ----------------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| ADMIN dashboard | [#280](https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/280) | `implemented` | First designer-first run (Claude Design → coder → Mode B → UT). |

### Phase 1 — Interviews (kanban)

Source: `apps/web/app/routes/_authenticated/interviews/`. The functional reference (faithful screenshots of the real
screen) is already captured in `assets/` — used as a functionality checklist for the brief, NOT as the output.

| Surface (route/modal)             | File                               | Artifact                                                      | Status     |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------- | ---------- |
| Kanban board (`/interviews`)      | `index.tsx` + `KanbanColumn.tsx`   | `docs/design/screens/interviews/kanban.md`                    | `approved` |
| Archive                           | `ArchiveSection.tsx`               | `docs/design/screens/interviews/archive.md`                   | `pending`  |
| Interview detail (sheet)          | `InterviewDetailSheet.tsx`         | `docs/design/screens/interviews/interview-detail.md`          | `pending`  |
| Create interview (modal)          | `CreateInterviewDialog.tsx`        | `docs/design/screens/interviews/create-interview.md`          | `pending`  |
| Create project from hired (modal) | `CreateProjectFromHiredDialog.tsx` | `docs/design/screens/interviews/create-project-from-hired.md` | `pending`  |

<!-- Domains 2–8 are added as sections as each phase approaches (domain by domain). -->
