# Task sources-14 fix round 1 — PR #1445 (branch `feat/sources-dice-nofluff`, head 422daa5e6, base `main`)

Earlier: `task-sources-14-dice-nofluff.md`, `task-sources-14-rebase-r1.md` (same directory). Review round 1: code BLOCK
(M=1 L=3), security APPROVE (M=1 L=2), spec FAIL (M=2 L=4), second-opinion 2 more confirmed. Resolve all below.
Files: `providers/sources/listing-detail.collector.ts` (collector), `dice.provider.ts`, `nofluff.provider.ts`.

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| CR-M-1 + SR-M-1 | M | collector `politeFetch` | Robots is checked only on the requested URL; the transport follows up to 3 redirects unchecked, so a detail that redirects to a robots-disallowed path is fetched (breaks the Dice owner-decision scope "never fetched"). Send listing, detail and robots requests with main's `followRedirects: false` (see `reporting-provider.ts` `FetchRequest`, used in `html-provider.ts`). A detail 3xx = posting gone: skip like the 404 (count it, no request to the target). A listing 3xx = fail closed (`PARSE_DRIFT` or `ACCESS_POLICY`, whichever the collector uses for a listing it cannot read). Spec: a detail 301 to a disallowed path is never requested. Update the manifest `requestsPerRun` "+4 for redirects" reserve (drop it, or state why it stays) and its pins |
| SR-L-1 | L | collector robots fetch | A 200 robots body that is HTML parses as zero rules = allow-all. Fail closed: a 200 robots whose content-type is not `text/plain` or whose body starts with `<` (after trim, case-insensitive) is unreadable -> stop the run the same way as an unreadable robots. Spec |
| SR-L-2 + NU-H-1 | L | collector detail loop | A challenge served as 200 (no `cf-mitigated`) is counted invalid and the loop goes on (up to 25 more requests). Stop early: 2 consecutive detail pages with no JSON-LD posting at all -> end the run as `PARSE_DRIFT` (not evasion, a stop). Fix the Dice header comment so it states what is signalled how. Spec |
| NU-M-1 | M | `dice.provider.ts` `PUSH`, `nofluff.provider.ts` `STATE` | Lazy `[\s\S]*?` regexes are quadratic on repeated open tags: measured 4 MiB of repeated `<script>self.__next_f.push([` = 45 s and of the NFJ state opener = 44 s synchronous block (1 MiB = 2.8 s). Replace both with an `indexOf` scan (find opener, then the terminator from there; next search starts after the terminator; an opener without a terminator ends the scan). Same results on the fixtures. Spec: 4 MiB adversarial input parses in < 100 ms |
| S1 (+ BP x2) | M | collector run loop | The collector duplicates main's detail loop (`sitemap-jsonld.ts`) and drops two of its fixes: (a) the turning slots of `detailsToReadOf` (PR #1443 D-1: a failing, never-held page takes a top slot every run; `.slice(0, maxDetails)` brings that back; NFJ's 8 categories x 40 spend all details on the first category) and (b) the `DRIFT_WINDOW_MS` / `recentInvalid` drift rule (here `invalid > normalized && invalid >= 3` counts stale pages). Preferred: extract main's selection (turning share with `deps.random()` once per run) and drift-window rule into shared functions both loops call, without changing sitemap-site behaviour (trio + NLJ specs pass unchanged). If an item has no created date, follow main's rule for unknown age. Also round-robin across listing pages/categories before the turning share, so one category cannot take every slot |
| CR-L-1 + S2 | L | `job-sourcing-collect-all-types.spec.ts` | Restore the lost check: a SCHEDULED-only row (e.g. `row('WTTJ_HTML','SCHEDULED')` or a second legacy row with its own id) is skipped by `collectAll('MANUAL')` and runs on `collectAll('SCHEDULED')` |
| CR-L-2 | L | `parseDiceListing`, `parseNofluffListing` | One malformed item (fails `itemSchema`, or Dice `detailsPageUrl` not exactly the built GUID URL) fails the whole listing. Skip the bad item, record it as an invalid sample; fail as drift only when the page has no valid items or most items are malformed |
| CR-L-3 | L | collector `identityKeyOf`, `selectNofluffPosting` | Reuse main: one identity encoder shared with `siteIdentityKey`, and build `selectNofluffPosting` on `selectByCanonical` |
| S3 | L | PR body Follow-ups | Fix the salary line: Dice has no JSON-LD `baseSalary` (free text on the listing); NFJ's detail has `baseSalary`. Say a salary field is an owner decision (Master raises it). No code |
| S4 | L | PR body | Move "enabled=false by default" out of Assumptions into an owner note: "after deploy, an ADMIN enables both rows" |
| S5 | L | `owner-decisions.ts` `NOFLUFF_OWNER_DECISION.scope` | The text implies the regulamin was read; it could not be read without JavaScript. Say so; the permission is UNCLEAR for that reason |
| S6 | L | PR body first line | `Task: task-sources-14-dice-nofluff.md (rebase: task-sources-14-rebase-r1.md, fix: task-sources-14-fix-round1.md)` |

## Do

TDD (failing tests first), then fixes. No DDL. If the seed-delta / manifest outputs change, regenerate
(`job-sources:manifest:generate`) and run the seed-delta integration spec on scratch DB `crm_qa_s14_r1`
(`DATABASE_URL` inline, never crm_db). Run `src/job-sourcing` specs, typecheck (build `@crm/inference` first in a
fresh worktree; use node 22 on PATH), eslint on changed files, prettier, mutation gate
`node scripts/devops/mutation-gate.mjs --changed` (alone, not during a push).

Work from `origin/feat/sources-dice-nofluff`. Push early `wip:` commits (fast-forward). Final commit
`fix(job-sourcing): robots-safe redirects, linear payload scans, shared detail selection, review round 1` with
`ac_verified: CR-M-1,SR-M-1,SR-L-1,SR-L-2,NU-M-1,S1,CR-L-1,S2,CR-L-2,CR-L-3,S3,S4,S5,S6`. Push
`DATABASE_URL= git push origin HEAD:feat/sources-dice-nofluff` (pre-push ~25 min: background, wait, one push).
PR body: rewrite for the new head (file + `gh pr edit 1445 --body-file`), read `.claude/rules/common/doc-durability.md`
first; keep any `## Council review` block.

Report: `Worktree:`, `Pushed: <branch> @ <sha>` (verify `git ls-remote origin feat/sources-dice-nofluff`), test
counts (non-zero), mutation result, the S1 approach taken (shared or ported) and whether trio/NLJ specs changed,
`Findings resolved (14)`.

## Rules

Zone `apps/api/**` (+ the PR body). Every Edit/Write path starts with your own `git rev-parse --show-toplevel`. No
`--no-verify`, explicit `git add`, never create `.claude/.allow-direct-edits`. No second-opinion. No external GETs.
No secrets or personal data. Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
