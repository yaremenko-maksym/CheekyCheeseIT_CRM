# Codebase Gardener — weekly "cleanup + optimization" pass

**Status:** agreed with the owner (grilling 2026-10-04) · trawl done 2026-10-05 (proved ROI) ·
set up as a weekly scheduled task.

Goal: cleaner base → faster tests/CI → **cheaper and more precise agents, fewer tokens and less noise**. The process
is convergent: the first runs are large (they pay down accumulated debt), then it is light weekly hygiene.

This file is the single source of truth for the gardener. The weekly task reads and executes it.

---

## How it is triggered

- **Weekly** via `mcp__scheduled-tasks` (cron). The task wakes a fresh orchestrator session with
  a short prompt "read this file and perform the weekly run".
- **Mode — full auto** (owner decision): green CI + clean automatic reviewers
  (security-reviewer on sensitive changes, code-reviewer, mutation-gate) → **auto-merge → auto-deploy**.
  There is no human gate; quality is held by the checks, not by manual approval.
- Per run — **all categories** (not rotation). Within: audit → fix plan → loop over the plan.
- **Each fix = a separate PR per category.** Independent CI+review+merge: one fails — the rest go on.

## Phase 1 — Audit (read-only, breadth-first)

Go through the categories, collect findings, produce a fix plan ranked by ROI/risk
(safe+high-ROI first). Measure the baseline numbers BEFORE (lines/files, dead exports, CI time,
bundle, number of `any`, size of agent files).

> **Lesson from the 2026-10-05 trawl: audit estimates are overstated, verify with facts.** On the trawl, the "~1 MB of ECC garbage"
> turned out to be nonexistent (plugin cache outside the repo), the "~51 prod `any`" turned out to be one line. Do NOT
> dispatch an agent against an unverified target — first confirm with `grep`/`du`/`ts-prune` that there is
> actually work to do.

## Phase 2 — Loop (execution)

Dispatch writing agents in isolation (`isolation="worktree"`), reading agents normally. The parallelism
ceiling is ≈3–4. Transfer review findings by identifiers (`CR-`/`SR-`…) and report on
each one (lose nothing).

## Categories (what it does per run)

1. **Dead code:** unimported exports, unreachable code, commented-out code, unused
   deps/routes/env/flags, forgotten files/assets. Delete ONLY with proof of zero references
   (`grep`/`ts-prune`/`knip`) + green typecheck/tests. Doubt → keep.
2. **Dedup:** repeated utilities/helpers → one place. Merge ONLY behaviorally identical
   copies (compare bodies + edge-cases); diverged ones — keep, report.
3. **Refactor/file architecture:** splitting giants (>800 lines), module boundaries.
   **Giants (`transactions.service.ts` ~9k lines, `schema.ts`, `users.service`, large routes) are
   human-planned, NOT a blind auto-PR.**
4. **Pattern consistency:** unified error-handling/DTO/hooks/naming; `CONTEXT.md` terms.
5. **Tests:** speedup + sharding (measure CI wall-clock), de-flake, coverage gaps on
   critical paths (the signal is surviving mutants).
6. **Typing/quality:** remove `any` (→ `unknown`+narrowing, not `any`), tighten types, lint;
   strictness ratchet.
7. **Dependencies/software:** patch/minor — auto, **STRICTLY within `version-pins.md`** (Node 22, Vite 6
   not 7, the TanStack Router EXACT pair, Lingui 5.9.5, the Fastify override, Zod v4, Drizzle ^0.45). Majors
   of pinned ones — per the rules of that file, not blindly. A bad bump → red CI → does not merge.
8. **Security:** `pnpm audit`/CVE, secret leaks, outdated auth/crypto, dep licenses.
9. **Performance:** eager bundle, lazy-load, dead CSS, assets (webp/avif), **N+1**,
   extra/missing DB indexes, and **algorithmic complexity (strict, owner decision
   2026-10-05):** super-linear `O(n²)+` (nested loops, `.find`/`.includes` in a loop → `Map`/`Set`),
   repeated scans, load-all-then-filter-in-JS (→ SQL), React render without `useMemo`. Always flag;
   severity by data growth (growing tables `transactions`/`users`/`job_postings` = blocker,
   bounded ones = a note "current→reachable class"). The rubric is `.claude/agents/code-reviewer.md`
   Step-3 "Efficiency".
