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
// Item
// ---------------------------------------------------------------------------

/**
 * One row on the /pending screen. `currentPercent`/`pendingPercent` are
 * BOTH-or-NEITHER (never one without the other) and present ONLY for
 * `kind: 'SHARE_APPROVAL'` where the VIEWER is the person whose share it is
 * — the affected SENIOR in `mine` (always true there — a share-approval row
 * only ever reaches `mine` when the viewer IS the invited approver), or the
 * ADMIN who proposed it in `proposedByMe` (task file §Что сделать item 1:
 * "в proposedByMe для ADMIN — тоже можно (это он предложил)"). A
 * `PROJECT_APPROVAL` row NEVER carries either field — task file: "в
 * PROJECT_APPROVAL — только название и кто предложил, никаких долей и
 * ставок" — this is what AC3's "no drop percentages anywhere in the JSON
 * for a SENIOR viewer" rests on structurally, not just by omission at
 * read-time (there is no drop-share approval flow at all today — see
 * `PendingService`'s own header comment — so the field could never be
 * populated with a drop figure even if this schema allowed it here).
 *
 * `pendingPercent` is ALWAYS the resolved effective value
 * (`pendingSeniorShareSchema.effectivePercentAfterApproval`'s own
 * definition — task file «Допущения» item 4), never the raw nullable
 * override column: a proposal that clears an override back to the
 * team/user default is a legitimate live proposal with nothing to show as
 * "raw pending value" — the resolved fallback number is what the viewer
 * needs to see.
 */
export const pendingItemSchema = z.object({
  kind: pendingItemKindSchema,
  /**
   * The `approvals.id` row this item was built from. Absent for
   * `CONTRACT_TO_SIGN` (contracts are not `approvals` rows at all — see
   * `PendingService`'s header). When `proposedByMe` groups more than one
   * live approver row under the same subject (a project inviting BOTH a
   * SENIOR and a DROP, both still undecided), this is one of those rows'
   * id, not a claim that it is "the" row — `subjectId` is the stable
   * identifier for the subject itself; this field exists for a React key /
   * a possible future single-row action, not as a second subject identifier.
   */
  approvalId: z.string().uuid().optional(),
  /**
   * What this row's `subjectId` — and therefore the row's ACTION — is
   * scoped to. REQUIRED and closed, deliberately NOT a mirror of the
   * free-form `approvals.subjectType` column (integration decision 1,
   * 2026-09-11): the client's only question is which endpoint family the
   * action goes to (`/users/:id/...` vs `/projects/:id/...`), and the raw
   * column's three values answer it with two of them meaning the same
   * thing. `kind` still distinguishes a project APPROVAL from a
   * project-scoped SHARE proposal, so nothing is lost by collapsing
   * `'PROJECT'` and `'PROJECT_SENIOR_SHARE'` here.
   *
   * Per kind: `PROJECT_APPROVAL` → `'PROJECT'`; `SHARE_APPROVAL` →
   * `'USER'` for a person's own base share, `'PROJECT'` for a
   * project-level override; `CONTRACT_TO_SIGN` → `'USER'` (the contract is
   * the viewer's own — user-scoped, and its `link` is a user-scoped
   * surface — even though its `subjectId` is the contract row's id).
   *
   * Required rather than optional so the client needs no fail-safe default:
   * PR #667's web half had to guess `'project'` on a missing value, which
   * would have routed a base-share decision at a project endpoint.
   */
  subjectType: pendingItemSubjectTypeSchema,
  /** The underlying project id / user id / employee_contracts id. */
  subjectId: z.string().uuid(),
  /** "<project name>" / "«Ваша базовая доля»" / "Контракт сотрудника" — see `PendingService` per-kind title choice. */
  title: z.string(),
  /** Who opened the proposal — populated on `mine` rows only. */
  proposedBy: z.string().optional(),
  /** Who has not yet answered — populated on `proposedByMe` rows only. */
  waitingFor: z.array(z.string()).optional(),
  /** The LIVE (pre-approval) resolved percent. `SHARE_APPROVAL`-only, see class doc above. */
  currentPercent: z.number().int().min(0).max(100).optional(),
  /** The percent this proposal would resolve to if approved. `SHARE_APPROVAL`-only, see class doc above. */
  pendingPercent: z.number().int().min(0).max(100).optional(),
  /**
   * `PROJECT_APPROVAL`-only: the VIEWER'S OWN resolved share on this
   * project — their senior share when they are the project's senior, their
   * drop share when they are its drop — never the counterparty's (the same
   * "SENIOR не видит долю дропа и наоборот" contour `mapProject` enforces).
   * `null` when the viewer is party to neither side (an ADMIN reading their
   * own `proposedByMe` list, where the widget showed no share line either).
   *
   * Exists because `PendingProjectApprovalsPanel` used to read it off the
   * full `ProjectDto` (`effectiveSeniorSharePercent` /
   * `effectiveDropSharePercent`) and SR-L-6 took that whole DTO away from
   * the DROP dashboard: without this field, closing the leak would have
   * silently removed the one number a DROP needs to answer "да" with — they
   * have no route access to `/projects` at all (COPY-M-6, #646 fix-round 2).
   * Integration decision 2, 2026-09-11.
   */
  viewerSharePercent: z.number().int().min(0).max(100).nullable().optional(),
  /**
   * `PROJECT_APPROVAL`-only, and populated ONLY for a viewer who is the
   * project's DROP — who they would be working under is decision-relevant
   * context for them, and a name is not a share figure. `null` for a SENIOR
   * viewer (they ARE the senior; the drop's identity stays masked from them
   * per the same RBAC rule `mapProject` applies) and for ADMIN.
   */
  seniorName: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  /** Non-empty — every row has at least `open`. */
  actions: z.array(pendingItemActionSchema).min(1),
  /** Where "Открыть" navigates. A route the viewer's role can reach — `PendingService` picks per kind/viewer. */
  link: z.string(),
})
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
