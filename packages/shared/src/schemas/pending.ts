import { z } from 'zod'

/**
 * task-pending-screen (position 7c of docs/superpowers/specs/2026-09-01-
 * notifications-and-confirmations-design.md, §8.3). The response shape of
 * `GET /pending` — one screen aggregating everything a viewer either owes a
 * decision on (`mine`) or is waiting on someone ELSE to decide (`proposedByMe`,
 * ADMIN only today — see `PendingService.getPending`).
 *
 * Deliberately a NEW leaf file rather than extending `approvals.ts`:
 * `approvals.ts`'s own header says it "does not know about projects or
 * shares" — this schema is the opposite, a cross-subject VIEW that only
 * makes sense once PROJECT / *_SENIOR_SHARE / the employee-contract flow all
 * exist. Folding it into `approvals.ts` would break that file's documented
 * subject-agnostic boundary for a schema that is subject-AWARE by design.
 */

// ---------------------------------------------------------------------------
// Kind — which underlying flow this item comes from
// ---------------------------------------------------------------------------

/**
 * Closed set (unlike `approvals.ts`'s free-form `subjectType`) — `PendingItem`
 * is a UI-facing projection, not the registry's own row; every value here is
 * something `PendingService` knows how to build a `title`/`link`/`actions`
 * for TODAY. An `approvals` row whose `subjectType` this service does not yet
 * recognise (a future subject type added by a later task, before this
 * service is taught about it) is skipped rather than forced into one of
 * these three — see that service's own comment.
 */
export const pendingItemKindSchema = z.enum([
  'PROJECT_APPROVAL',
  'SHARE_APPROVAL',
  'CONTRACT_TO_SIGN',
])
export type PendingItemKind = z.infer<typeof pendingItemKindSchema>

/**
 * Which buttons this row's `actions` may legitimately contain. `cancel` is
 * ADMIN-only in practice (`proposedByMe`, and only for `SHARE_APPROVAL` —
 * there is no "withdraw a project draft" endpoint in main yet, task file
 * §Что сделать item 2's own note: "для проекта — если отзыва нет в main,
 * только «Открыть»"). `approve`/`reject` only ever appear on `mine` rows —
 * the viewer IS the approver there by construction (every row in `mine`
 * comes from `ApprovalsService.listPendingForApprover(viewer.id)`).
 */
export const pendingItemActionSchema = z.enum(['approve', 'reject', 'cancel', 'open'])
export type PendingItemAction = z.infer<typeof pendingItemActionSchema>

/**
 * What the row's subject — and therefore its action endpoint — is scoped to.
 * See `pendingItemSchema.subjectType`'s own doc for the per-kind mapping and
 * for why this is two values rather than a mirror of the free-form
 * `approvals.subjectType` column.
 */
export const pendingItemSubjectTypeSchema = z.enum(['USER', 'PROJECT'])
export type PendingItemSubjectType = z.infer<typeof pendingItemSubjectTypeSchema>

// ---------------------------------------------------------------------------
// Item — one z.object per `kind`, joined with z.discriminatedUnion
// ---------------------------------------------------------------------------

/**
 * SR-L-3 (PR #667 fix-round 2, security review round 1): fields shared by
 * ALL three kinds. Previously this file was a single flat `z.object` where
 * `currentPercent` / `pendingPercent` / `viewerSharePercent` / `seniorName`
 * were ALL `.optional()` on every `kind` — the doc comment on that object
 * claimed the split was "structural, not just by omission at read-time",
 * which was not true: nothing in the TYPE stopped a future edit to
 * `PendingService.buildItemForSubject` from attaching a counterparty percent
 * to a PROJECT_APPROVAL row and having it sail through `.parse()` unchanged.
 * The only real guards were the branching in `viewerShareOnProject` and the
 * `collectNumbers(...).not.toContain(...)` assertions in
 * `pending.integration.spec.ts` — code and tests, not the type.
 *
 * Splitting into a `z.discriminatedUnion('kind', [...])` makes the doc's
 * claim true: each kind-specific field below exists ONLY on the variant(s)
 * that populate it. A field a variant does not declare is not merely absent
 * when unpopulated — Zod's default object mode ("strip") drops it from the
 * PARSED result even if present on the input, so a future bug that computes
 * a stray percent on the wrong branch gets silently stripped at this exact
 * boundary instead of reaching the client. See `pending.spec.ts`'s
 * "SR-L-3: strips ..." tests for the three directions of this.
 */
