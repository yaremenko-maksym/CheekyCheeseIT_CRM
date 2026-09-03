import { z } from 'zod'

export const IT_DOMAINS = [
  'AI / ML',
  'FinTech',
  'EdTech',
  'E-Commerce',
  'HealthTech',
  'SaaS',
  'DevTools',
  'Cybersecurity',
  'Web3 / Crypto',
  'GameDev',
  'AdTech',
  'HRTech',
  'LegalTech',
  'PropTech',
  'Logistics',
  'Social Media',
  'Data & Analytics',
  'Cloud Infrastructure',
  'Embedded / IoT',
  'Gambling',
  'Adult',
  'Other',
] as const

export type ItDomain = (typeof IT_DOMAINS)[number]
export const itDomainSchema = z.enum(IT_DOMAINS)

export const projectMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  /** Avatar fallback URL (Google / dicebear). Renamed from `avatar` in 0013. */
  avatarUrl: z.string().url().nullable(),
  /** FK → documents.id for AVATAR uploads (null when user uses fallback). */
  avatarDocumentId: z.string().uuid().nullable(),
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
  joinedAt: z.string().datetime(),
  leftAt: z.string().datetime().nullable(),
})

export const currencySchema = z.enum(['USDT', 'USD', 'EUR', 'UAH'])

/**
 * task-project-draft-status. Project lifecycle status — separate axis from
 * `archivedAt` (see schema.ts's own comment on the `projects.status` column
 * for why the two must never be merged). A project starts `DRAFT`, becomes
 * `ACTIVE` once every invited approver (the project's senior + drop, if any
 * — see `approvals`, subjectType `PROJECT`) confirms, or `REJECTED` if any
 * one of them declines. Only `ACTIVE` + non-archived projects are visible
 * outside the narrow admin/approver path (see `visible_projects` view) and
 * only `ACTIVE` projects accept transactions.
 */
export const PROJECT_STATUSES = ['DRAFT', 'ACTIVE', 'REJECTED'] as const
export const projectStatusSchema = z.enum(PROJECT_STATUSES)
export type ProjectStatus = z.infer<typeof projectStatusSchema>

/**
 * task-drop-share-override-and-receiver (Part B / D1). Project payment type —
 * migrated from a free-text `varchar(100)` to a fixed enum. Drives the income
 * declaration gate: FOP/GIG projects let SENIOR/DROP declare their own income;
 * USDT projects only let ADMIN declare (with a receiver), and the company books
 * obligations to senior/drop. UI labels are Ukrainian: FOP→'ФОП',
 * GIG_CONTRACT→'гіг-контракт', USDT→'USDT'.
 *
 * Field-scoped RBAC: only ADMIN/ACCOUNTANT may set it (service throws
 * ForbiddenException for HR/SENIOR/JUNIOR) — same pattern as
 * seniorSharePercentOverride. Masked to `null` for JUNIOR viewers (Q5).
 */
export const PROJECT_PAYMENT_TYPES = ['FOP', 'GIG_CONTRACT', 'USDT'] as const
export const projectPaymentTypeSchema = z.enum(PROJECT_PAYMENT_TYPES)
export type ProjectPaymentType = z.infer<typeof projectPaymentTypeSchema>

/**
 * Review round 1 (LOW-1): a non-type-predicate `.refine()` — this enforces
 * EXACT membership in `PROJECT_PAYMENT_TYPES` at RUNTIME (an invalid value
 * fails Zod parse → 400 via the global ZodExceptionFilter, same guarantee as
 * `projectPaymentTypeSchema` itself) while the Zod-inferred TYPE stays plain
 * `string` (Zod only narrows the inferred type when the refine callback is a
 * type predicate `(v): v is X => ...`; a boolean-returning callback does not).
 * Used at the create/update WRITE boundary so `createProjectSchema` /
 * `updateProjectSchema` reject a bad payload at the controller Zod-parse layer
 * (shift-left vs. the service's `projectPaymentTypeSchema.parse` call) WITHOUT
 * narrowing the field's TS type to the 3-member union — the frontend Select
 * landed (PR #367, Surface C), but the create/edit form values and DTO fields
 * in `apps/web` still flow as plain `string`, so narrowing the type here would
 * red the monorepo typecheck. Delete this helper (and switch both fields to
 * `projectPaymentTypeSchema` directly) once the web form/DTO types are
 * narrowed to the union end-to-end.
 */
