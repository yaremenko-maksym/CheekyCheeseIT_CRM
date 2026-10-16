# Rationale: version-pins

Rationale layer for `.claude/rules/common/version-pins.md`. Not auto-loaded — read on demand, and
**before proposing any upgrade**.

**Source:** Project hard requirement (CLAUDE.md "Key version constraints") — battle-tested through
multiple build incidents.

---

## The two pins people actually break

Both are **peer-matched pairs**, and both fail in a way that does not say "version".

### TanStack Router 1.170.15 + router-plugin 1.168.18

The trap is that the two numbers **do not match, deliberately**. The plugin's `peerDependencies`
declares react-router `^1.170.15` — so the plugin's own version lags the library's. Someone tidying
the `package.json` "aligns" them, and gets:

- a peer conflict in pnpm (`pnpm install` fails outright under strict peer-deps validation), or
- silently broken route types — specifically route `from` paths.

The correct upgrade procedure is to derive the pair anew rather than guess:

```bash
npm view @tanstack/router-plugin peerDependencies
```

A separate, independent trap: adding `pnpm.overrides` for `@tanstack/router-*` **breaks the build**.
This happened once already and is why the prohibition is listed as absolute rather than as advice.
Vite is the third leg of the same knot: `@tanstack/router-plugin` is compatible only with Vite 6 as of
`^1.168`, which is why Vite 7 needs a dedicated Architect dispatch and not a routine bump.

### Lingui 5.9.5 exact — and why 6 is blocked

Lingui 6 is **ESM-only**. With `moduleResolution: Node` in `apps/api` and `packages/shared`, its types
do not resolve — `TS2307`. The obvious fix (move those packages to `module: node16`) is itself blocked
by the **dual-package types of `drizzle-orm@0.45.2`**.

So the upgrade is gated on one of two preconditions, either of which unblocks it:

1. Drizzle ships a single `.d.ts` (no dual CJS/ESM types), **or**
2. `apps/api` + `packages/shared` move to `module: node16`.

All five `@lingui/*` packages must stay on **one** version (`core`, `react`, `cli`, `vite-plugin`,
`babel-plugin-lingui-macro`) — the same peer-matched-pair discipline as TanStack.

Node 22 LTS was raised on 2026-09-19 as a prerequisite for the eventual Lingui 6 move: on Node 20
`pnpm install` failed with `EBADENGINE` because the package requires ≥ 22.19. GHA runners, Docker
images (`node:22-alpine`) and nest-cli were all verified on 22 as part of that upgrade. Node 24 was
not adopted.

## Fastify `^5.8.5` via overrides

`@fastify/helmet` requires Fastify 5, while NestJS 11 tries to resolve `^4`. Without the
`pnpm.overrides` entry the API **crashes at runtime on startup** — not at install, which is what makes
it worth recording: the failure appears far from its cause.

This is also why replacing Fastify with Express is forbidden rather than discouraged: the
`@nestjs/platform-fastify` baseline carries the helmet/CORS integration.

## standardwebhooks 1.1.1 EXACT

Signature semantics are protocol-critical, and this version is verified against the meeting-recorder
extension. A range here would let a patch release change signature behaviour, and the symptom would be
rejected webhooks, not a build error.

## Sources

- CLAUDE.md "Key version constraints" + "Key technical notes".
- `.claude/agents/project-state.md` — authoritative snapshot of versions.
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §4.5 (Vite 6 pin context).
- `scripts/devops/pnpm-audit-runbook.md` — how an audit-driven override must not cross a hard pin.