const pendingItemBaseSchema = z.object({
  /** The underlying project id / user id / employee_contracts id. */
  subjectId: z.string().uuid(),
  /**
   * The titles `PendingService` actually sends, per kind (COPY-L-5,
   * fix-round 3 — this list previously named "«Ваша базовая доля»" and
   * "Контракт сотрудника", neither of which the service has ever sent in
   * that form, making it a fourth name for the same fact for whoever wrote
   * the next string off this schema):
   *   PROJECT_APPROVAL  → the project's `companyName`
   *   SHARE_APPROVAL    → «Доля по умолчанию» (own, in `mine`)
   *                     / «Доля по умолчанию — {имя}» (someone else's, in
   *                       `proposedByMe`)
   *                     / «Доля по проекту «{name}»»
   *   CONTRACT_TO_SIGN  → «Ваш контракт»
   */
  title: z.string(),
  /** Who opened the proposal — populated on `mine` rows only. */
  proposedBy: z.string().optional(),
  /** Who has not yet answered — populated on `proposedByMe` rows only. */
  waitingFor: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  /** Non-empty — every row has at least `open`. */
  actions: z.array(pendingItemActionSchema).min(1),
  /** Where "Открыть" navigates. A route the viewer's role can reach — `PendingService` picks per kind/viewer. */
  link: z.string(),
})

/**
 * The `approvals.id` row this item was built from. Absent for
 * `CONTRACT_TO_SIGN` (contracts are not `approvals` rows at all — see
 * `PendingService`'s header) — that variant simply does not declare this
 * field below, rather than declaring it `.optional()`. When `proposedByMe`
 * groups more than one live approver row under the same subject (a project
 * inviting BOTH a SENIOR and a DROP, both still undecided), this is one of
 * those rows' id, not a claim that it is "the" row — `subjectId` is the
 * stable identifier for the subject itself; this field exists for a React
 * key / a possible future single-row action, not as a second subject
 * identifier.
 */
const approvalIdField = z.string().uuid()

