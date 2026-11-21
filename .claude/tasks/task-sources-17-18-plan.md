# Task sources-17/18 — implementation plans: structured salary (17) and cross-source dedup (18)

READ-ONLY planning. Do not edit code, do not commit to a branch other than writing the two plan files below. Read
`origin/main` (`git fetch origin`, then `git show origin/main:<path>`; the checkout HEAD may be old).

## Owner decisions 2026-11-21 (chat)

- **17 Salary:** store a structured salary on postings: `min`, `max`, `currency` (ISO 4217), `period`
  (`HOUR | MONTH | YEAR`), filled ONLY where a source gives structured data (e.g. No Fluff Jobs JSON-LD
  `baseSalary`, Jobicy `salaryMin`/`salaryMax`, other API / ATS fields, JSON-LD `baseSalary` in the shared sitemap
  core). No free-text parsing (Dice's salary text stays unparsed). Goal: HR sees the salary and can filter by it.
- **18 Dedup:** the same job reached through an aggregator without the employer apply link (The Hub, Landing.jobs,
  Dice, No Fluff Jobs, Next Level Jobs, ...) and through an ATS source (Greenhouse, Lever, Ashby, Workable,
  Recruitee, Personio, SmartRecruiters) is ONE vacancy in the HR queue: normalized title + normalized company
  within 14 days; the ATS copy wins. Also key Ashby by job id instead of company (org) id in the Next Level Jobs
  ATS-first dedup.

## Known facts (verify, do not trust)

- `funnel/layer1.ts` already classifies salary (`classifySalary`, `SALARY_FLOOR_USD_MONTHLY`) from
  `Layer1Input.salary`; `funnel/layer1.types.ts` declares `SalaryObservation` "as persisted with the observation",
  but no adapter appears to set it and `runtime/recompute-inputs.ts` has no salary. The queue API schema has a
  `salary` filter (`packages/shared/src/schemas/job-sourcing-queue-api*`). Find where the gap really is.
- Postings have a `fingerprint` dedupe spine (canonical URL); the bridge delivers by fingerprint
  (`bridge/bridge-delivery.ts`). Find the existing apply-URL dedup and the Ashby org-UUID key from PR #1443.

## Output

Write two files in your own checkout and report their full text in your final message (they are gitignored; Master
copies them): `.claude/tasks/task-sources-17-salary.md` and `.claude/tasks/task-sources-18-dedup.md`. Each one is an
implementation task file for a coder, in the style of the other `task-sources-*.md`: Why, Facts (with symbols),
Do (numbered, TDD), DDL (Drizzle migration path per `.claude/agents/project-state.md` migration rules; prod DDL only
through the deploy pipeline), the UI part if any (`apps/web` — note it triggers the design gate and manual QA; keep
it to the existing queue card / filter pattern), Acceptance criteria (numbered), Rules (zone, scratch DB name
`crm_qa_s17` / `crm_qa_s18`, `DATABASE_URL` inline, no external GETs except one capture per source if a fixture
lacks the salary field), and Risks. State which files 17 and 18 both touch, so Master can order them. For 18, name
the false-merge risk and the smallest guard.

Rules: no secrets or personal data; never write to `crm_db`; read prod only if needed, aggregates only, via
`mcp__postgres__query` locally is NOT prod. No second-opinion. Notes server: `notes.search` before reading code,
`notes.add` facts with file:line. End with `Token-economy:` line.
