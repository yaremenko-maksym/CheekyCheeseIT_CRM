/**
 * Visibility SQL builders for DocumentsService (L6 leaf extraction, behavior-preserving MOVE).
 * Free functions over explicit (db, hrAccess) arguments — no DI edge. Bodies are verbatim
 * from DocumentsService; they encode owner RBAC visibility decisions (2026-08-01/08-03),
 * first-match branch order MUST NOT change.
 */
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm'
import type { DocumentListFilters, SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import type { HrAccessService } from '../common/hr-access.service'
import { documents } from '../database/schema'
import { getHrSeniorIds, getTeammateIds } from './document-scope.util'

/**
 * Build the WHERE clause for `list()`. Returns 'NONE' if the caller has
 * no access to anything matching the filters (so we can short-circuit to
 * `[]` without a query).
 *
 * Visibility (from pm-brief.md "RBAC матрица для GET", team-scoping per
 * task-file-storage-hardening §1 / owner decision 2026-08-01, corrected
 * per security-review round 1 (HIGH-1) and round 2 (owner
 * decision 2026-08-03) — see `docs/business/modules/documents.md` for the
 * authoritative matrix):
 *   ADMIN: any category, any ownerId
 *   SENIOR: resume/scan — TEAM + PROJECT (active team_members overlap
 *       PLUS JUNIORs on the viewer's own projects — see getTeammateIds
 *       for why team_members alone excludes every JUNIOR); contract/
 *       receipt own; avatar own; logo all (read)
 *   JUNIOR: resume/scan own; avatar own; nothing else
 *   HR: resume/scan — TEAM + PROJECT (same predicate as SENIOR, see
 *       above); contract — for seniors in HR's teams; avatar own; logo
 *       all (read); receipt none
 */
export async function buildListWhere(
  db: DatabaseService,
  hrAccess: HrAccessService,
  actor: SessionUser,
  filters: DocumentListFilters,
): Promise<SQL | 'NONE'> {
  const conditions: SQL[] = []

  // ---- Soft-delete filter ----
  if (filters.includeDeleted && actor.role === 'ADMIN') {
    // No filter — return both active and deleted
  } else {
    conditions.push(isNull(documents.deletedAt))
  }

  // ---- Project filter (caller can ask for one project) ----
  if (filters.projectId) {
    conditions.push(eq(documents.projectId, filters.projectId))
  }

  // ---- Category filter ----
  // Default behavior: hide internal categories (AVATAR, LOGO) unless an
  // ADMIN explicitly requests them. INVOICE is system-generated but is
  // now exposed as a regular tab in /crm/documents (read-only — uploads
  // still go through InvoicesService), so it's part of the default set.
  if (filters.category) {
    // Caller asked for a specific category — RBAC check below decides
    // whether they're allowed to see it.
    conditions.push(eq(documents.category, filters.category))
  } else {
    // No explicit category → exclude internals (AVATAR/LOGO)
    conditions.push(
      // not in (AVATAR, LOGO)
      // Drizzle: use `notInArray` would be cleaner, but `notInArray` exists
      // in newer drizzle versions; we use a NOT IN via SQL fallback below.
      // For consistency with the rest of the codebase, use inArray + NOT
      // via an explicit OR of equality with non-internal categories.
      inArray(documents.category, ['RESUME', 'SCAN', 'CONTRACT', 'RECEIPT', 'INVOICE']),
    )
  }

  // ---- Per-role visibility ----
  const visibility = await buildVisibilityClause(db, hrAccess, actor, filters)
  if (visibility === 'NONE') return 'NONE'
  if (visibility !== null) conditions.push(visibility)

  // ---- Owner filter from caller (further narrow) ----
  if (filters.ownerId) {
    conditions.push(eq(documents.ownerId, filters.ownerId))
  }

  // `conditions` is never empty: the category filter above always pushes one.
  // drizzle's and(x) renders byte-identical SQL to x, so no single-element special case.
  return and(...conditions)!
}

/**
 * Returns a SQL clause for "what categories + ownerIds this user can see"
 * or 'NONE' if the user has zero visibility for the requested filter.
 */
export async function buildVisibilityClause(
  db: DatabaseService,
  hrAccess: HrAccessService,
  actor: SessionUser,
  filters: DocumentListFilters,
): Promise<SQL | null | 'NONE'> {
  const category = filters.category

  // ADMIN can see anything. internal-include toggle handled in buildListWhere.
  if (actor.role === 'ADMIN') {
    // ADMIN-only: includeInternal — currently controlled by `category`
    // filter (if ADMIN asks for AVATAR/LOGO they get them).
    return null
  }

  // Non-ADMIN trying to use the includeDeleted flag → silently ignored
  // (the soft-delete filter already added isNull above).

  // Build a set of (category, ownerScope) tuples the actor is allowed to see.
  const visibleClauses: SQL[] = []

  // task-file-storage-hardening §1: SENIOR/HR resume+scan visibility is
  // TEAM-and-PROJECT-SCOPED (security-review round 1 HIGH-1 fix — see
  // getTeammateIds' own doc for why team_members alone is wrong), resolved
  // once since both categories share the same scoped-id set.
  const teammateIds =
    actor.role === 'SENIOR' || actor.role === 'HR'
      ? await getTeammateIds(db, hrAccess, actor.id, actor.role)
      : null

  if (!category || category === 'RESUME') {
    if (teammateIds) {
      visibleClauses.push(
        and(eq(documents.category, 'RESUME'), inArray(documents.ownerId, teammateIds))!,
      )
    } else if (actor.role === 'JUNIOR') {
      visibleClauses.push(and(eq(documents.category, 'RESUME'), eq(documents.ownerId, actor.id))!)
    }
  }

  if (!category || category === 'SCAN') {
    if (teammateIds) {
      visibleClauses.push(
        and(eq(documents.category, 'SCAN'), inArray(documents.ownerId, teammateIds))!,
      )
    } else if (actor.role === 'JUNIOR') {
      visibleClauses.push(and(eq(documents.category, 'SCAN'), eq(documents.ownerId, actor.id))!)
    }
  }

  // DROP: self-scope for RESUME and SCAN (DROP uploads RESUME/SCAN like JUNIOR self).
  // Security: ownerId is already forced to actor.id by the `list()` caller via
  // effectiveFilters, so this clause adds the category filter to the visibility set.
  // The JUNIOR self-visibility branches above don't handle DROP — explicit branch here.
  if (actor.role === 'DROP') {
    if (!category || category === 'RESUME') {
      visibleClauses.push(and(eq(documents.category, 'RESUME'), eq(documents.ownerId, actor.id))!)
    }
    if (!category || category === 'SCAN') {
      visibleClauses.push(and(eq(documents.category, 'SCAN'), eq(documents.ownerId, actor.id))!)
    }
  }

  if (!category || category === 'CONTRACT') {
    if (actor.role === 'SENIOR') {
      visibleClauses.push(and(eq(documents.category, 'CONTRACT'), eq(documents.ownerId, actor.id))!)
    } else if (actor.role === 'HR') {
      const seniorIds = await getHrSeniorIds(db, actor.id)
      if (seniorIds.length > 0) {
        visibleClauses.push(
          and(eq(documents.category, 'CONTRACT'), inArray(documents.ownerId, seniorIds))!,
        )
      }
    } else if (actor.role === 'DROP') {
      // DROP can see their own uploaded CONTRACT documents (RESUME/SCAN/CONTRACT allowed per spec).
      visibleClauses.push(and(eq(documents.category, 'CONTRACT'), eq(documents.ownerId, actor.id))!)
    }
    // JUNIOR see no contracts
  }

  if (!category || category === 'RECEIPT') {
    if (actor.role === 'SENIOR') {
      visibleClauses.push(and(eq(documents.category, 'RECEIPT'), eq(documents.ownerId, actor.id))!)
    }
    // HR/JUNIOR/DROP see no receipts
  }

  if (!category || category === 'AVATAR') {
    // Every authenticated user can see their own avatar row (useful for
    // managing the override). ADMIN already returned above.
    visibleClauses.push(and(eq(documents.category, 'AVATAR'), eq(documents.ownerId, actor.id))!)
  }

  if (!category || category === 'LOGO') {
    // LOGO is readable for ADMIN/HR/SENIOR (all). ADMIN handled above.
    if (actor.role === 'HR' || actor.role === 'SENIOR') {
      visibleClauses.push(eq(documents.category, 'LOGO'))
    }
  }

  if (!category || category === 'INVOICE') {
    // INVOICE documents are produced by InvoicesService — the row's
    // `ownerId` is the counterparty (SENIOR / JUNIOR), so visibility is
    // scoped to `documents.ownerId == viewer.id` for non-admins.
    // ADMIN handled above; every other role sees only the invoices it is
    // the counterparty for.
    visibleClauses.push(and(eq(documents.category, 'INVOICE'), eq(documents.ownerId, actor.id))!)
  }

  if (visibleClauses.length === 0) return 'NONE'
  // drizzle's or(x) renders byte-identical SQL to x, so no single-element special case.
  return or(...visibleClauses)!
}