const paymentTypeStringSchema = z
  .string()
  .max(100)
  .refine((v) => (PROJECT_PAYMENT_TYPES as readonly string[]).includes(v), {
    message: `Payment type must be one of: ${PROJECT_PAYMENT_TYPES.join(', ')}`,
  })

/**
 * Refinement enforcing XOR between the two logo columns (mirrors the
 * `chk_logo_xor` DB CHECK constraint). Both null is allowed (no logo).
 */
function refineLogoXor(
  data: { logoDocumentId?: string | null | undefined; logoExternalUrl?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (data.logoDocumentId && data.logoExternalUrl) {
    ctx.addIssue({
      code: 'custom',
      message: 'Только один из logoDocumentId / logoExternalUrl может быть задан',
      path: ['logoExternalUrl'],
    })
  }
}

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  companyName: z.string(),
  domain: itDomainSchema,
  /** FK → documents.id for LOGO uploads (S3-backed). XOR with logoExternalUrl. */
  logoDocumentId: z.string().uuid().nullable(),
  /** External logo URL (e.g. https://company.com/logo.svg). XOR with logoDocumentId. */
  logoExternalUrl: z.string().url().nullable(),
  startDate: z.string().datetime(),
  /**
   * Masked to `null` for JUNIOR viewers (identity data-hiding, RBAC A01).
   * Non-null for all other roles.
   */
  seniorId: z.string().uuid().nullable(),
  /**
   * Masked to `null` for JUNIOR viewers (identity data-hiding, RBAC A01).
   * Non-null for all other roles.
   */
  seniorName: z.string().nullable(),
  /**
   * Legend persona role visible to JUNIOR viewers.
   * When a legend exists for this project, JUNIOR receives `legends.presentedRole`
   * here instead of the real senior's role/title. Non-JUNIOR viewers receive `null`
   * (they see the real identity via seniorId/seniorName, not the persona).
   * `null` when no legend or not a JUNIOR viewer.
   */
  seniorPresentedRole: z.string().nullable().optional(),
  /**
   * Drop-only: when set, the project's income flows through the DROP user
   * and the finance distribution includes the drop's share (Phase 2).
   * `null` = legacy senior-project (no drop) — finance behavior unchanged.
   */
  dropId: z.string().uuid().nullable(),
  /**
   * Drop role - phase 2. Display name of the DROP user. `null` when the
   * project has no drop (regular senior-project). Computed on the backend
   * from the joined users row so the UI can render «Drop-проект» badge +
   * effective team without a separate fetch.
   */
  dropName: z.string().nullable(),
  /**
   * Drop role - phase 2. Snapshot of the DROP user's
   * `users.dropSharePercent` at read time. Used by the distribution
   * breakdown panel («Доля дропа N%»). `null` for senior-only projects.
   */
  dropSharePercent: z.number().int().min(0).max(100).nullable(),
  /**
   * task-drop-share-override-and-receiver (Part A). Per-project DROP share %
   * override (0-100). NULL = use the drop's global default. Editable only by
   * ADMIN/ACCOUNTANT. Null for senior-only projects / JUNIOR viewers.
   */
  dropSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
  /**
   * Computed on the backend: the drop's global default
   * (`users.dropSharePercent` → 5). UI hint when the override is null. Null
   * for senior-only projects / JUNIOR viewers.
   */
  dropSharePercentDefault: z.number().int().min(0).max(100).nullable().optional(),
  /**
   * The effective DROP share % that WOULD apply to a new DROP_INCOME on this
   * project — resolved by the same `resolveDropShare` used by the snapshot
   * path (project override → user default → 5). Null for senior-only projects
   * / JUNIOR viewers.
   */
  effectiveDropSharePercent: z.number().int().min(0).max(100).nullable().optional(),
  /**
   * Where `effectiveDropSharePercent` came from — 'PROJECT' | 'USER_DEFAULT'
   * (no team level for the drop). Null when the field above is null.
   */
  effectiveDropShareSource: z.enum(['PROJECT', 'USER_DEFAULT']).nullable().optional(),
  /**
   * Masked to `null` for JUNIOR viewers (finance data-hiding, RBAC A01).
   * Non-null for all other roles (ADMIN / SENIOR / HR / ACCOUNTANT).
   */
  rate: z.number().nullable(),
  /**
   * Masked to `null` for JUNIOR viewers (finance data-hiding, RBAC A01).
   * Non-null for all other roles.
   */
  currency: currencySchema.nullable(),
  // Per-project SENIOR share % override (0-100). NULL = use senior's
  // global default (see `seniorSharePercentDefault` below). Editable only
  // by ADMIN and ACCOUNTANT (enforced in projects.service.ts).
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable(),
  // Computed on the backend: snapshot of `users.seniorSharePercent` for the
  // project's senior. Used by the UI as a hint ("default X%") when the
  // override is null. Not persisted on the project row.
  seniorSharePercentDefault: z.number().int().min(0).max(100),
  /**
   * task-team-senior-share-override. The effective share % that *would*
   * apply to a new SENIOR_INCOME on this project — pre-computed by the
   * backend using the same resolver as the snapshot path. Lets
   * MyProjectShares / project detail render the source badge without a
   * separate fetch (which would otherwise need the senior's team list).
   * `null` only on rows where the senior is unknown.
   */
  effectiveSeniorSharePercent: z.number().int().min(0).max(100).nullable().optional(),
  /**
   * task-team-senior-share-override. Where `effectiveSeniorSharePercent`
   * came from. `null` when the field above is null.
   */
  effectiveSeniorShareSource: z.enum(['PROJECT', 'TEAM', 'USER_DEFAULT']).nullable().optional(),
  members: z.array(projectMemberSchema),
  techStack: z.string().nullable(),
  teamSize: z.string().nullable(),
  benefits: z.string().nullable(),
  /**
   * task-drop-share-override-and-receiver (D1). Project payment type enum.
   * Non-null for all roles EXCEPT JUNIOR, who receives `null` (Q5 masking).
   */
  paymentType: projectPaymentTypeSchema.nullable(),
  salaryReview: z.string().nullable(),
  corpTech: z.string().nullable(),
  notesGeneral: z.string().nullable(),
  /**
   * task-project-draft-status. `DRAFT` until every invited approver
   * confirms, `ACTIVE` once confirmed, `REJECTED` if any one declines.
   * Only ADMIN and the invited approvers ever receive a non-`ACTIVE` row —
   * everyone else's reads are served from `visible_projects`, which never
   * contains one.
   */
  status: projectStatusSchema,
  /**
   * task-project-status-filter-ui. The reason the live approval generation
   * was declined — read from `approvals.rejectionReason` on the row that
   * rejected (see `ApprovalsService.getRejectionReasons`'s own doc: a
   * REJECTED subject's live generation has exactly one live row). `null`
   * whenever `status !== 'REJECTED'`, or when the reason could not be
   * resolved (defensive — should not happen given the CHECK constraint on
   * `approvals.rejection_reason`). `.optional()` keeps older cached/mocked
   * responses (pre this field) parseable.
   */
  rejectionReason: z.string().nullable().optional(),
  /**
   * SPEC-M-2 (PR #646 fix-round 1). Whether the SENIOR / DROP specifically
   * still owes a decision — a live PENDING `approvals` row for that user
   * (see `ApprovalsService.getPendingApproverIds`). A project invites up to
   * two approvers (senior always, drop when assigned); once one of them
   * decides while the project waits on the other (business spec §4.1
   * partial agreement), the project stays `status: 'DRAFT'` but only ONE of
   * these stays true — the frontend caption ("от {синьор} и дропа" vs "от
   * {синьор}") is built from THESE, not from `dropId`'s mere presence on
   * the project, which the earlier version conflated with "still awaiting
   * the drop specifically". Booleans rather than a raw id array
   * deliberately: `seniorId`/`dropId` on this same DTO can be MASKED to
   * `null` for some viewers (admin-as-senior + non-privileged viewer — see
   * `mapProject`'s identity-masking block), so a frontend `.includes(id)`
   * check against a masked id would silently misreport; a boolean carries
   * no identity to mask and is computed server-side against the
   * project's REAL (pre-mask) senior/drop ids. Both `false` whenever
   * `status !== 'DRAFT'`, or when resolution fails (defensive — see
   * `getRejectionReasons`'s identical contract for the REJECTED sibling
   * field above). `.optional()` keeps older cached/mocked responses
   * (pre this field) parseable.
   */
  seniorApprovalPending: z.boolean().optional(),
  dropApprovalPending: z.boolean().optional(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

// Computed `effectiveTeam` returned by GET /projects/:id — see spec §5.2
// HR/Accountant pulled dynamically from senior's current team_members (not snapshot at archive).
//
// IMPORTANT: `effectiveTeam` is exposed on the DETAIL endpoint only (GET /projects/:id) —
// the list endpoint (GET /projects) returns the base `projectSchema` without this field.
// Frontend consumes the detail shape via `projectDetailSchema` / `ProjectDetailDto`.
export const effectiveTeamSchema = z.object({
  senior: z
    .object({
      id: z.string().uuid(),
      displayName: z.string(),
      email: z.string().email(),
      avatarUrl: z.string().url().nullable(),
      avatarDocumentId: z.string().uuid().nullable(),
      role: z.literal('SENIOR'),
      /**
       * task-admin-as-senior: when the project's senior is an ADMIN user,
       * non-privileged viewers (SENIOR/HR/DROP) must not navigate to the
       * admin's profile (it returns 403 for them). Backend sets this to
       * `false` for those viewers; ADMIN/ACCOUNTANT get `true`.
       * Defaults to `true` for regular SENIOR-projects (backward-compat).
       */
      profileNavigable: z.boolean().default(true),
    })
    .nullable(),
  /**
   * Drop role - phase 2. Drop user attached to the project (when
   * `project.dropId != null`). `null` for regular senior-projects. The
   * `dropSharePercent` snapshot is duplicated here so the FE can render
   * the distribution breakdown without a second fetch.
   */
  drop: z
    .object({
      id: z.string().uuid(),
      displayName: z.string(),
      email: z.string().email(),
      avatarUrl: z.string().url().nullable(),
      avatarDocumentId: z.string().uuid().nullable(),
      role: z.literal('DROP'),
      dropSharePercent: z.number().int().min(0).max(100),
    })
    .nullable()
    .optional(),
  hrs: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      displayName: z.string(),
      email: z.string().email(),
      avatarUrl: z.string().url().nullable(),
      avatarDocumentId: z.string().uuid().nullable(),
      role: z.literal('HR'),
    }),
  ),
  accountants: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string().uuid(),
      displayName: z.string(),
      email: z.string().email(),
      avatarUrl: z.string().url().nullable(),
      avatarDocumentId: z.string().uuid().nullable(),
      role: z.literal('ACCOUNTANT'),
    }),
  ),
  juniors: z.array(projectMemberSchema),
})