export const pendingItemSchema = z.discriminatedUnion('kind', [
  /**
   * `currentPercent`/`pendingPercent` do not exist on this variant's shape
   * at all (task file: "в PROJECT_APPROVAL — только название и кто
   * предложил, никаких долей и ставок") — see `pendingItemBaseSchema`'s doc
   * above for what that buys over `.optional()`.
   */
  pendingItemBaseSchema.extend({
    kind: z.literal('PROJECT_APPROVAL'),
    approvalId: approvalIdField,
    /**
     * Per kind: `PROJECT_APPROVAL` → always `'PROJECT'` — integration
     * decision 1, 2026-09-11 (deliberately not a mirror of the free-form
     * `approvals.subjectType` column; see `PendingService`'s per-kind
     * mapping comment for SHARE_APPROVAL's two-way split).
     */
    subjectType: z.literal('PROJECT'),
    /**
     * The VIEWER'S OWN resolved share on this project — their senior share
     * when they are the project's senior, their drop share when they are
     * its drop — never the counterparty's (the same "SENIOR не видит долю
     * дропа и наоборот" contour `mapProject` enforces). `null` when the
     * viewer is party to neither side (an ADMIN reading their own
     * `proposedByMe` list, where the widget showed no share line either).
     * REQUIRED (not `.optional()`): `PendingService.buildItemForSubject`'s
     * PROJECT_APPROVAL branch always sets this key, to `null` or a number —
     * never omits it — so a payload missing the key entirely is malformed,
     * not merely "no share to show".
     *
     * Exists because `PendingProjectApprovalsPanel` used to read it off the
     * full `ProjectDto` (`effectiveSeniorSharePercent` /
     * `effectiveDropSharePercent`) and SR-L-6 took that whole DTO away from
     * the DROP dashboard: without this field, closing the leak would have
     * silently removed the one number a DROP needs to answer "да" with —
     * they have no route access to `/projects` at all (COPY-M-6, #646
     * fix-round 2). Integration decision 2, 2026-09-11.
     */
    viewerSharePercent: z.number().int().min(0).max(100).nullable(),
    /**
     * Populated ONLY for a viewer who is the project's DROP — who they
     * would be working under is decision-relevant context for them, and a
     * name is not a share figure. `null` for a SENIOR viewer (they ARE the
     * senior; the drop's identity stays masked from them per the same RBAC
     * rule `mapProject` applies) and for ADMIN. REQUIRED for the same
     * reason as `viewerSharePercent` above — always set, never omitted.
     */
    seniorName: z.string().nullable(),
  }),
  /**
   * `currentPercent`/`pendingPercent` are BOTH required and BOTH-or-NEITHER
   * by construction (never one without the other — `PendingService`'s two
   * SHARE_APPROVAL branches always set both together). Present ONLY for
   * `kind: 'SHARE_APPROVAL'` where the VIEWER is the person whose share it
   * is — the affected SENIOR in `mine` (always true there — a share-approval
   * row only ever reaches `mine` when the viewer IS the invited approver),
   * or the ADMIN who proposed it in `proposedByMe` (task file §Что сделать
   * item 1: "в proposedByMe для ADMIN — тоже можно (это он предложил)").
   *
   * `pendingPercent` is ALWAYS the resolved effective value
   * (`pendingSeniorShareSchema.effectivePercentAfterApproval`'s own
   * definition — task file «Допущения» item 4), never the raw nullable
   * override column: a proposal that clears an override back to the
   * team/user default is a legitimate live proposal with nothing to show as
   * "raw pending value" — the resolved fallback number is what the viewer
   * needs to see.
   */
  pendingItemBaseSchema.extend({
    kind: z.literal('SHARE_APPROVAL'),
    approvalId: approvalIdField,
    /**
     * Per kind: `SHARE_APPROVAL` → `'USER'` for a person's own base share,
     * `'PROJECT'` for a project-level override (`PendingService` sets the
     * literal directly per branch — both values are legitimate for this
     * kind, unlike PROJECT_APPROVAL/CONTRACT_TO_SIGN's fixed single value).
     * REQUIRED rather than optional so the client needs no fail-safe
     * default: PR #667's web half had to guess `'project'` on a missing
     * value, which would have routed a base-share decision at a project
     * endpoint.
     */
    subjectType: pendingItemSubjectTypeSchema,
    currentPercent: z.number().int().min(0).max(100),
    pendingPercent: z.number().int().min(0).max(100),
  }),
  /**
   * Contracts are not `approvals` rows (`PendingService.buildContractItem`
   * queries `employee_contracts` directly) — no `approvalId`, no percent or
   * share fields exist on this variant at all.
   */
  pendingItemBaseSchema.extend({
    kind: z.literal('CONTRACT_TO_SIGN'),
    /**
     * Per kind: `CONTRACT_TO_SIGN` → always `'USER'` — the contract is the
     * viewer's own — user-scoped, and its `link` (`/profile`) is a
     * user-scoped surface — even though its `subjectId` is the contract
     * row's id, not a user id.
     */
    subjectType: z.literal('USER'),
  }),
])
export type PendingItem = z.infer<typeof pendingItemSchema>

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * `GET /pending`'s full response. `proposedByMe` is `[]` (never omitted,
 * never a 403) for every role except ADMIN — task file §Что сделать item 1:
 * "для остальных ролей — пустой массив, не 403 (одна форма ответа)" — a
 * single response shape every role's client code can rely on without a
 * role-conditional branch on whether the field exists at all.
 */
