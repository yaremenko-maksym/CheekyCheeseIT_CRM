# Task sources-13 fix round 2 — PR #1444 (branch `feat/sources-sitemap-trio-3`, head 275e6f356, base `main`)

Earlier: `task-sources-13-fix-round1.md` (same directory). Round-2 delta review: APPROVE / APPROVE / PASS, 0 findings.
Second-opinion (big-pickle) left two confirmed findings. Resolve both, nothing else.

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| BP-M-1 | M | `apps/api/src/job-sourcing/providers/sources/justjoin.provider.ts` `JUSTJOIN_SITE.sitemapLimits` (now `sitemapLimits(8 * 1024 * 1024, 1700, 170_000)`) | 170 000 elements exceeds the global memory cap `MAX_XML_ELEMENTS = 100_000` (`apps/api/src/job-sourcing/xml/xml-limits.ts`, "a caller that raises the time budget still cannot exceed the memory cap"), and the 1700 ms budget is a synchronous event-loop block. Set the time budget back to **1000 ms** and the element limit to **100 000** (keep 8 MiB bytes). Rewrite the comment above it with the real numbers: measured part 55 271 elements / 55 272 items, so about 1.8x headroom. Add `// shortcut: about 1.8x over the measured part; past ~20k active jobs every run fails loud as PARSE_DRIFT. Upgrade to a streaming parse (or parse in the extraction worker) before raising the caps.` Update `sitemap-sites.spec.ts` "full-size part" so it asserts the realistic part fits under `itemCeiling(JUSTJOIN_SITE.sitemapLimits)` and `maxElements`, and that both limits equal 1000 ms-derived / 100 000 (not above `MAX_XML_ELEMENTS`). |
| BP-L-1 | L | `apps/api/src/job-sourcing/providers/sources/thehub.provider.ts` `select` (`selectByIdentity(postings, { identifier: job.id })`) | `job.id` is lower-cased, but `selectByIdentity` compares the page's JSON-LD `identifier` byte-exact, so an upper-case identifier on the page drops the posting. Compare case-insensitively for The Hub only: e.g. map postings to a lower-cased `identifier` before calling `selectByIdentity` (do not change `selectByIdentity` itself — it is shared). Test: upper-case `<loc>` + upper-case JSON-LD identifier -> one observation with lower-case `nativeId`. |

## Do

TDD (failing test first). Run `pnpm --filter @crm/api exec vitest run src/job-sourcing/providers`, typecheck, eslint on
changed files, prettier, mutation gate `node scripts/devops/mutation-gate.mjs --changed` (alone). No DDL, no DB.

Work from `origin/feat/sources-sitemap-trio-3`. One commit `fix(job-sourcing): JustJoin sitemap caps within the global
XML limits, case-insensitive The Hub identifier` with `ac_verified: BP-M-1,BP-L-1`. Push fast-forward
`DATABASE_URL= git push origin HEAD:feat/sources-sitemap-trio-3` (pre-push ~25 min: background, wait, one push). In the
PR body (`gh pr view 1444 --json body` -> file -> edit -> `gh pr edit 1444 --body-file <file>`), change only the CR-L-1
line / any "3x" headroom claim to the new numbers and add one Follow-ups line for the shortcut.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify `git ls-remote origin feat/sources-sitemap-trio-3`), test
counts (non-zero), mutation result, `Findings resolved (2)`.

## Rules

Zone `apps/api/**` (+ the PR body). Every Edit/Write path starts with your own `git rev-parse --show-toplevel`. No
`--no-verify`, explicit `git add`, never create `.claude/.allow-direct-edits`. No second-opinion. No external GETs.
Do not touch PR #1445.
