# Rule: Version pins (canonical)

**Status:** Always-on
**Applies to:** All agents and contributors

> Rationale: `docs/architecture/rules-rationale/version-pins.md`

---

## The rule

Single source of truth for versions. **Do not duplicate in agent docs / README / package.json
comments** — link here.

### Runtime

- **Node:** 22 LTS (strict; raised 2026-09-19 for Lingui 6 — ESM-only, requires ≥ 22.19). Not 24.
  **Two things rest on this pin, not one:** `require(esm)` is available only from **22.12**, and
  `@rgrove/parse-xml` (below) resolves in `apps/api` through nothing else. A drop to Node 20 breaks
  both, and the second one breaks at runtime rather than at install.
- **pnpm:** 7.32.4 (strict).

### Frontend

- **Vite:** `^6.4` (NOT 7.x).
- **TanStack Router** `1.170.15` + **`@tanstack/router-plugin`** `1.168.18` — **peer-matched pair,
  EXACT-pinned**. The plugin `peerDependencies` = react-router `^1.170.15`, i.e. the plugin number
  deliberately LAGS the lib — they do NOT match by number. Do NOT bump them separately and do NOT
  convert to a caret range; on upgrade, derive the pair anew from
  `npm view @tanstack/router-plugin peerDependencies`. A mismatch = a peer conflict in pnpm + broken
  route types (route `from` paths).
- **Tailwind:** v4 (CSS-first config, `@import "tailwindcss"` + `@theme inline`).
- **tw-animate-css:** v2 (needed for shadcn animations after the migration to Tailwind v4).

### Backend

- **NestJS:** 11 (current LTS).
- **Fastify:** `^5.8.5` — forced via `pnpm.overrides` (conflict with `@fastify/helmet`).
- **Drizzle ORM:** `^0.45.0` + a compatible Drizzle Kit.
- **Zod:** v4 (NOT v3 — `.transform` / `.parse` syntax differs).
- **standardwebhooks:** `1.1.1` EXACT — signature semantics are protocol-critical and this version is
  verified against the meeting-recorder extension. Do not use a range.
- **`@rgrove/parse-xml`:** `5.0.0` EXACT (ISC) — the XML parser behind job-sourcing feed ingestion.
  Exact because the adoption verdict rests on one fact a minor release could remove: the library never parses a `<!DOCTYPE>` internal subset, so XXE/entity expansion are unreachable. Read the changelog before any bump; do not bump on green CI. **Two options are pinned by the wrapper, not by config**
  (so do not go looking for them in a config file): `ignoreUndefinedEntities` stays **`false`** — a
  drift gate, since `true` makes a feed with an undefined entity parse "successfully" into a literal
  `&x;` — and `resolveUndefinedEntity` is **never supplied**, that being the only route by which
  entity content can enter. **Recheck 2027-04-20**, or immediately on any advisory. ADR:
  `docs/architecture/2026-10-20-xml-parser-dependency-review.md`.

### Infra

- **PostgreSQL:** 16-alpine (Docker Compose).
- **Redis:** 7-alpine (Docker Compose).

### i18n

- **`@lingui/*`:** `5.9.5` EXACT, **one version** across `@lingui/core`, `@lingui/react`,
  `@lingui/cli`, `@lingui/vite-plugin`, `@lingui/babel-plugin-lingui-macro` (peer-matched-pair
  discipline, like TanStack Router above). **NOT `6.7.0`** — why: Lingui 6 is ESM-only +
  `moduleResolution: Node` in `apps/api` / `packages/shared` does not resolve its types (TS2307); and
  moving api/shared to `node16` is blocked by the dual-package types of `drizzle-orm@0.45.2`.
  **Condition for upgrading to 6:** Drizzle with a single `.d.ts` (no dual CJS/ESM types) OR
  `apps/api` + `packages/shared` moved to `module: node16`.

## Forbidden / risky overrides

- **Do NOT add** `pnpm.overrides` for `@tanstack/router-*` packages — it breaks the build (previous incident).
- **Do NOT update Vite to 7.x** without a separate Architect dispatch (breaking change for `@tanstack/router-plugin`).
- **Do NOT change the Node major version** without an explicit DevOps task + CI matrix update.
- **Do NOT replace Fastify with Express** in the API — `@nestjs/platform-fastify` baseline + helmet/CORS integration.
- **Do NOT widen `@rgrove/parse-xml` to a range, and do NOT bump it on green CI** — the pin carries a
  security verdict that green CI does not re-derive. It also makes **Node ≥ 22.12** a hard floor
  _inside_ the Node 22 line: a drop below that minor is not covered by the "major version" rule above
  and fails at runtime.

## Why these pins

One line each (Vite 6 vs 7, TanStack match, Fastify override, Node 22, parse-xml falsifiable pin): rationale file.

## Related rules

- `.claude/rules/common/git-policy.md` — changing pins requires a separate commit with `vision:` for the CI matrix.
- `.claude/rules/common/zone-of-write.md` — `package.json` overrides — DevOps zone (not Coder).
