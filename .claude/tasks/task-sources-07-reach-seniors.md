# task-sources-07-reach-seniors — does anything collected reach a senior?

## Agent: coder (read-only first)
## Status: ready
## Model: claude-opus-5 medium (jev T2)
## Branch: none for phase 1 (read-only); `fix/sources-07-<slug>` only if AC 3 yields a PR
## Source: `~/.claude/handoffs/sources-connect-2026-11-19/task-07-suggestions-empty.md`

## Context (overrides stale text)
The handoff README (`~/.claude/handoffs/sources-connect-2026-11-19/README.md`) overrides
`.claude/agents/project-state.md` §1.2 ("no collection", "no GETs made" are stale: reporting runs
collect thousands of postings a week on prod).

Prod facts 2026-11-19: `job_suggestions` = 0 rows, legacy `job_postings` = 0 rows.
`JOB_QUEUE_BRIDGE_ENABLED` is not set in `/opt/crm/.env.production`. Queue tables exist
(`job_queue_*`, `job_opportunities`, `job_opportunity_matches`, `job_role_classifications`).
Flag readers: `apps/api/src/config/env.ts`, `apps/api/src/job-sourcing/job-sourcing.service.ts`.

Must read before classifying: `.claude/tasks/task-vacancy-8-rollout.md` (Phase 8 brief: item 2
"first activation wave" is still OPEN, owner said "not now until item 1 deployed"; item 1 #1333 is
deployed) and backlog 263 in `.claude/tasks/BACKLOG-followups.md` (must land before the first
writer to `job_queue_actions`).

## Prod access (read-only, aggregates only)
```
ssh crm-vps 'docker exec -e PGOPTIONS="-c default_transaction_read_only=on" crm-postgres-1 psql -U crm_user -d crm_db -c "SELECT current_database(); <your SELECT>"'
```
First statement in every session: `SELECT current_database()`. Counts / group-bys only, no names,
emails, titles or URLs in the report. `.env.production`: grep key NAMES only
(`ssh crm-vps 'grep -o "^[A-Z_]*" /opt/crm/.env.production'`), never values.

## Acceptance criteria
1. Trace in code where a stored reporting observation is supposed to become something an HR user
   or senior sees (queue generations, opportunities, matches, role classifications, suggestions),
   with file:line per hop.
2. Prod row counts per stage (aggregates), and the first empty stage with its proven cause (flag
   off / worker not wired / relevance not configured / cron not running / other).
3. Classify the fix: (a) a flag/wiring that was meant to be on and is not gated by an open owner
   decision -> small PR through the normal path; (b) gated by Phase 8 item 2 or backlog 263 or any
   product question (who sees what) -> NO code; write a decision brief per
   `.claude/skills/decision-frontier/SKILL.md` §"The decision-brief contract", recommendation
   included.
4. Report: stage counts table, cause, classification, brief text (if b) or PR URL (if a).

## Assumptions
- (A1) Phase 1 writes nothing; it is a report to Master.
