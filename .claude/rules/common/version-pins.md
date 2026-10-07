# Rule: Version pins (canonical)

**Status:** Always-on
**Applies to:** All agents and contributors
**Source:** Project hard requirement (CLAUDE.md "Key version constraints") — battle-tested through multiple build incidents.

---

## The rule

Single source of truth for versions. **Do not duplicate in agent docs / README / package.json comments** — link here.

### Runtime

- **Node:** 22 LTS (strict; raised 2026-09-19 for Lingui 6 — ESM-only, requires ≥ 22.19). Not 24.
- **pnpm:** 7.32.4 (strict).

### Frontend

- **Vite:** `^6.4` (NOT 7.x).
- **TanStack Router** `1.170.15` + **`@tanstack/router-plugin`** `1.168.18` — **peer-matched pair, EXACT-pinned**. The plugin `peerDependencies` = react-router `^1.170.15`, i.e. the plugin number deliberately LAGS the lib — they do NOT match by number. Do NOT bump them separately and do NOT convert to a caret range; on upgrade, derive the pair anew from `npm view @tanstack/router-plugin peerDependencies`. A mismatch = a peer conflict in pnpm + broken route types (route `from` paths).
- **Tailwind:** v4 (CSS-first config, `@import "tailwindcss"` + `@theme inline`).
- **tw-animate-css:** v2 (needed for shadcn animations after the migration to Tailwind v4).

### Backend

- **NestJS:** 11 (current LTS).
- **Fastify:** `^5.8.5` — forced via `pnpm.overrides` (conflict with `@fastify/helmet`).
- **Drizzle ORM:** `^0.45.0` + a compatible Drizzle Kit.
- **Zod:** v4 (NOT v3 — `.transform` / `.parse` syntax differs).
- **standardwebhooks:** `1.1.1` EXACT — signature semantics are protocol-critical and this version is verified against the meeting-recorder extension. Do not use a range.

### Infra

- **PostgreSQL:** 16-alpine (Docker Compose).
- **Redis:** 7-alpine (Docker Compose).

### i18n

- **`@lingui/*`:** `5.9.5` EXACT, **one version** across `@lingui/core`, `@lingui/react`, `@lingui/cli`, `@lingui/vite-plugin`, `@lingui/babel-plugin-lingui-macro` (peer-matched-pair discipline, like TanStack Router above). NOT `6.7.0` — why: Lingui 6 is ESM-only + `moduleResolution: Node` in `apps/api`/`packages/shared` does not resolve its types (TS2307); moving api/shared to `node16` is blocked by the dual-package types of `drizzle-orm@0.45.2`. Condition for upgrading to 6: Drizzle with a single `.d.ts` (no dual CJS/ESM types) OR `apps/api`+`packages/shared` moved to `module: node16`.

## Forbidden / risky overrides

- **Do NOT add** `pnpm.overrides` for `@tanstack/router-*` packages — it breaks the build (previous incident).
- **Do NOT update Vite to 7.x** without a separate Architect dispatch (breaking change for `@tanstack/router-plugin`).
- **Do NOT change the Node major version** without an explicit DevOps task + CI matrix update.
- **Do NOT replace Fastify with Express** in the API — `@nestjs/platform-fastify` baseline + helmet/CORS integration.

## Why these pins (brief context)

- Vite 6 vs 7: TanStack `@tanstack/router-plugin` is compatible only with Vite 6 as of `^1.168`. Phase 6+ may reconsider.
- TanStack version match: pnpm strict peer-deps validation breaks on mismatch — `pnpm install` fails.
- Fastify override: `@fastify/helmet` requires Fastify 5, while NestJS 11 tries to resolve `^4`. Without the override — a runtime crash on API startup.
- Node 22 LTS: raised 2026-09-19 as a prerequisite for Lingui 6 (ESM-only package, requires ≥ 22.19 — on 20 `pnpm install` failed with `EBADENGINE`). GHA runners + Docker images (`node:22-alpine`) + nest-cli verified on 22 as part of this upgrade.

## Related rules

- `.claude/rules/common/git-policy.md` — changing pins requires a separate commit with `vision:` for the CI matrix.
- `.claude/rules/common/zone-of-write.md` — `package.json` overrides — DevOps zone (not Coder).

## Sources

- CLAUDE.md "Key version constraints" + "Key technical notes".
- `.claude/agents/project-state.md` — authoritative snapshot of versions.
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §4.5 (Vite 6 pin context).
