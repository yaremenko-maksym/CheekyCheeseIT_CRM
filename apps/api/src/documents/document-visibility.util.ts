/**
 * Visibility SQL builders for DocumentsService (L6 leaf extraction, behavior-preserving MOVE).
 * Free functions over explicit (db, hrAccess) arguments — no DI edge. Bodies are verbatim
 * from DocumentsService; they encode owner RBAC visibility decisions (2026-08-01/08-03),
 * first-match branch order MUST NOT change.
 */
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm'
import type { DocumentCategory, DocumentListFilters, Role, SessionUser } from '@crm/shared'
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
 * per security-review round 1 (HIGH-1) and round 2 (ACCOUNTANT, owner
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
 *   ACCOUNTANT: scan ALL, unconditionally — owner decision 2026-08-03
 *       (round-1's transaction-scoped attempt was rejected: self-
 *       satisfying + broke onboarding, see the SCAN branch below for the
 *       full rationale); receipt all (read); avatar own;
 *       resume/contract/logo none
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

  // Stryker disable next-line ConditionalExpression: unreachable branch (verbatim move) — the category filter above always pushes a condition, so conditions is never empty
  if (conditions.length === 0) {
    // No conditions = match everything. Returning `undefined` would let
    // drizzle return all rows; explicit `isNotNull(id)` keeps types happy.
    return isNotNull(documents.id)
  }
  // Stryker disable next-line ConditionalExpression: equivalent mutant — drizzle and(x) renders byte-identical SQL to x (verified via PgDialect: all three of x, and(x), or(x) render `"t"."a" = $1`)
  if (conditions.length === 1) return conditions[0]!
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
    } else if (canSeeSelf(actor.role, 'RESUME')) {
      visibleClauses.push(and(eq(documents.category, 'RESUME'), eq(documents.ownerId, actor.id))!)
    }
  }

  if (!category || category === 'SCAN') {
    if (teammateIds) {
      visibleClauses.push(
        and(eq(documents.category, 'SCAN'), inArray(documents.ownerId, teammateIds))!,
      )
    } else if (actor.role === 'ACCOUNTANT') {
      // task-file-storage-hardening — OWNER DECISION 2026-08-03 (security-
      // review round 2, reversing the round-1 MED-1 "transaction-scoped"
      // attempt): ACCOUNTANT sees ALL scans, unconditionally. The
      // transaction-EXISTS scope tried in round 1 was rejected for two
      // independent reasons, either one fatal on its own:
      //   1. Self-satisfying: ACCOUNTANT is the role that CREATES/
      //      validates transactions — they can unlock their own access to
      //      any scan by creating one transaction naming that person, so
      //      the "restriction" was not actually a restriction.
      //   2. Broke onboarding in practice: live data at review time showed
      //      transactions exist for only 5 of 21 people; HR and DROP users
      //      have ZERO — an ACCOUNTANT verifying a brand-new hire's scan
      //      before any money has moved would 404 on exactly the case that
      //      matters most.
      // Kept broad on the strength of: ACCOUNTANT is a read-only audit
      // role (cannot upload RESUME/SCAN at all, see assertCanUpload), and
      // every access is now recorded in document_access_log (§7) — the
      // accountability the task needed comes from the log, not from
      // narrowing the read.
      visibleClauses.push(eq(documents.category, 'SCAN'))
    } else if (canSeeSelf(actor.role, 'SCAN')) {
      visibleClauses.push(and(eq(documents.category, 'SCAN'), eq(documents.ownerId, actor.id))!)
    }
  }

  // DROP: self-scope for RESUME and SCAN (DROP uploads RESUME/SCAN like JUNIOR self).
  // Security: ownerId is already forced to actor.id by the `list()` caller via
  // effectiveFilters, so this clause adds the category filter to the visibility set.
  // The canSeeSelf helper doesn't handle DROP — explicit branch here.
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
    // JUNIOR/ACCOUNTANT see no contracts
  }

  if (!category || category === 'RECEIPT') {
    if (actor.role === 'ACCOUNTANT') {
      visibleClauses.push(eq(documents.category, 'RECEIPT'))
    } else if (actor.role === 'SENIOR') {
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
    // ACCOUNTANT is allowed to see ALL invoices (finance audit role,
    // same scope as RECEIPT). ADMIN handled above. JUNIOR/HR/SENIOR
    // only see invoices they themselves are the counterparty for.
    if (actor.role === 'ACCOUNTANT') {
      visibleClauses.push(eq(documents.category, 'INVOICE'))
    } else {
      visibleClauses.push(and(eq(documents.category, 'INVOICE'), eq(documents.ownerId, actor.id))!)
    }
  }

  if (visibleClauses.length === 0) return 'NONE'
  // Stryker disable next-line ConditionalExpression: equivalent mutant — drizzle or(x) renders byte-identical SQL to x (verified via PgDialect: x, and(x), or(x) all render the same)
  if (visibleClauses.length === 1) return visibleClauses[0]!
  return or(...visibleClauses)!
}

function canSeeSelf(role: Role, category: DocumentCategory): boolean {
  // Stryker disable next-line ConditionalExpression: equivalent mutant — the only call sites pass RESUME or SCAN, so the category guard is always true (verbatim move, kept for the helper's contract)
  if (category === 'RESUME' || category === 'SCAN') return role === 'JUNIOR'
  return false
}
