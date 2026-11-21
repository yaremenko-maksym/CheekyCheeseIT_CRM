# Task sources-13 fix round 1 — PR #1444 (branch `feat/sources-sitemap-trio-3`, head 6fb39b422, base `main`)

Earlier: `task-sources-13-sitemap-trio.md`, `task-sources-13-rebase-r1.md` (same directory). Review round 1:
code APPROVE (M=1 L=3), security APPROVE (L=1), spec FAIL (M=1 L=4). Resolve all below.

## Findings to resolve

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| CR-M-1 + S-1 | M | `justjoin.provider.ts` `APPLY_URL` / `justJoinApplyUrl` | The regex takes every `\"applyUrl\":\"…\"` anywhere in the ~650 KB Next.js payload, so a similar/recommended offer's ATS URL can become this posting's url and merge two jobs. No fixture holds the real payload segment. **Do:** capture 2-3 real JustJoin.it offer pages (plain GET, owner-approved for captures; NO_EVASION: a 403 / 429 / challenge ends it — no UA change, proxy or headless; then go to the fallback). Include at least one offer that applies in-site if you can find one. Count `applyUrl` occurrences per page and record it in the fixture provenance. Commit a redacted excerpt of the payload segment(s) around `applyUrl` as a fixture (no personal data: recruiter names / emails / phones redacted). Anchor the match to the offer's own object (e.g. its slug next to `applyUrl`), drive the test from the fixture, and add a test where a foreign offer's `applyUrl` is present and this offer's is not -> null. **Fallback** (capture refused or the anchor cannot be proven): `justJoinApplyUrl` returns null always, with a `shortcut:` comment, and the PR body says JustJoin.it has no ATS dedup either |
| SEC-L-1 | L | `manifest.owner-decisions.spec.ts` | Add one assertion over `MANIFEST_DEFINITIONS`: the set of types carrying an `ACCEPT_PROHIBITED_RISK` decision equals `['JUSTJOIN_HTML','LANDINGJOBS_HTML','THEHUB_HTML']` (same pattern as the existing partition check for the 2026-11-16 decisions) |
| CR-L-1 | L | `sitemap-sites.spec.ts` "parses a full-size part (11 054 URLs …)" + JustJoin `sitemapLimits` | Build the synthetic part with the real per-URL shape (`loc`, `lastmod`, `changefreq`, `priority`) and assert the item count against `itemCeiling(JUSTJOIN_SITE.sitemapLimits)`. Raise the wall-clock and `maxElements` limits so the measured part has about 3x headroom; state the numbers in a comment. Stay under the 10 MiB byte ceiling |
| CR-L-2 + S-2 | L | `justjoin.provider.ts` module doc + PR body | Comment: `baseSalary` is published, not mapped (the observation contract has no compensation field). PR body: one Follow-ups line (salary field = owner decision, no DDL here) |
| CR-L-3 + S-5 | L | `owner-decisions.ts` `ALL_PROHIBITED_REFERENCE` (also the main-side Cyrillic line in the same file) + PR body Assumption A1 | Replace the Russian quote with the English rendering the provenance files use: "connect, I accept the risk for every site" marked `(owner's words, translated)`. Fix the PR body too |
| S-4 | L | `thehub.provider.ts`, `justjoin.provider.ts`, `landingjobs.provider.ts` `jobUrl` | An upper-case `<loc>` is now skipped silently. Add the `i` flag to these `jobUrl` regexes, normalise the id to lower case the same way NLJ does, and rely on `identityUrlOf` for identity (the fetch keeps the sitemap URL). Test per site: upper-case sitemap loc + lower-case JSON-LD/canonical URL -> one observation |
| S-3 | L | PR #1444 body | Rewrite for the new head: Task line (base `main`, list the rebase and this fix task), the D-1 Assumption (`turn = deps.random()` once per run, not the clock hour), Follow-ups (base pin 22), Verification (the new numbers, scratch DB name, pre-push sha), one line per site for D-3 and D-4 choices. Write the body to a file and `gh pr edit 1444 --body-file <file>`; keep any `## Council review` block and Flow lines that exist |

Out of scope (owner decision batch, do NOT change): JustJoin.it 20 details per run; no ATS link on The Hub / Landing.jobs; `enabled=false` default.

## Do

TDD (failing tests first), then fixes. No DDL. Integration specs only on scratch DB `crm_qa_s13_r1` (`DATABASE_URL`
inline, never crm_db). Run the source specs, `pnpm --filter @crm/api test`, typecheck, eslint on changed files, prettier,
mutation gate `node scripts/devops/mutation-gate.mjs --changed` (alone, not during a push). If the seed-delta count or
any manifest snapshot changes, update and run it on the scratch DB.

Work from `origin/feat/sources-sitemap-trio-3`. Commit `fix(job-sourcing): anchor JustJoin applyUrl, case-insensitive
trio ids, review round 1` with `ac_verified: CR-M-1,S-1,SEC-L-1,CR-L-1,CR-L-2,S-2,CR-L-3,S-5,S-4,S-3`. Push fast-forward
`DATABASE_URL= git push origin HEAD:feat/sources-sitemap-trio-3` (pre-push ~25 min: background, wait, no second push).

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify with `git ls-remote origin feat/sources-sitemap-trio-3`), test
counts (non-zero), mutation result, the capture result (pages, `applyUrl` counts, anchor or fallback), `Findings resolved (10)`.

## Rules

Zone `apps/api/**` (+ the PR body). Every Edit/Write path starts with your own `git rev-parse --show-toplevel`. No
`--no-verify`, explicit `git add`, never create `.claude/.allow-direct-edits`. No second-opinion. External GETs only to
justjoin.it offer pages for the capture, a handful, spaced. No secrets or personal data in fixtures, PR body or report.
Do not touch PR #1445. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
