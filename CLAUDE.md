# CheekyCheeseIT CRM — Memory Bank (обзор)

> **Компактный обзор для USER-сессий.** Детали здесь НЕ дублируются — см. карту указателей.
> Новые факты о проекте (фазы, миграции, RBAC, бизнес-правила, gotchas) пишутся в
> `.claude/agents/project-state.md` — это single source of truth. Сюда — только если
> изменилась карта указателей или верхнеуровневый статус.
> Ревизия: 2026-06-11 (context diet: 537 → ~120 строк; ECC-пак прорежен; добавлен light-track).

## Проект

CRM для рекрутинговых воркспейсов (outsource/outstaffing компания: AI, EdTech, E-Commerce).
**Цель:** максимальная типобезопасность, скорость, профессиональный UX.
**Язык:** UI и общение с пользователем — русский; код, коммиты, PR — английский.

- **Лендинг** — отдельное приложение `apps/landing` (целевой домен `cheekycheese.tech`), без ссылок на CRM
- **CRM** — `apps/web` (целевой `app.cheekycheese.tech`): защищённое рабочее пространство в корне `/` (роут-префикс `/crm` убран при domain-split 2026-06-21), Google SSO only (ручной OAuth, JWT HttpOnly cookie)
- 5 ролей RBAC: `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT` (+ DROP payment-routing поверх)

## Карта указателей (где живёт правда)

| Что нужно                                                                               | Где                                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Фазы и статус, RBAC-матрица, бизнес-правила, миграции, схемы, auth, tech gotchas        | `.claude/agents/project-state.md`                                                  |
| Cross-agent правила — точка входа (TOC)                                                 | `.claude/RULES.md`                                                                 |
| Конкретные правила: MCP-first, git-policy, zone-of-write, версии, язык, skills-триггеры | `.claude/rules/common/*.md` (auto-loaded)                                          |
| Лёгкий vs полный трек разработки                                                        | `.claude/rules/common/light-track.md`                                              |
| Claude Design UI-гейт + workflow                                                        | `.claude/rules/common/design-gate.md` + `.claude/skills/claude-design-workflow/`   |
| Воркфлоу/fan-out vs агент vs light-track (степень параллелизма) + codebase-audit        | `.claude/rules/common/orchestration-routing.md` + `.claude/skills/codebase-audit/` |
| Системные промпты агентов (старт — README)                                              | `.claude/agents/<agent>.md`                                                        |
| Cross-agent state machine                                                               | `.claude/agents/contracts.md`                                                      |
| Активные task-файлы                                                                     | `.claude/tasks/`                                                                   |
| ADR, deliverables, RCA                                                                  | `docs/architecture/`                                                               |
| Бизнес-доки (BA)                                                                        | `docs/business/`                                                                   |
| Юр. драфты контрактов                                                                   | `docs/legal/`                                                                      |
| Уроки агентов                                                                           | `.claude/agents/memory/<agent>/lessons.md`                                         |

## Стек (сводка)

Turborepo + pnpm · **web:** React + Vite SPA (НЕ TanStack Start) + TanStack Router/Query/Form +
Tailwind v4 + shadcn/ui + Framer Motion · **api:** NestJS 11 + Fastify + Drizzle ORM (PostgreSQL) +
Redis · **валидация:** Zod v4, все API через `.parse()`, типы из `@crm/shared` ·
**тесты:** Vitest (unit) + Playwright (E2E).

Точные версии, EXACT-пины (TanStack пара!) и forbidden overrides —
`.claude/rules/common/version-pins.md`. Не бампить ничего мимо этого файла.

## Структура монорепо

```
apps/web        # Vite SPA + TanStack Router (:3000), вход app/client.tsx
apps/api        # NestJS 11 + Fastify (:3001)
apps/e2e        # Playwright E2E
packages/shared # Zod-схемы + типы (Single Source of Truth)
```

## Команды

```bash
pnpm dev | build | typecheck | test            # все пакеты (turbo)
pnpm --filter @crm/web|@crm/api|@crm/e2e <cmd> # отдельный пакет
pnpm --filter @crm/api db:push | db:seed       # Drizzle: schema sync (push) / сид
docker-compose up -d                           # Postgres + Redis локально
```

## Multi-agent команда

Все агенты запускаются **локально** через `Agent` tool (PM — `isolation=worktree`).
GHA-воркфлоу агентов в `.github/workflows/archive/` — устарели, не использовать.

| Агент                                          | Роль                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Master (user-сессия)                           | Инфраструктура агентов, мета-работа, лёгкий трек                |
| BA                                             | Бизнес-анализ → `.claude/briefs/pm-brief.md`                    |
| PM                                             | Декомпозиция → параллельный диспетч → мониторинг → User Testing |
| Coder / AutoTest / DevOps                      | Реализация / E2E-спеки / CI-CD — каждый в своей zone-of-write   |
| code-reviewer + security-reviewer              | Review; security-reviewer ОБЯЗАТЕЛЕН для auth/finance/RBAC      |
| manual-qa / ui-ux-designer / legal / architect | Visual QA на реальном стеке / дизайн / юр. / ADR                |

**Полный pipeline:** BA → pm-brief → PM → task-файлы (`.claude/tasks/`) → параллельные агенты →
PR → review (все находки H/M/L резолвятся) → User Testing → явное «мерджим» от USER →
label `merge-approved` → CI squash-merge.
**Лёгкий трек** (мелкие правки без PM-церемонии): `.claude/rules/common/light-track.md`.

## Статус (снэпшот 2026-06-11)

- **PHASE 1–7 ✅**: Layout · Команда · Проекты · Канбан собеседований · Финансы
  (рефактор → `payout_requests`/`pending_obligations`) · Документы (S3/MinIO) ·
  Профили + Легенда per-project (#150, #164)
- **Контракты + Онбординг ✅** · **DROP-роль ✅** (вне исходного 9-фазного плана)
- **Дальше:** PHASE 8 — **«Счёт компании»** (USDT ERC-20; смарт-контракты **отменены** владельцем 2026-06-17 → верификация tx по ссылке + дивиденды ADMIN + общий счёт; план — `project-state.md` §1.1) → PHASE 9 — дашборд
- Детальный чеклист фаз — `project-state.md` §1

## Сессионный минимум

Правила ниже auto-loaded из `.claude/rules/common/` — здесь только напоминание, что они существуют:
MCP-first · git-policy (no `--no-verify`, явные `git add`, `ac_verified:`) · русский язык ·
zone-of-write · skills-триггеры · version-pins · light-track · design-gate (любое UI → дизайнер-в-контуре) · model-routing (какой тир модели какому агенту/задаче) · orchestration-routing (агент vs воркфлоу vs light-track — степень параллелизма).

Сверх правил: E2E локально перед push кода (docs-only diff освобождён — см. light-track);
merge PR — **только** по явному подтверждению USER в чате.