// Detail shape returned by `GET /projects/:id`. Extends the base `projectSchema`
// with the computed `effectiveTeam` view. Frontend uses this in detail-page routes
// and in any cascading action UI (admin actions, unarchive modals) where it needs
// the current HR/Accountant pair without a separate fetch.
export const projectDetailSchema = projectSchema.extend({
  effectiveTeam: effectiveTeamSchema.optional(),
})

// Action types for project audit log
export const projectAuditActionSchema = z.enum([
  'project_created',
  'project_edited',
  'project_archived',
  'project_unarchived',
  'project_member_added',
  'project_member_removed',
])

export const projectAuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  targetId: z.string().uuid(),
  action: projectAuditActionSchema,
  changes: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })),
  createdAt: z.coerce.date(),
})

export const projectAuditLogListSchema = z.object({
  entries: z.array(projectAuditLogEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})

// task-archive-pending-modal (AC2/AC8, backlog 129/89-MED-2, owner decision
// 2026-08-18/19). A PENDING transaction earned before archival stays in the
// system and stays payable — see `assertSalaryReceiverNotArchived`'s docblock
// in transactions.service.ts for the full "already earned vs not yet earned"
// distinction this modal exists to warn about. Scope matches AC1 exactly:
// the three accrual kinds that mint a `status='PENDING'` row addressed to a
// named person (SALARY / SENIOR_INCOME / DROP_INCOME) — NOT the
// `*_PENDING_PAYMENT` company-obligation rows (those were never blocked from
// archived receivers, see AC4, so they carry no "will this still get paid"
// anxiety this warning is meant to resolve).
export const archivePendingTransactionSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['SALARY', 'SENIOR_INCOME', 'DROP_INCOME']),
  // SALARY rows carry `salaryMonth` ('YYYY-MM'); SENIOR_INCOME/DROP_INCOME
  // carry a business `txDate` instead. Exactly one of the two is non-null.
  salaryMonth: z.string().nullable(),
  txDate: z.coerce.date().nullable(),
  amount: z.string(),
  currency: z.string(),
})
export type ArchivePendingTransaction = z.infer<typeof archivePendingTransactionSchema>

