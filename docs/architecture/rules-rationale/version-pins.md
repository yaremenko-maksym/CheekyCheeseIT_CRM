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

## `@rgrove/parse-xml` 5.0.0 exact — a pin that holds a security verdict

Adopted 2026-10-20 after a dependency and licence review (ADR
`docs/architecture/2026-10-20-xml-parser-dependency-review.md`, PR #1064) and wired into job-sourcing
by PR #1072. It is the only pin in the file whose **exactness is a security control rather than a
build constraint**.

The verdict rests on a single behavioural fact: the library **consumes a `<!DOCTYPE>` declaration and
discards it without reading its contents**, so no entity is ever declared. XXE and entity expansion
are therefore unreachable **by absence of capability**, not by a safe default that a release could
flip — measured, not inferred: XXE-to-file, XXE-to-http, billion laughs and quadratic blowup all
threw `Named entity isn't defined`, and the out-of-band canary recorded zero hits. A minor release
that started parsing the internal subset would remove the whole basis of the adoption **without
failing any build**. That is why the rule says to read the changelog before a bump and not to bump on
green CI: green CI does not re-derive the verdict.

### The two options are gates, and they live in the wrapper

The parser's option surface has eight entries, of which two touch entity handling. Neither makes the
parser read a DTD, but each opens a different hole, and both are set in the wrapper rather than in a
config file — so a reader looking for them in config finds nothing and concludes wrongly that they
are at their defaults.

| Option                    | Pinned value          | What the other value costs                                                                            | Kind of gate                |
| ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| `ignoreUndefinedEntities` | `false` (its default) | a feed with an undefined entity parses "successfully" into a literal `&x;` — drift, silently          | correctness / drift         |
| `resolveUndefinedEntity`  | never supplied        | a caller-written resolver is the only route by which entity content — or caller-authored XXE — enters | security, caller-introduced |

### Why this pin is coupled to Node 22

The package is **ESM-only and declares no `require` condition in its `exports`**, which looks exactly
like the dual-package trap that blocks Lingui 6 (above) — and is not one. It resolves inside
`apps/api` through **`require(esm)`, available from Node 22.12**; the package's own `engines` declares
`node >=22.12.0`, and our pin (`node >=22.19 <23`) satisfies it with margin. No `moduleResolution`
change and no build change were needed.

The consequence is a real coupling that the Node entry's original rationale (Lingui 6 needing
≥ 22.19) does not mention, which is why the rule file now gives Node two reasons instead of one: a
drop below **22.12** breaks this dependency **at runtime**, not at install, and a drop below a minor is
not covered by the existing "do not change the Node major" prohibition.

### The claim is falsifiable in code

`parse-xml.adapter.locality.spec.ts` asserts the exact version string, the version actually installed,
and the ISC licence. A silent bump or a licence change fails a test rather than passing unnoticed —
deliberately the opposite of the defect the parser review itself produced twice, where a claim's truth
and its falsehood looked identical.

**Shelf life: recheck 2027-04-20**, or immediately on any advisory, on any change to the Node pin, or
on a release that touches DOCTYPE handling. The ADR's own recheck procedure is the authority on how.

## Sources

- CLAUDE.md "Key version constraints" + "Key technical notes".
- `.claude/agents/project-state.md` — authoritative snapshot of versions.
- ADR `docs/architecture/2026-05-31-ecc-migration-design.md` §4.5 (Vite 6 pin context).
- `scripts/devops/pnpm-audit-runbook.md` — how an audit-driven override must not cross a hard pin.
- ADR `docs/architecture/2026-10-20-xml-parser-dependency-review.md` — the `@rgrove/parse-xml`
  adoption verdict, the measurements behind it and the recheck procedure.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

## Why these pins (brief context)

- **Vite 6 vs 7:** `@tanstack/router-plugin` is compatible only with Vite 6 as of `^1.168`.
- **TanStack version match:** pnpm strict peer-deps validation breaks on mismatch — `pnpm install` fails.
- **Fastify override:** `@fastify/helmet` requires Fastify 5, while NestJS 11 tries to resolve `^4`.
  Without the override — a runtime crash on API startup.
- **Node 22 LTS:** a prerequisite for Lingui 6 (ESM-only, requires ≥ 22.19 — on 20 `pnpm install`
  failed with `EBADENGINE`).
- **`@rgrove/parse-xml` 5.0.0 EXACT:** unusually for a pin, the claim behind it is **falsifiable in
  code** — `parse-xml.adapter.locality.spec.ts` asserts the exact version string, the installed
  version and the ISC licence, so a silent bump or a licence change fails a test instead of going
  unnoticed.

---

Exact rather than a caret range because the adoption verdict rests on **one fact a minor release
could remove**: the library never parses the internal subset of a `<!DOCTYPE>`, so XXE and entity
expansion are unreachable by absence of capability rather than by a default. Read the changelog
before any bump; do not bump on green CI.

## Moved from the rule 2026-10-31

Narrative blocks removed verbatim from the always-on rule to cut per-request bytes. Nothing normative was removed.

It also makes **Node ≥ 22.12** a hard floor
_inside_ the Node 22 line: a drop below that minor is not covered by the "major version" rule above
and fails at runtime.
