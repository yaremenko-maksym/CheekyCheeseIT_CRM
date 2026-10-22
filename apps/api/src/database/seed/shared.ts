import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../schema'

/** The drizzle handle every seed phase writes through. */
export type SeedDb = NodePgDatabase<typeof schema>

/**
 * Explicit context threaded through the seed phases. `db` is the single open
 * connection; ids created by an earlier phase that a later phase needs are
 * returned by that phase and merged into the context by seed.ts `main()`.
 */
export interface SeedCtx {
  db: SeedDb
}

/** Ids of the projects whose transactions the finance phase seeds. */
export interface SeedProjectIds {
  proj1Id: string
  proj2Id: string
  proj4Id: string
  proj6Id: string
}

/** Context handed to phases that run after the projects phase. */
export interface SeedCtxWithProjects extends SeedCtx {
  projects: SeedProjectIds
}

// ---------------------------------------------------------------------------
// Date helpers — 12-month window: 2025-06-05 → 2026-06-04
// ---------------------------------------------------------------------------
export function d(year: number, month: number, day: number, hour = 10): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0))
}