// Returned to UI to show warning before archive (cascade impact summary).
export const archiveImpactSchema = z.union([
  // User impact
  z.object({
    type: z.literal('user'),
    role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
    isPaired: z.boolean().optional(),
    teamName: z.string().nullable().optional(),
    teamsCount: z.number().int().nonnegative().optional(),
    projectsCount: z.number().int().nonnegative().optional(),
    // task-archive-pending-modal (AC8): named list of the active projects
    // that will be archived alongside a SENIOR/DROP — the count alone cannot
    // be "enumerated" in the modal's copy.
    projectNames: z.array(z.string()).optional(),
    // owner decision 2026-08-19 (AC9): these two counts NO LONGER mean "will
    // be removed" — HR/ACCOUNTANT/JUNIOR keep their membership through a
    // SENIOR/DROP cascade archive (only the team/projects themselves gain
    // `archivedAt`). Kept as "how many people are on the affected
    // team/projects" — still useful for the warning copy.
    // security-review PR #584 round 2 (code-review MED): `hrAccountantsOnTeam`
    // was originally shipped as `hrAccountantsToBeRemoved`, a name that
    // stopped matching reality the moment AC9 landed — nobody is removed
    // any more. Renamed (not just commented) across the schema, both
    // backend producers, and all three frontend consumers in the same PR —
    // the blast radius was small (11 files) and fully covered by tests, so
    // there was no reason to leave a misleading field name live in the API
    // contract. `juniorsAffected` was NOT renamed — not flagged by review,
    // out of scope for this pass.
    juniorsAffected: z.number().int().nonnegative().optional(),
    hrAccountantsOnTeam: z.number().int().nonnegative().optional(),
    noDependencies: z.boolean().optional(),
    // task-archive-pending-modal (AC2): earned-but-unpaid rows that will
    // stay in the system after this archive. Empty/absent ⇒ modal renders
    // its old (no-warning) shape.
    pendingTransactions: z.array(archivePendingTransactionSchema).optional(),
  }),
  // Team impact (alias for senior's pair OR drop-team standalone)
  z.object({
    type: z.literal('team'),
    isPaired: z.literal(true),
    teamName: z.string(),
    // For SENIOR teams — name of the senior; the confirm input expects this.
    // For DROP teams — name of the senior being detached (informational only;
    // the senior is NOT archived, just unbound). Use `dropName` for the
    // confirm input.
    seniorName: z.string(),
    projectsCount: z.number().int().nonnegative(),
    membersAffected: z.number().int().nonnegative(),
    // Drop-archive round 2 (B2): explicit team-type discriminator + drop
    // metadata. Optional so legacy senior-team responses parse unchanged.
    // `teamType` defaults to 'SENIOR' on the client when absent.
    teamType: z.enum(['SENIOR', 'DROP']).optional(),
    // Drop-team only: name of the drop user that owns this team. The
    // confirmation input asks for this name (not the senior's).
    dropName: z.string().optional(),
    // Drop-team only: true when an active senior is attached and will be
    // detached (not archived) by `archiveDropTeam`. Surfaces in the
    // confirmation dialog so admin knows the senior is released.
    seniorWillBeDetached: z.boolean().optional(),
    // task-archive-pending-modal (AC8): named list of the paired
    // senior's/drop's active projects, forwarded 1:1 from the user impact.
    projectNames: z.array(z.string()).optional(),
    // task-archive-pending-modal (AC2): the paired senior's/drop's own
    // pending transactions, forwarded 1:1 from `UsersService.getArchiveImpact`
    // — archiving the team IS archiving the senior/drop (they are one pair).
    pendingTransactions: z.array(archivePendingTransactionSchema).optional(),
  }),
  // Project impact (independent)
  z.object({
    type: z.literal('project'),
    activeMembersCount: z.number().int().nonnegative(),
  }),
])

