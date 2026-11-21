# Task sources-12 fix round 2 — PR #1443 (branch `feat/sources-nextleveljobs`, head 688c4e37b)

Earlier rounds: `task-sources-12-nextleveljobs.md`, `task-sources-12-fix-round1.md` (same directory). Round-1 delta
review (APPROVE, L=4) and second-opinion (big-pickle) left the findings below. Resolve all.

## Findings to resolve

| ID | Sev | Where | Decision |
| --- | --- | --- | --- |
| D-1 | L | `nextleveljobs.provider.ts` older-id slot offset | The offset rotates hourly, but runs come every 2 h / 6 h, so the stride aliases and some older ids are never reached. Rotate per run (e.g. from `deps.random` / the run's own seed), not by wall-clock hour. Test: across N consecutive runs every older unseen id gets a slot |
| D-2 | L | detail loop, 410 / persistent 5xx on the newest id | Do not change behaviour (shared metered-fetch, follow-up). Add a one-line `shortcut:` comment naming the limit; Master files the backlog item |
| D-3 | L | `APPLY_BUTTON` match | If the site renames the button class (`bg-lime-500`), dedup to the employer ATS silently stops. Emit a signal when JSON-LD parsed but no apply button matched (an invalid sample or a counted metric the health checks already read — pick the existing mechanism, no DDL). Test |
| D-4 + SO big-pickle | M | `parseSitemap` + `selectByIdentity({ url })` | The id is lowercased but the URL keeps the sitemap case, so an uppercase sitemap URL never matches a lowercase JSON-LD URL and the posting is dropped. Normalise the URL used for identity (the id part lowercased, same as the id) and compare normalised; keep fetching the URL the sitemap gave. End-to-end test: uppercase sitemap URL + lowercase JSON-LD URL -> one observation |
| SO big-pickle | L | drift window check (`nowMs - createdAtMs(job.id) < DRIFT_WINDOW_MS`) | A future-dated id gives a negative age and counts as recent. Treat age < 0 as not recent (or clamp to 0 and document). Test |

Out of scope (owner decision batch, do NOT change): `enabled=false` default; Ashby org-UUID dedup; 410 handling itself.

## Do

TDD (failing tests first), then fixes. No DDL. Integration specs only on scratch DB `crm_qa_s12_r2`
(`DATABASE_URL` inline, never crm_db). Run the provider unit specs, `pnpm --filter @crm/api test`, typecheck, eslint
on changed files, prettier, mutation gate `node scripts/devops/mutation-gate.mjs --changed`.

Work on a local branch `fix/sources-12-r2` from `origin/feat/sources-nextleveljobs` and push fast-forward with
`DATABASE_URL= git push origin HEAD:feat/sources-nextleveljobs` (pre-push runs the suites; commit tests + fix together).

Commit `fix(job-sourcing): NLJ per-run rotation, normalised identity url, button-missing signal` with
`ac_verified: D-1,D-2,D-3,D-4,SO-bigpickle-future-id`. Report `Worktree:`, `Pushed: <branch> @ <sha>` (verify with
`git ls-remote origin feat/sources-nextleveljobs`), test counts (non-zero), mutation result, `Findings resolved (5)`.

## Rules

Zone `apps/api/**` only. Every Edit/Write path starts with your own `git rev-parse --show-toplevel`. No
`--no-verify`, explicit `git add`, never create `.claude/.allow-direct-edits`. No second-opinion. No external GETs
(use fixtures). Notes server: `notes.search` before reading code, `notes.add` facts with file:line.
