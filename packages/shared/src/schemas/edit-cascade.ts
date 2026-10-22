/**
 * task-cascade-resolver-preview (task 2 of the paid-transaction-edit-cascade
 * decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
 * AC4 "один резолвер, две обёртки"). This module is the SINGLE description of
 * "what happens to a source income's derivatives when its amount is edited" —
 * `GET /transactions/:id/edit-preview` (this task) and the future
 * `PATCH /transactions/:id` (task 3, under a `SELECT … FOR UPDATE` lock) both
 * call `resolveEditCascade` on a snapshot built by the SAME
 * `loadCascadeSnapshot` query shape. Neither wrapper is allowed to carry its
 * own copy of this arithmetic — see the ADR section for the full argument,
 * and `roundShareAmount` (packages/shared/src/utils/money.ts) for the
 * precedent this repeats one layer up.
 *
 * Everything below is a PURE function: no DB, no network, no `Date.now()`.
 * Same input ⇒ byte-for-byte same output (AC1 of the task file).
 */

export * from './edit-cascade/types'
export * from './edit-cascade/schemas'
export * from './edit-cascade/compute'
