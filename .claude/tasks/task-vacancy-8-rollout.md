# Task 8.1–8.3: vacancy sourcing rollout — runbook, activation checklist, post-deploy checks

## Status: 8.1 done (PR pending), 8.2 prepared (nothing enabled), 8.3 first read-only run done 2026-11-14

Plan: `docs/superpowers/plans/2026-10-10-vacancy-sourcing-plan.r5.md` Phase 8, Rollback, Spec coverage.
Owner: Master (docs zone). Branch `docs/phase8-vacancy-sourcing-runbook`.

## Deliverables

- `docs/runbooks/vacancy-sourcing.md` — §0–§10 operations (8.1), §11 activation checklist (8.2), §12 dry runs,
  §13 read-only checks + the 2026-11-14 run (8.3), §14 rollback, §15 spec coverage self-check.
- `docs/runbooks/vacancy-sourcing-measurements.md` — MP-01…MP-14 rules, template, status board, MP-04 entry.
- `docs/runbooks/human-only.md` items 8–11.
- `.claude/tasks/BACKLOG-followups.md` item 434 (production schema drift).

## Acceptance criteria

1. The runbook covers every 8.1 bullet or names it "not built" (§15).
2. 8.2 is a checklist and a decision brief only; no flag, env key, source switch or DDL changed.
3. 8.3 production access only with the owner's chat permission, read-only session (`default_transaction_read_only=on`),
   aggregates only; results recorded with the commit they were taken on.
4. Doc-durability: symbols and paths, no line numbers.

## Assumptions (A1)

- The prod check found that `/api/health` names its field `commit`, not `GIT_COMMIT`; the runbook uses the real name.
- The human-only items are numbered 8–11 (the registry ended at 7.2).
- "Migrations agree with the typed manifest" is checked by object presence, because no migration ledger exists; the
  runbook says so rather than inventing a checksum check.
- The Phase 7 brief's "metric (A2)" item is not in the repository; brief item 7 below reconstructs it as the
  expansion-gate thresholds. The owner corrects it if it meant something else.
- `docs/runbooks/extraction-worker.md` is left as is (historical for its local-runtime parts); rewriting it is out of
  8.1 scope.
- Owner permission for read-only prod SSH: given in chat 2026-11-14.

## Decision brief (Phase 8)

```
🟠 Decisions from you — 8 pcs · vacancy Phase 8 · PR <this PR>
Runbook, measurement log and human-only entries are finished; activation waits on these.
Still running: nothing.

❓ 1 — Production schema drift: apply the 6 missing staged DDL files now
   Production lacks the objects of six files in manual-staged/ (run metrics + slowdown_level,
   health events table, two dirty-work partial indexes, inventory uniqueness index, model-health
   tables). The health check fails every 10 min; by the code, the 05:00 DOU run and /admin/sources
   fail too. job_postings has 0 rows. Backlog 434.
➡️ I recommend: one PR now — Coder + DevOps wire the six files as deploy.yml steps, security-review
   for the health-events privilege class (append-only, not class B) — it fixes a live failure.
🔒 Irreversible (prod DDL). Without an answer I do not move.

❓ 2 — First activation wave: when
   Wave 1 = DOU bridge + Greenhouse/Lever/Ashby + Arbeitnow. Needs item 1, MP-05 and MP-02 first.
➡️ I recommend: not now; after item 1 is deployed and a day of clean logs, I bring a wave-1 go/no-go.
🔒 Irreversible (outward requests to job sites, data into the HR queue). Without an answer I do not move.

❓ 3 — Senior availability field (migration)
   The E2E sub-case "availability changes while the card is open" was deferred: no such field exists.
➡️ I recommend: defer past wave 1; there is no product need until HR uses the new queue.
🔒 Irreversible (schema). Without an answer I do not move on it; nothing else waits on it.

❓ 4 — Backlog 425: triage grant policy version is a client stamp
   The grant stores whatever version the client sends; membership changes do not invalidate it.
➡️ I recommend: server-side versioning (migration + 409 on stale) before wave step 4 (limited HR
   teams), not now — RBAC, so the safe side.
🔒 Irreversible (RBAC contract). Without an answer I do not move on it.

❓ 5 — Backlog 426: a re-grant dead-ends; server trusts the client for triage-only
➡️ I recommend: a distinct 409 JOB_QUEUE_TRIAGE_ALREADY_GRANTED (dialog says until when),
   a server-side triage-eligibility check, a 90-day ceiling.
🔒 RBAC (server-side eligibility) — A3, not decided by silence.

❓ 6 — Backlog 433: 403 burst after a session switch
➡️ I recommend: refetch only after navigation settles; one small web PR together with backlog 427.
🔓 Reversible · ⏱ silence until 2026-11-17 18:00 → I take the recommendation, rollback = one PR

❓ 7 — Expansion-gate metric thresholds (MP-08), frozen before validation
➡️ I recommend: precision@10 ≥ 0.7, 0 false merges on labelled pairs, relevance false-negative
   rate ≤ 10 %, triage share ≤ 30 % — frozen in runbook §11.1 before the corpus is labelled.
🔓 Reversible · ⏱ silence until 2026-11-17 18:00 → I take the recommendation, rollback = edit §11.1

❓ 8 — Dev seed creates no job_sources rows
   Locally /admin/sources is empty unless an E2E seeds its own rows.
➡️ I recommend: the dev seed inserts the generated manifest rows, all disabled.
🔓 Reversible · ⏱ silence until 2026-11-17 18:00 → I take the recommendation, rollback = one PR
```

## Owner answers (chat, 2026-11-14)

- Item 1: build, merge when every required review passes on the current head (prod DDL approved) — PR #1333.
- Item 3: build now — branch `feat/senior-availability`.
- Items 4, 5: build (RBAC, security review) — PR #1332.
- Item 6 (433 + 427): build — PR #1334.
- Items 2, 7, 8: open; item 2 stays "not now" until item 1 is deployed.
