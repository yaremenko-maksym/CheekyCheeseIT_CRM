# pnpm audit gate — runbook

`task-prod-runtime-vulns` (2026-08-16) built the gate; this runbook is a separate,
later task (2026-09-02) written because the gate had already gone red often
enough for the pattern to be worth writing down once instead of re-deriving it
per PR. Read this when `pnpm audit gate (moderate+, reasoned exceptions)` — a
step inside the REQUIRED `Typecheck · Lint · Unit Tests` check — is red on your
PR, or before you touch `scripts/devops/check-pnpm-audit.mjs` or
`scripts/devops/pnpm-audit-exceptions.json`.

## Why this keeps happening

The gate does not read your diff. It reads the live vulnerability database
through `pnpm audit --json`, on every push, on every branch, including `main`.
A brand-new GHSA advisory against a package already in the lockfile turns the
gate red on code nobody touched — three times since it shipped, roughly once a
week:

- **2026-08-16/17** — the gate's own first landing: 21 pre-existing findings on
  `main`, fixed across three rounds in the same PR series (round 1 the initial
  close-out, round 2 seven more genuinely fixed, round 3 a scoped `esbuild`
  override after a naive blanket one broke `pnpm build`).
- **2026-09-01** — two new HIGH advisories against `browserslist`, published
  between one green run and the next, closed by a straight version bump
  (`browserslist: '>=4.28.7 <5.0.0'` in `pnpm.overrides` — see that commit's
  message for the reachability argument, it is the clean case: transitive,
  dev-only, patched version exists, done).
- **2026-09-02** — four more newly-published advisories against packages that
  already had an override FLOOR from earlier rounds (`qs`, `fastify`,
  `fast-uri`) — the floor had not moved, the bar above it had. Three closed by
  tightening the existing floor; the fourth (`@xmldom/xmldom`) did NOT get the
  same treatment — see Step 3, it is the reason this runbook has a Step 3.

Every one of these colored the same required check on every open PR and on
`main` itself, for a diff that, in all four cases, had nothing to do with the
advisory.

## Step 0 — is this even about your diff?

Check whether the SAME check is red on `main`, or on any other open PR whose
diff obviously has nothing to do with dependencies (a docs-only PR is the
cleanest signal):

```bash
gh run list --branch main --workflow=ci.yml --limit 5
gh pr checks <some-other-open-PR-number>
```

Red in both places → this is not your diff, it is a newly-published advisory
against something already in the lockfile (exactly the three incidents above).
Proceed through the steps below knowing you are fixing something shared, not
debugging your own change. Green everywhere else and red only on your branch →
your diff actually changed a dependency; the same steps still apply, just aimed
at what you changed.

## Step 1 — facts about the package, by command, not by guessing

The gate's own failure message already names the package and the GHSA id. Get
the rest from `pnpm`, not from reasoning about what you'd expect:

```bash
pnpm why <package> -r          # every path to it, and whether each is
                                # "devDependencies:" or plain "dependencies:"
pnpm list <package> -r --depth Infinity --filter @crm/api   # same question,
                                                              # scoped to one
                                                              # workspace package
```

`pnpm why`'s own output legend is the answer to "does this reach production":
a package that only ever appears under a `devDependencies:` heading, through a
chain that bottoms out in a build/test tool (`vitest`, `@stryker-mutator/*`,
`@babel/*` used only by the mutation gate, …), never reaches the shipped SPA or
the API runtime. A package under plain `dependencies:` — or reachable from one
— does. This is exactly the distinction the `undici` and `@xmldom/xmldom`
groups in `pnpm-audit-exceptions.json` each open with, and it is the one fact
every later step depends on: it decides both urgency (prod-reachable is not a
"later" problem) and whether an exception is even defensible (Step 4).

## Step 2 — update first, exception second

If a patched version exists and satisfies every dependent's declared peer/
semver range, bump it — via a direct `package.json` dependency if the package
is direct, or a `pnpm.overrides` entry (root `package.json`) if it is
transitive, the way `browserslist`, `qs`, `fastify`, and `fast-uri` all were.
This closed 3 of the last 4 incidents outright; the gate itself lists this as
fix option 1 for exactly this reason. An exception is fix option 2, not a
default — it defers the problem rather than closing it, and it needs the
written reason Step 4 asks for.

## Step 3 — prove the update didn't kill a test silently

**This is the step that is easy to skip and the one incident that made this
runbook worth writing.** `pnpm audit` and `pnpm test` both went green on
bumping `@xmldom/xmldom` to its patched `0.8.15` — and that green was a lie.
The same release that fixes the advisory (`GHSA-6gmq-8vp8-gcm6`, a
serialization-side defect) ALSO fixes an unrelated performance bug
(`GHSA-8344-3jmq-59r6`: attribute de-duplication during parsing, O(M²) →
O(M)) — and two existing regression tests,
`apps/api/src/resumes/resume-text-extraction.service.spec.ts` and
`apps/api/src/resumes/resume-render-responsiveness.spec.ts`, exist specifically
BECAUSE that quadratic behavior was there, asserting on the multi-second parse
time it produces under a many-attributes DOCX fixture. Bump the package and
both tests still pass — they just stop testing anything, because the slow path
they were built to exercise no longer exists.