export const pendingResponseSchema = z.object({
  mine: z.array(pendingItemSchema),
  proposedByMe: z.array(pendingItemSchema),
})
export type PendingResponse = z.infer<typeof pendingResponseSchema>

// ---------------------------------------------------------------------------
// Client-side leniency — COPY-L-6 (PR #667 fix-round 4)
// ---------------------------------------------------------------------------

/**
 * COPY-L-6. Two decisions of fix-round 3 pulled against each other: CR-M-1
 * made the client `.parse()` the response (right — it is what strips a
 * future server-side leak at this boundary), while COPY-L-4 gave an
 * unrecognised `kind` an honest title («Запрос на действие»). Together they
 * meant the fallback text could never render: a discriminated union rejects
 * an unknown `kind` outright, so a deployed API one version ahead of a
 * cached bundle put the WHOLE screen into its error state — «Не удалось
 * загрузить, что ждёт решения», while everything but one row had in fact
 * loaded. That is the exact deploy-window scenario the design spec's §6.5
 * wrote the degradation for.
 *
 * The resolution keeps both halves honest:
 *   - the server keeps `pendingResponseSchema` — STRICT. It only ever emits
 *     kinds it builds itself, so a stray `kind` there is a bug, not a
 *     version skew.
 *   - the client reads `pendingResponseClientSchema` — an unknown `kind`
 *     becomes ONE degraded row among working ones.
 *
 * `kind` is normalised to the literal `'UNKNOWN'` rather than passed
 * through, so the union stays discriminable (a `z.string()` discriminant
 * would silently defeat narrowing on every `item.kind === 'PROJECT_APPROVAL'`
 * in the app). Everything except the structural minimum is dropped: a
 * percent, a name or an `actions` entry belonging to a flow this bundle has
 * never heard of has no honest rendering here, and «чувствительные поля не
 * пропускать» is the safer default at a boundary whose whole purpose is to
 * stop unvalidated JSON. `title` is dropped with them — it is written for a
 * UI this build does not have, and the row's own fallback («Запрос на
 * действие») is the honest thing to show instead.
 */
const KNOWN_PENDING_KINDS: readonly string[] = pendingItemKindSchema.options

export const unknownPendingItemSchema = z
  .object({
    /** Refined so a KNOWN kind can never fall down here: a malformed
     * PROJECT_APPROVAL must still fail the parse loudly (CR-M-1), not
     * quietly become a nameless row. */
    kind: z.string().refine((k) => !KNOWN_PENDING_KINDS.includes(k)),
    /** The minimum a row needs to exist at all: a React key / testid… */
    subjectId: z.string().uuid(),
    /** …and the one fact every row's meta line prints. */
    createdAt: z.string().datetime(),
  })
  .transform((row) => ({
    kind: 'UNKNOWN' as const,
    subjectId: row.subjectId,
    createdAt: row.createdAt,
    /** Empty on purpose — `PendingItemRow` renders «Запрос на действие». */
    title: '',
    /** No buttons: this build cannot know what any of them would do. */
    actions: [] as PendingItemAction[],
    link: '',
  }))

export type UnknownPendingItem = z.infer<typeof unknownPendingItemSchema>

/** What every `/pending` consumer in `apps/web` actually holds. */
export const pendingItemClientSchema = z.union([pendingItemSchema, unknownPendingItemSchema])
export type PendingItemOrUnknown = z.infer<typeof pendingItemClientSchema>

export const pendingResponseClientSchema = z.object({
  mine: z.array(pendingItemClientSchema),
  proposedByMe: z.array(pendingItemClientSchema),
})
export type PendingResponseClient = z.infer<typeof pendingResponseClientSchema>
