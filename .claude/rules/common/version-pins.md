# Rule: Version pins (canonical)

**Status:** Always-on
**Applies to:** All agents and contributors
**Source:** Project hard requirement (CLAUDE.md "Ключевые ограничения версий") — battle-tested through multiple build incidents.

---

## The rule

Single source of truth для версий. **Не дублировать в agent docs / README / package.json comments** — ссылаться сюда.

### Runtime

- **Node:** 20 LTS (строго). Не 21, не 22.
- **pnpm:** 7.32.4 (строго).

### Frontend

- **Vite:** `^6.4` (НЕ 7.x).
- **TanStack Router** `1.170.15` + **`@tanstack/router-plugin`** `1.168.18` — **peer-matched pair, EXACT-pinned**. Plugin `peerDependencies` = react-router `^1.170.15`, т.е. номер плагина намеренно ОТСТАЁТ от lib — они НЕ совпадают по номеру. НЕ бампить раздельно и НЕ переводить в caret-диапазон; при апгрейде выводи пару заново из `npm view @tanstack/router-plugin peerDependencies`. Рассинхрон = peer-конфликт в pnpm + ломаные route-типы (route `from`-пути).
- **Tailwind:** v4 (CSS-first config, `@import "tailwindcss"` + `@theme inline`).
- **tw-animate-css:** v2 (нужен для shadcn анимаций после миграции на Tailwind v4).

### Backend

- **NestJS:** 11 (current LTS).
- **Fastify:** `^5.8.5` — форсирован через `pnpm.overrides` (конфликт с `@fastify/helmet`).
- **Drizzle ORM:** `^0.45.0` + Drizzle Kit совместимая.
- **Zod:** v4 (НЕ v3 — синтаксис `.transform` / `.parse` различается).

### Infra

- **PostgreSQL:** 16-alpine (Docker Compose).
- **Redis:** 7-alpine (Docker Compose).

## Forbidden / risky overrides

- **НЕ добавлять** `pnpm.overrides` для `@tanstack/router-*` пакетов — сломает сборку (предыдущий incident).
- **НЕ обновлять Vite до 7.x** без отдельного Architect dispatch (breaking change для `@tanstack/router-plugin`).
- **НЕ менять Node major version** без явного DevOps task + CI matrix update.
- **НЕ заменять Fastify на Express** в API — `@nestjs/platform-fastify` baseline + helmet/CORS интеграция.

## Why these pins (краткий контекст)

- Vite 6 vs 7: TanStack `@tanstack/router-plugin` совместим только с Vite 6 на момент `^1.168`. Phase 6+ может пересмотреть.
- TanStack version match: pnpm strict peer-deps валидация ломается при mismatch — `pnpm install` падает.
- Fastify override: `@fastify/helmet` требует Fastify 5, а NestJS 11 пытается резолвнуть `^4`. Без override — runtime crash на запуске API.
- Node 20 LTS: GHA runners + Docker images + nest-cli все стабильны на 20. На 22 типы Drizzle могут drift.

## Связанные правила

- `.claude/rules/common/git-policy.md` — изменение pins требует отдельного commit с `vision:` для CI matrix.
- `.claude/rules/common/zone-of-write.md` — `package.json` overrides — DevOps зона (не Coder).

## Источники

- CLAUDE.md "Ключевые ограничения версий" + "Ключевые технические заметки".
- `.claude/agents/project-state.md` — авторитетный snapshot версий.
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §4.5 (Vite 6 pin context).
