# ADR: DOU bridge under run ownership — durable legacy delivery (r5 Task 4.6, slice S6)

## Status

**Proposed (2026-10-31).** Docs only: no code, no DDL applied. Every DDL in this file is a
**sketch** and needs an explicit owner **A3 go** before it ships to production.

## Decisions (summary)

- D-1 — DOU acquires a run handle through a new ledger entry point for LEGACY sources; budget stays
  `chargeBudget` on `job_sources`, written before the provider. _(section 1)_
- D-2 — A durable delivery table carries every posting of the complete provider array to the two
  legacy consumers; the consumer checkpoint is written in the same transaction as the consumer's
  effect. _(section 2)_
- D-3 — One new table, class A, staged first, promoted with the S0 deploy pattern. _(section 3)_
- D-4 — Flag `JOB_QUEUE_BRIDGE_ENABLED`, default off; the barrier runs off and on. _(section 4)_
- D-5 — Backfill is slice S7, separate. _(section 5)_
- D-6 — Slice plan S6a–S6g. _(section 6)_

## Context

_(pending)_

## 1. Run handle for DOU without changing the budget arithmetic

_(pending)_

## 2. The durable bridge

_(pending)_

## 3. DDL sketch (not applied — owner A3 go required)

_(pending)_

## 4. The compatibility barrier and the flag

_(pending)_

## 5. Backfill (slice S7)

_(pending)_

## 6. Slice plan

_(pending)_

## 7. Risks and owner questions

_(pending)_

## Consequences

_(pending)_

## Rollback

_(pending)_

## Sources

_(pending)_