// 409 body shape when project unarchive requires cascade (senior/team archived).
export const cascadeRequiredErrorSchema = z.object({
  requiresCascade: z.literal(true),
  entities: z.array(
    z.object({
      type: z.enum(['user', 'team']),
      id: z.string().uuid(),
      name: z.string(),
    }),
  ),
})

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(255),
    companyName: z.string().min(1).max(255),
    domain: itDomainSchema,
    logoDocumentId: z.string().uuid().nullable().optional(),
    logoExternalUrl: z.string().url().nullable().optional(),
    startDate: z.string().datetime(),
    seniorId: z.string().uuid(),
    /**
     * Drop role - phase 2. Optional DROP user reference. When set, the
     * project becomes a drop-project and income/payout flows through the
     * `computeDropDistribution` branch. When omitted/null, the project is
     * a regular senior-project with unchanged finance behavior.
     */
    dropId: z.string().uuid().nullable().optional(),
    rate: z.number().int().positive(),
    currency: currencySchema,
    // Optional at create time; only ADMIN/ACCOUNTANT may pass this — service
    // throws ForbiddenException for HR/SENIOR/JUNIOR.
    seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
    // task-drop-share-override-and-receiver (Part A). Per-project DROP share %
    // override. Same field-scoped RBAC as seniorSharePercentOverride (only
    // ADMIN/ACCOUNTANT — service throws for HR/SENIOR/JUNIOR). Applies only to
    // drop-projects; ignored (no drop) otherwise. `null`/absent = drop's global
    // default (`users.dropSharePercent` → 5).
    dropSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
    techStack: z.string().max(500).optional().nullable(),
    teamSize: z.string().max(100).optional().nullable(),
    benefits: z.string().max(500).optional().nullable(),
    // task-drop-share-override-and-receiver (D1, review round 1 LOW-1): runtime-
    // strict membership check (see `paymentTypeStringSchema`) — rejects an
    // unknown value at the controller Zod-parse layer (400), without narrowing
    // the TS type away from `string` (the create form renders a 3-value Select
    // since PR #367, but its value still flows as plain `string`). Absent →
    // backend default 'FOP'.
    paymentType: paymentTypeStringSchema.optional().nullable(),
    salaryReview: z.string().max(255).optional().nullable(),
    corpTech: z.string().max(255).optional().nullable(),
    notesGeneral: z.string().max(1000).optional().nullable(),
  })
  .superRefine(refineLogoXor)

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    companyName: z.string().min(1).max(255).optional(),
    domain: itDomainSchema.optional(),
    logoDocumentId: z.string().uuid().nullable().optional(),
    logoExternalUrl: z.string().url().nullable().optional(),
    /**
     * Drop role - phase 2. Same semantics as createProjectSchema.dropId —
     * `null` clears (project becomes a regular senior-project), `string`
     * sets/changes the drop, `undefined` (absent) means "leave unchanged".
     */
    dropId: z.string().uuid().nullable().optional(),
    rate: z.number().int().positive().optional(),
    currency: currencySchema.optional(),
    // Only ADMIN/ACCOUNTANT may include this field — service throws
    // ForbiddenException for HR/SENIOR/JUNIOR if it is present (even null).
    seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
    // task-drop-share-override-and-receiver (Part A). Per-project DROP share %
    // override. Field-scoped RBAC identical to seniorSharePercentOverride
    // (ADMIN/ACCOUNTANT only). `null` clears (→ drop's global default),
    // `number` sets, `undefined` (absent) = leave unchanged. Service applies
    // implicit-null-reset (value === effective drop default → stored as null).
    dropSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
    techStack: z.string().max(500).optional().nullable(),
    teamSize: z.string().max(100).optional().nullable(),
    benefits: z.string().max(500).optional().nullable(),
    // task-drop-share-override-and-receiver (D1, review round 1 LOW-1): same
    // runtime-strict / type-loose contract as createProjectSchema above.
    // `undefined` (absent) = leave unchanged.
    paymentType: paymentTypeStringSchema.optional().nullable(),
    salaryReview: z.string().max(255).optional().nullable(),
    corpTech: z.string().max(255).optional().nullable(),
    notesGeneral: z.string().max(1000).optional().nullable(),
  })
  .superRefine(refineLogoXor)

