import type { JobSourceType } from '@crm/shared'

/**
 * The bounded collection window of one daily handler (r5 Task 2.5 T5; ADR 2026-10-24-job-source-run-ownership.md, T5).
 *
 * SKELETON (wip): the loop is filled in by the commits that follow. The contract it will honour:
 *  - `recoverExpired` on EVERY iteration (SR-M-19), each step in its own try/catch;
 *  - claims for `types` only, up to the worker's free slots, then a bounded wait;
 *  - ends when nothing is claimable and nothing runs, or at `windowMs` after start, whichever is first;
 *  - closes the cycle (`closed_at`) at the end (SR-L-19); never rethrows.
 */
export interface CollectionWindowInput {
  readonly cycleId: string
  readonly types: readonly JobSourceType[]
  readonly windowMs: number
  readonly intervalMs: number
}

export async function runCollectionWindow(_input: CollectionWindowInput): Promise<void> {
  throw new Error('runCollectionWindow: not implemented')
}
