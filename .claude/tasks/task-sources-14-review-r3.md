# Review round 3 — PR #1445 (branch `feat/sources-dice-nofluff`, head ae38aa064, base `main` @ 4c1d2bc1f)

READ-ONLY. Do not edit, create or commit any file in any checkout. Do not post to GitHub: return your review text.

## What changed since round 2 (head ca71ed7f2)

Two commits (`6b25bd031` failing specs, `ae38aa064` fixes) resolve the 6 round-2 findings in
`.claude/tasks/task-sources-14-fix-round2.md` (read it first: it is the spec for this round). Delta diff (483 lines):
`.claude/tasks/pr1445-r3.diff`. Paths are relative to the repo root
`~/.t3/worktrees/CheekyCheeseIT_CRM/t3-e2d4e8c0-f9e0b534f5d3bb43`. That checkout's HEAD is OLD: read files
with `git show origin/feat/sources-dice-nofluff:<path>` after `git fetch origin`. Earlier rounds:
`task-sources-14-review-r2.md`, `task-sources-14-fix-round1.md`.

Files: `providers/sources/sitemap-jsonld.ts` (SHARED, live for JustJoin / Landing / The Hub / Next Level Jobs:
`canonicalUrlOf` now a linear `<link` scan replacing the quadratic `CANONICAL_LINK` regex), new
`sitemap-canonical.spec.ts` (hostile 2 MiB inputs < 100 ms; old-regex equivalence on edge cases + every captured
fixture), `listing-detail.collector.ts` (+ spec): 2 consecutive detail 3xx -> `ACCESS_POLICY`; at 2 pages in a row
without a posting one tiebreaker read (the last unread item = the turning slot) before the stop, max 3 pages; one
request report per fetch on the stop; a `json-ld: none` sample per such page; robots fail-closed on a non-empty body
with no directive line (empty body = allow-all).

Coder claims: `@crm/api` 22 358 passed; typecheck 0; mutation `--changed` 822 / 812 killed / 0 survived / 7 ignored,
no new suppression; trio / NLJ / sitemap-jsonld specs: 0-line diff; manifest unchanged.

## Your axis

- **code-reviewer**: correctness of the delta; `canonicalUrlOf` returns exactly what the old regex + href extraction
  returned (attribute order, quotes, case, whitespace, `>` inside an attribute value, self-closing); the tiebreaker /
  streak logic (resets, off-by-one, empty `due`, a tiebreaker that is a 3xx/404); regressions for the trio + NLJ; TS strict.
- **security-reviewer** (mandatory, PROHIBITED lift): no ReDoS left in the delta (`CANONICAL_REL`, `HREF{1,2000}`,
  `ROBOTS_DIRECTIVE`); the redirect-block stop and the tiebreaker cannot send more requests than the manifest bound or
  turn a block signal into continued fetching; robots fail-closed holds with prod's empty headers; nothing new is
  fetched off-host or robots-disallowed.
- **spec-reviewer**: delta vs `task-sources-14-fix-round2.md`: each of the 6 IDs resolved as decided; PR body
  (`gh pr view 1445 --json body`) has the CR2-L-1 Assumption and the `fix2:` Task line.

Also say whether each round-2 finding of your axis is resolved.

## Output (first lines exactly, then findings)

code-reviewer: `Verdict: APPROVE` or `Verdict: BLOCK`
security-reviewer: `Security Review: APPROVE` or `Security Review: BLOCK`
spec-reviewer: `Spec Review: PASS` or `Spec Review: FAIL`

Then `Findings: H=<n> M=<n> L=<n> (<total>)`, then one line per finding:
`<id> | <H/M/L> | <path>:<symbol or line> | <problem> | <smallest fix>`. Real problems only, no style nits, no praise.
Notes server: `notes.search` before reading code; `notes.add` facts with file:line.