10. **CI/build:** cache, duplicate/extra steps, parallel jobs, turbo tuning.
11. **Configs/assets/naming:** hygiene.
12. **Documentation + comments** — see the philosophy below.
13. **⭐ META — agent surface** (`.claude/rules`, `.claude/agents/*`, skills, `CLAUDE.md`,
    `CONTEXT.md`): keep **precise and thin**. Scope rules by paths (`paths:` frontmatter —
    honored for `rules/common`, verified on the trawl); remove dead docs; cut status snapshots.
    **Highest ROI — do it first** (on the trawl it gave ~30k tokens/session).
14. **TODO/FIXME triage:** resolve or move to the backlog.

## Comment philosophy (owner decision)

**The code is read by an AGENT, not a human → we optimize comments for the agent; for people — `docs/`.**

- Remove: human prose, obvious restatements (`// increment i`), stale content, duplicated docs,
  **stale references to removed files** (a frequent finding after dead-code/dedup).
- Keep/add: the "why" (not the "what"), invariants, "intentional, do NOT fix" markers, gotcha/incident,
  blast-radius, coverage hints ("caught by test X"). Length is not a sin — **noise is a sin**. Valuable long
  agent notes are NOT to be removed.

## Safety (machine safeguards, NOT human gates)

- **Destructive/consolidating migrations** — only **expand-contract / parallel-change**:
  Deploy-1 create the new + backfill + verify (reversible, the old one stays in place); Deploy-2 (after
  verification in prod) drop the old one as a separate step.
- **DB snapshot before any `DROP`/destructive DDL.**
- Prod DDL only through `deploy.yml`. Volume data (Postgres) must not be touched destructively outside migrations.
- Sensitive changes (finance/RBAC/auth/crypto/migrations) → security-reviewer is MANDATORY before merge.

## Gates and CI pitfalls (lessons from the 2026-10-05 trawl)

- **Branch-protection required contexts — do not rename.** Exactly: `Typecheck · Lint · Unit
Tests`, `E2E Tests`, `Integration Tests (Postgres)`, `Mutation Gate`. A rename does NOT give
  a red CI — it silently hangs the merge for everyone. Split a job → keep an aggregator with the exact required name
  (`needs:` + `if: always()`), as done for `quality`/`mutation_summary`/`e2e_summary`.
- **Guard-test gate (FM-5):** a change to a security controller (`apps/api/src/**/*.controller.ts`) requires
  a backend 403 test OR the line `guard-test-na: <reason>` in the PR body. **The gate reads the body on the event
  `pull_request` [opened/synchronize/reopened], NOT on `edited`** — so adding `guard-test-na`
  by editing the body is not enough, a new event is needed: **close+reopen the PR** (or a new commit).
- **`gh run rerun` replays the OLD event payload** (the old PR body) — to read the new body you need a
  fresh run, not a rerun.
- **E2E misc/projects shards flake** under load — `gh run rerun <id> --failed`; but **two failures
  in a row = not a flake**, investigate.
- **Fresh worktree:** `pnpm install --frozen-lockfile` (otherwise the husky pre-commit fails with ENOENT); for
  web-typecheck, generate the gitignored `routeTree.gen.ts` via `pnpm --filter @crm/web build`.
- **Pushing feature branches:** `DATABASE_URL= git push` (integration specs graceful-skip, do not hit the live DB).
- **Merging a PR that touches `.github/workflows/**`:** a `GITHUB_TOKEN`without the`workflows`scope → the label-based auto-merge will not fire, merge manually with`gh pr merge --squash`.
- **On merge gates, check CI proactively** (`gh pr checks`/mss), do not wait for a notification passively.

## Measurement (trawl → weekly)

Measure BEFORE/AFTER: base size, dead exports/dupes, CI/test time, bundle, `any`/lint-warnings,
agent-file size. The 2026-10-05 trawl showed a steady win (−30k tokens/session from scoping
rules + removal of the PM surface −2560 lines + CI −220s) → set up as weekly.

## Do not conflict with active features

Know the open PRs/branches; avoid their zones or rebase. On the trawl the active zone was vacancy-sourcing
(`apps/{api,web}/**/{vacancies,job-sourcing}`, `packages/shared/**/{vacancies,job-sourcing}.ts`).

## Related

- `.claude/rules/common/version-pins.md` — pins (category #7).
- `.claude/rules/common/live-db-access.md` — DB access (read allowed, write not).
- `.claude/agents/code-reviewer.md` Step-3 — efficiency/complexity (strict).
- `.claude/rules/common/light-track.md` · `orchestration-routing.md` — track/parallelism.
