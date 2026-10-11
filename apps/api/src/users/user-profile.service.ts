import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { AuditChange, PendingSeniorShare } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { userEmails, type User } from '../database/schema'
import { ApprovalsService } from '../approvals/approvals.service'
import { TosService } from '../tos/tos.service'
import { AuditLogService, REDACTED_TOKEN } from './audit-log.service'
import {
  collectExposedRequisiteFields,
  computePendingSeniorShare,
  projectProfileUser,
} from './profile-view.util'
import { loadUserById } from './user-read.util'
import { UsersAccessService } from './users-access.service'

/** `approvals.subjectType` for base senior-share-change approvals. */
export const SENIOR_SHARE_SUBJECT_TYPE = 'USER_SENIOR_SHARE'

/**
 * Per-viewer masked profile read path (PII masking + the ACCOUNTANT
 * `requisites_read` audit). Reads users via `loadUserById` rather than
 * `UsersService`, so there is no dependency cycle.
 */
@Injectable()
export class UserProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly accessService: UsersAccessService,
    private readonly auditLogService: AuditLogService,
    private readonly tosService: TosService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * `actorImpersonatorId` (security-review round 2, authz-hardening):
   * `viewer` is a DB row (no `impersonatorId` — that field only ever lives
   * on the JWT), so unlike the other `SessionUser`-scoped fixes in this
   * file, correcting the `requisites_read` audit attribution below needs it
   * threaded in explicitly from the controller's `currentUser.impersonatorId`.
   * Optional — both real callers (getMe/getProfile in UsersController) pass
   * it; omitted call sites just fall back to `viewer.id` (unchanged
   * pre-fix behavior).
   */
  async buildProfileView(viewer: User, targetId: string, actorImpersonatorId?: string) {
    const target = await loadUserById(this.db.db, targetId)
    if (!target) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    const permissions = await this.accessService.getViewPermissions(viewer, target)

    // Empty tabs means the viewer has no access to this profile at all.
    // Mirror the guard pattern used in GET /:id/team — throw 403 before
    // leaking any user fields (displayName, email, phone, telegram, avatarUrl).
    // Rationale: isSelf always produces non-empty tabs; ADMIN always has tabs;
    // HR has tabs for users in their team; ACCOUNTANT has tabs for all.
    // The only case of empty tabs is e.g. SENIOR viewing a JUNIOR — Broken
    // Access Control (OWASP A01) if we return 200 + personal data here.
    if (permissions.tabs.length === 0) {
      throw new ForbiddenException()
    }

    // §4.4: personal address lives in user_emails, not on `target` — fetch
    // it only when the viewer may actually see it. security-review PR #623
    // (SR-M-4): gated on `fields.personalContact`, NOT `fields.realContacts`
    // — the two used to be the same flag, which meant HR (realContacts=true
    // for a teammate) could VIEW a personalEmail that HR is deliberately
    // barred from ever SETTING (UsersController.createUser forces it null
    // for an HR actor). Same sensitivity boundary now enforced in both
    // places — see users-access.service.ts's `personalContact` comment.
    const personalEmailRow = permissions.fields.personalContact
      ? await this.db.db.query.userEmails.findFirst({
          // Stryker disable next-line StringLiteral: `kind: 'PERSONAL'` is a literal inside a Drizzle query-builder `where` clause a plain vi.fn() mock cannot distinguish from `""` (mutation-gate-integration-specs.md) — the PERSONAL-vs-WORK distinction it encodes is exercised end-to-end against real Postgres by user-emails-uniqueness.integration.spec.ts, which asserts `personalRow?.kind === 'PERSONAL'` on an actual inserted row.
          where: and(eq(userEmails.userId, target.id), eq(userEmails.kind, 'PERSONAL')),
        })
      : undefined

    // task-648-fix-round-1 (QA-HIGH-1): gated on `fields.sharePending`, NOT
    // `fields.share` — the PENDING (unconfirmed) value is a narrower surface
    // than the active one (task file: "только ADMIN и сам синьор"; ACCOUNTANT
    // has `fields.share=true` for payroll need-to-know but must not learn a
    // change is even proposed). Only queried when that gate is open (avoids
    // the round-trip, and avoids leaking "something is pending" via
    // response-time side channel to a masked viewer).
    // The 'NONE' fallback below is used ONLY as input to the `=== 'PENDING'`
    // check two lines down — any non-'PENDING' string (including `""`) is
    // behaviorally identical at every call site `pendingSeniorShareStatus`
    // has, so it is genuinely unobservable by a black-box test (same class
    // as the `kind: 'PERSONAL'` precedent a few lines above this one). The
    // directive below MUST stay on the line directly above `'NONE'` itself
    // (not above this `const`) — a `// Stryker disable next-line` comment
    // attaches to the mutated node's own line, and for a ternary's second
    // branch that is THIS line, not the statement's opening line (see
    // env.ts's GIT_COMMIT_REGEX_MESSAGE comment for the same lesson).
    const pendingSeniorShareStatus = permissions.fields.sharePending
      ? await this.approvals.getStatus(SENIOR_SHARE_SUBJECT_TYPE, target.id)
      : // Stryker disable next-line StringLiteral: see the comment above this statement.
        'NONE'
    const pendingSeniorShare: PendingSeniorShare | null = computePendingSeniorShare(
      target,
      pendingSeniorShareStatus,
    )

    const filteredUser = projectProfileUser(
      target,
      permissions,
      personalEmailRow,
      pendingSeniorShare,
    )

    const data: Record<string, unknown> = {}
    if (permissions.tabs.includes('overview')) {
      // ToS acceptance — visible to ADMIN or self (except JUNIOR self: data-privacy,
      // task-junior-ut-round3 §6b). JUNIOR sees their own overview tab but does NOT
      // get tosAcceptedAt/tosVersion — the onboarding flow already gated them before
      // reaching the hub, so the date is irrelevant and leaks internal audit info.
      const canSeeTos =
        viewer.role === 'ADMIN' || (viewer.id === target.id && viewer.role !== 'JUNIOR')
      const tosAcceptance = canSeeTos
        ? await this.tosService.getLatestAcceptanceForUser(target.id)
        : null

      data.overview = {
        techStack: permissions.fields.techStack ? (target.techStack ?? []) : null,
        // adminNote — gated by the same permission flag as filteredUser.adminNote
        // (ADMIN viewing another user; never self). Keeps both surfaces consistent.
        adminNote: permissions.fields.adminNote ? (target.adminNote ?? null) : null,
        tosAcceptedAt: tosAcceptance?.acceptedAt.toISOString() ?? null,
        tosVersion: tosAcceptance?.tosVersion ?? null,
      }
    }
    // Other tabs (finance, projects, team, interviews, requisites) — wired in later tasks

    // Pre-deploy MEDIUM: read-access audit for the ACCOUNTANT requisites scope.
    // The base audit log only tracked *writes*; an ACCOUNTANT can read the
    // payout requisites (RNOKPP / IBAN / wallet) of any user company-wide for
    // payroll. Record a `requisites_read` event when an accountant (never self)
    // actually receives requisites, so the read is attributable. Values are NOT
    // logged (it is a read of existing data, not a change) — `changes` records
    // only WHICH fields were exposed, with redacted markers, mirroring how the
    // write-audit redacts SENSITIVE_FIELDS.
    if (viewer.role === 'ACCOUNTANT' && viewer.id !== target.id && permissions.fields.requisites) {
      const exposedFields = collectExposedRequisiteFields(filteredUser)
      if (exposedFields.length > 0) {
        const changes: Record<string, AuditChange> = {}
        for (const f of exposedFields) {
          // Read-audit: record THAT the field was read, never its plaintext value.
          changes[f] = { before: REDACTED_TOKEN, after: REDACTED_TOKEN }
        }
        await this.auditLogService.record({
          actorId: actorImpersonatorId ?? viewer.id,
          targetId: target.id,
          action: 'requisites_read',
          changes,
        })
      }
    }

    return { user: filteredUser, permissions, data }
  }
}