/**
 * task-project-draft-status, item 4. `POST /api/projects/:id/reject` body —
 * mirrors `rejectApprovalInputSchema`'s own "Отказ возможен и требует
 * причины" (§3.3) contract: non-blank reason required.
 *
 * security-review round 3 (SR-L-1): `.max(500)` — the DB column
 * (`approvals.rejection_reason`) is `text` (unbounded), so this is the only
 * backstop against an authenticated invited approver writing an arbitrarily
 * large blob that then renders on the admin's screen. Mirrors the sibling
 * precedent `contracts.rejectionReason` (`varchar(500)` /
 * `z.string().max(500)` in finance.ts) rather than inventing a new bound.
 */
export const rejectProjectSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Причина отказа обязательна')
    .max(500, 'Причина отказа слишком длинная (максимум 500 символов)'),
})
export type RejectProjectDto = z.infer<typeof rejectProjectSchema>

export const addProjectMemberSchema = z.object({
  userId: z.string().uuid(),
})

/**
 * Allowlist DTO for GET /api/projects/:id/hr-contact.
 * JUNIOR-facing surface — only safe contact fields, no ids/roles/finance.
 * `null` when no HR is assigned to the project's team.
 */
export const hrContactSchema = z.object({
  displayName: z.string().nullable(),
  telegram: z.string().nullable(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
})

export type HrContactDto = z.infer<typeof hrContactSchema>

export type ProjectMemberDto = z.infer<typeof projectMemberSchema>
export type ProjectDto = z.infer<typeof projectSchema>
export type CreateProjectDto = z.infer<typeof createProjectSchema>
export type UpdateProjectDto = z.infer<typeof updateProjectSchema>
export type AddProjectMemberDto = z.infer<typeof addProjectMemberSchema>
export type EffectiveTeam = z.infer<typeof effectiveTeamSchema>
export type ProjectDetailDto = z.infer<typeof projectDetailSchema>
export type ProjectAuditAction = z.infer<typeof projectAuditActionSchema>
export type ProjectAuditLogEntry = z.infer<typeof projectAuditLogEntrySchema>
export type ProjectAuditLogList = z.infer<typeof projectAuditLogListSchema>
export type ArchiveImpact = z.infer<typeof archiveImpactSchema>
export type CascadeRequiredError = z.infer<typeof cascadeRequiredErrorSchema>