**A green test suite after a dependency bump is not proof of nothing broken —
it is proof of nothing OBSERVED broken.** Before trusting it: read the
patched version's changelog/diff against the version you started from, not
just the one advisory you set out to fix, and ask whether anything else in that
release could be load-bearing for an existing test the way the quadratic fix
was here. If it is, either update the test's mechanism in the same change, or
— as `pnpm-audit-exceptions.json`'s `@xmldom/xmldom` group did — defer the
bump with a written reason and leave the advisory excepted rather than ship a
green that measures nothing. Updating `*.spec.ts` is AutoTest's zone, not
DevOps's or Coder's own — see Step 7.

## Step 4 — exception only with a written reason

`scripts/devops/check-pnpm-audit.mjs` enforces this mechanically (a reason
under `MIN_REASON_LENGTH` meaningful characters is treated as no exception at
all — the advisory still gates), so a vague reason does not even buy you
anything. Write what Step 1 found: the reachability tier (prod-runtime /
build-only / test-only), the exact command that proved it (`pnpm why <pkg>
-r` output, quoted or summarized), and — if the vulnerable code path is
technically reachable but never exercised (like the `@xmldom/xmldom` case:
production-reachable, but only through a parse-only call shape that never
triggers the serialization-side defect) — which specific call shape in the
vulnerable package this application never makes. "Pending a future fix" is not
a reason by itself; "pending a future fix, deferred because X" is. Match the
existing groups in `scripts/devops/pnpm-audit-exceptions.json` for shape and
level of detail — they set the bar a reviewer will hold a new one to.

## Step 5 — check version-pins.md before you touch the override

`.claude/rules/common/version-pins.md` has hard, named pins: the TanStack
router/plugin pair (must stay peer-matched, never bumped separately), Vite
(pinned to `^6.4`, not `7.x`), Fastify's own override (already exists, for a
different reason — do not touch it without reading why first), Node major
version. A patched version that would cross one of these is not a Step 2 fix
— it is a separate, larger decision, and needs `.claude/rules/common/
version-pins.md` updated deliberately, not as a side effect of closing an
advisory.

## Step 6 — prove it

```bash
node scripts/devops/check-pnpm-audit.mjs      # before: note the GATED count
#  ... make the fix ...
node scripts/devops/check-pnpm-audit.mjs      # after: GATED N -> 0
pnpm --filter @crm/web build                  # confirm bundle output is
                                               # unchanged if the touched
                                               # package could plausibly reach
                                               # the shipped SPA (PWA precache
                                               # entry count + size is the
                                               # existing evidence shape —
                                               # see pnpm-audit-exceptions.json)
```

`GATED (unaccepted, >= moderate): 0` in the second run, quoted in the PR body
next to the same number from the first run, is the whole proof — not "should
be fixed now."

## Step 7 — zone: DevOps closes it, Coder hands off the facts

`package.json` (`pnpm.overrides`) and `scripts/devops/pnpm-audit-exceptions.json`
are **DevOps's zone, not Coder's** (`.claude/rules/common/version-pins.md`:
"`package.json` overrides — DevOps зона (не Coder)"; `.claude/rules/common/
zone-of-write.md` gives Coder no path under `scripts/devops/**` at all). If
you are a Coder who hit this gate: Steps 0–1 (is this yours, and the
reachability facts) are your own diagnostic work and belong in your PR
description regardless of who applies the fix — do not edit the override or
the exceptions file yourself. Hand the facts to DevOps (or, in a single-PR
workflow, do the DevOps-zone edit as its own commit, clearly separated from
your feature diff) rather than losing a turn wondering whether you are allowed
to touch it: you are not, and now you know why without re-deriving it.

## Related

- `scripts/devops/check-pnpm-audit.mjs` — the gate itself; its own module
  header has the full mechanics (retry/registry-failure handling, the
  per-GHSA-id exception model, the fail-loud-on-unrecognized-shape history).
- `scripts/devops/pnpm-audit-exceptions.json` — the accepted exceptions, each
  with its own reasoning; read the existing groups before writing a new one.
- `scripts/devops/tests/test-check-pnpm-audit.sh` — the gate's own test suite,
  including the exact "unaccepted advisory → red, properly excepted → green"
  round-trip AC7 asks for.
- `.claude/rules/common/version-pins.md` — hard pins an override must not cross.
- `.claude/rules/common/mutation-gate-integration-specs.md` — a different gate,
  same underlying shape of lesson: a green run is not proof of what you think
  it proves unless you know what the tool can and cannot see.
