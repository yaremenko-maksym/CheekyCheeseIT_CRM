# CRM Redesign — Screen Registry

> Registry of Claude Design mockups for the phased CRM redesign. Each row is a surface (route/modal):
> its mockup in Claude Design (system `CheekyCheeseIT CRM`), its artifact in the repo, and its lifecycle status.
> Program: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.
> Per-screen template: `docs/design/screens/_TEMPLATE.md`.

## Status lifecycle

| Status        | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `pending`     | Planned for capture, no mockup yet                                     |
| `captured`    | Mockup created in Claude Design + artifact in the repo                 |
| `approved`    | **Owner visually approved the mockup** — precondition for the dev loop |
| `implemented` | Code matches the mockup (after the feature merges)                     |
| `stale`       | Code has moved ahead of the mockup — refresh capture needed            |

**Rule (design-gate):** for a registered screen the PM/orchestrator does NOT dispatch a coder until
the status is `approved` (see `.claude/rules/common/design-gate.md`). The mockup leads, the code follows.

## Phase roadmap

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

## Phase 0 — Foundation

Direction source: `docs/design/foundation.md`. Artifacts: `docs/design/screens/_foundation/assets/`.

| Surface                               | Artifact                                                             | Claude Design URL                                                                   | Status        | Last synced |
| ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------- | ----------- |
| App-shell (nav-sidebar+header+chrome) | `docs/design/screens/_foundation/app-shell.md`                       | [CRM global shell](https://claude.ai/design/p/cb5277cf-5b56-44ff-9a6a-4404d8c92cea) | `implemented` | `04ffd90b`  |
| Dense data-table (north-star)         | covered by the showcase in `app-shell.md` (the "Пользователи" table) | —                                                                                   | `n/a`         | —           |
| Key dialog/form (north-star, opt.)    | deferred — generated on demand during domain phases                  | —                                                                                   | `n/a`         | —           |

> **Variant A "restrained" + flat navigation approved by the owner 2026-06-23.** The dashboard north-star
> is de facto closed by the merged ADMIN dashboard (#280); the dense table is shown inside the app-shell showcase;
> we do not duplicate separate data-table/dialog north-star mockups (domains are generated on demand later).

## Done outside the registry (pre-registry)

| Surface         | PR                                                                      | Status        | Notes                                                           |
| --------------- | ----------------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| ADMIN dashboard | [#280](https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/280) | `implemented` | First designer-first run (Claude Design → coder → Mode B → UT). |

## Phase 1 — Interviews (kanban)

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
