# CRM Redesign — Screen Registry

> Реестр макетов Claude Design для пофазного редизайна CRM. Каждая строка — поверхность (роут/модалка):
> её макет в Claude Design (система `CheekyCheeseIT CRM`), артефакт в репо и статус в жизненном цикле.
> Программа: `docs/superpowers/specs/2026-06-22-crm-redesign-program.md`.
> Per-screen шаблон: `docs/design/screens/_TEMPLATE.md`.

## Жизненный цикл статуса

| Статус        | Значение                                                     |
| ------------- | ------------------------------------------------------------ |
| `pending`     | Запланировано к захвату, макета ещё нет                      |
| `captured`    | Макет создан в Claude Design + артефакт в репо               |
| `approved`    | **Владелец визуально апрувнул макет** — предусловие dev-loop |
| `implemented` | Код соответствует макету (после merge фичи)                  |
| `stale`       | Код ушёл вперёд макета — нужен рефреш-захват                 |

**Правило (design-gate):** для зарегистрированного экрана PM/оркестратор НЕ диспатчит кодера, пока
статус не `approved` (см. `.claude/rules/common/design-gate.md`). Макет ведёт, код следует.

## Дорожная карта фаз

| Phase | Scope                                                          | Статус фазы                         |
| ----- | -------------------------------------------------------------- | ----------------------------------- |
| **0** | Foundation / direction + app-shell (nav-sidebar/header/chrome) | **direction approved** (2026-06-23) |
| **1** | Interviews (канбан + 5 модалок)                                | pending (референс снят)             |
| **2** | Team & Users                                                   | pending                             |
| **3** | Projects                                                       | pending                             |
| **4** | Finance / Invoices / Accountant                                | pending                             |
| **5** | Documents / Contracts / Onboarding                             | pending                             |
| **6** | Profiles                                                       | pending                             |
| **7** | Dashboards (admin / HR / role)                                 | ADMIN сделан вне реестра (#280)     |
| **8** | Auth/login, empty/404/error, финальный polish                  | pending                             |

Phase 0 гейтит фазы 1–8 (направление утверждается владельцем на north-star экранах).

## Phase 0 — Foundation

Источник направления: `docs/design/foundation.md`. Артефакты: `docs/design/screens/_foundation/assets/`.

| Surface                               | Артефакт                                                  | Claude Design URL                                                                        | Status     | Last synced |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------- | ----------- |
| App-shell (nav-sidebar+header+chrome) | `docs/design/screens/_foundation/app-shell.md`            | [CRM глобальный каркас](https://claude.ai/design/p/cb5277cf-5b56-44ff-9a6a-4404d8c92cea) | `approved` | `86d72c32`  |
| Dense data-table (north-star)         | покрыт showcase в `app-shell.md` (таблица «Пользователи») | —                                                                                        | `n/a`      | —           |
| Key dialog/form (north-star, опц.)    | отложен — генерится on-demand при доменных фазах          | —                                                                                        | `n/a`      | —           |

> **Вариант А «сдержанный» + плоская навигация одобрены владельцем 2026-06-23.** Dashboard north-star
> де-факто закрыт смерженным ADMIN-дашбордом (#280); dense-таблица показана внутри showcase app-shell;
> отдельные data-table/dialog north-star макеты не дублируем (домены генерятся on-demand далее).

## Сделано вне реестра (pre-registry)

| Surface       | PR                                                                      | Status        | Заметки                                                             |
| ------------- | ----------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------- |
| ADMIN-дашборд | [#280](https://github.com/yaremenko-maksym/CheekyCheeseIT_CRM/pull/280) | `implemented` | Первый designer-first прогон (Claude Design → coder → Mode B → UT). |

## Phase 1 — Interviews (канбан)

Источник: `apps/web/app/routes/_authenticated/interviews/`. Функц-референс (faithful-скриншоты реального
экрана) уже захвачен в `assets/` — используется как чек-лист функционала для брифа, НЕ как выход.

| Surface (route/modal)             | Файл                               | Артефакт                                                      | Status    |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------- | --------- |
| Канбан-доска (`/interviews`)      | `index.tsx` + `KanbanColumn.tsx`   | `docs/design/screens/interviews/kanban.md`                    | `pending` |
| Архив                             | `ArchiveSection.tsx`               | `docs/design/screens/interviews/archive.md`                   | `pending` |
| Деталь собеседования (sheet)      | `InterviewDetailSheet.tsx`         | `docs/design/screens/interviews/interview-detail.md`          | `pending` |
| Создать собеседование (модалка)   | `CreateInterviewDialog.tsx`        | `docs/design/screens/interviews/create-interview.md`          | `pending` |
| Создать проект из hired (модалка) | `CreateProjectFromHiredDialog.tsx` | `docs/design/screens/interviews/create-project-from-hired.md` | `pending` |

<!-- Домены 2–8 добавляются секциями по мере подхода к фазе (домен за доменом). -->
