/**
 * §7.4 "Degradation": a notification outlives the thing it is about. The project
 * was archived, the document deleted, the approval closed via `supersededAt` —
 * the button must lead to an honest "the object no longer exists", not to a blank screen.
 *
 * Here — the PURE half of this rule: which objects must be checked, which
 * approval rows to read, and how the answer "the object no longer exists" is
 * obtained from the check results. The half with queries lives in
 * `NotificationsService.resolveSubjectMissing` — it needs the database, and it is trivial
 * precisely because the decision is taken here.
 *
 * The split is not cosmetic: the mutation gate runs only the unit run and does not
 * see integration specs (`.claude/rules/common/mutation-gate-integration-specs.md`),
 * so a rule hidden inside a method with queries would remain
 * unchecked. Here it is checked without a database at all.
 */
import type { ApprovalStatus, NotificationSubjectType } from '@crm/shared'

/**
 * The state of the object the notification is about.
 *
 * QA-M-3 / QA-L-2 (manual-qa round 2, #664): previously this was a boolean answer
 * "row exists / no row", and an archived project fell into "exists" —
 * the button stayed active, and a junior whose membership ended by the cascade of
 * archiving landed on a page saying "You have not been added to the project yet".
 * A lie about an event that HAPPENED. Archived is a third answer, not a variant of
 * one of the two: the object is intact, but the work on it is finished.
 *
 * Absence from the map — "the object no longer exists"; therefore there are two variants here, and
 * the row has three states.
 */
export type SubjectState = 'active' | 'archived'

/** The notification row in the scope sufficient for the decision. */
export type SubjectRef = {
  userId: string
  type: string
  subjectType: NotificationSubjectType | null
  subjectId: string | null
  /**
   * QA-H-1 (manual-qa round 3, #664): the identifier of the SPECIFIC `approvals` row
   * that this notification is about. Taken from `data.approvalId`
   * (`approvalIdFromData`), put there by the producer. `null` — the row was written by
   * an assembly that did not yet put it there (see `computeSubjectState`).
   */
  approvalId: string | null
}

/**
 * Types whose currency depends on the liveness of the approval row.
 *
 * QA-H-1 (manual-qa round 3, #664). Here there was `approvalSubjectTypeFor`,
 * which returned the KIND of approval (`PROJECT` / `PROJECT_SENIOR_SHARE` /
 * `USER_SENIOR_SHARE`) — it was part of the key by which a notification
 * was matched to an `approvals` row. The key was the triple "kind + object + approver",
 * approver", and nothing in it distinguished GENERATIONS: two
 * proposals on the same share to the same senior gave one and the
 * same key. Live testing showed the cost: propose 30%, then 35% — and both
 * notifications show as active, with different percentages and two working
 * buttons.
 *
 * Now the ROW is recognised (`approvalId` in the data), not its description,
 * so there is nothing left for the approval kind to do here: the question "is this type
 * about an approval at all?" remains, and a `boolean` answers it. A duplicate
 * kind map, which had to be kept in agreement with the three
 * constants in `ProjectsService` / `UsersService`, also disappeared.
 */
export function awaitsApproval(type: string): boolean {
  return type === 'PROJECT_CONFIRM_REQUIRED' || type === 'SHARE_CONFIRM_REQUIRED'
}

/**
 * The `uuid` shape that `approvals.id` carries as a column in Postgres —
 * NOT a strict v4 check (version and variant do not matter here, the form of the record does).
 * The same class of check as `z.string().uuid()`, without a dependency on Zod in the
 * resolver (SR-M-18, security-review round 6, #664).
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The approval row identifier from the notification data (`data.approvalId`).
 *
 * `data` is `jsonb`, that is, `unknown` by definition: the shape is guaranteed by Zod at
 * write time (`notificationDataSchemaFor`), not at read time. Therefore parsing here, and
 * not a type cast: a row whose data has the wrong shape must arrive without
 * the identifier, rather than breaking the read of the whole list (AC2 — the same principle as
 * in `renderNotification`).
 *
 * SR-M-18 (security-review round 6, #664). The value goes further into
 * `inArray(approvals.id, …)` — a `uuid` column. A row of any other shape
 * would reach Postgres as a comparison parameter and break the query with error `22P02`,
 * and with it the whole `GET /api/notifications` of this user, rather than one row
 * (exactly what the first paragraph promises to prevent). The shape is checked here,
 * in the same place as the type — the wrong shape means no identifier, by the same path as
 * "not a string" or "empty".
 */
export function approvalIdFromData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const value = (data as Record<string, unknown>)['approvalId']
  return typeof value === 'string' && UUID_SHAPE.test(value) ? value : null
}

/** Groups identifiers by object kind — one query per kind. */
export function groupSubjectIds(rows: SubjectRef[]): Map<NotificationSubjectType, string[]> {
  const byType = new Map<NotificationSubjectType, Set<string>>()
  for (const row of rows) {
    if (row.subjectType === null || row.subjectId === null) continue
    const bucket = byType.get(row.subjectType) ?? new Set<string>()
    bucket.add(row.subjectId)
    byType.set(row.subjectType, bucket)
  }
  return new Map([...byType].map(([k, v]) => [k, [...v]]))
}

/**
 * ORCH-2 (fix round 6, #664). An `approvals` row with `supersededAt IS NULL`
 * (otherwise it would not be here — see the query in `NotificationsService`)
 * is classified into one of two: LIVE (still awaiting a reply) or RESOLVED (the same
 * approver has already replied, but nobody cancelled the generation). The difference matters
 * for the label: the live one gives an active button, the resolved one "Decision already made",
 * and everything else (no row at all, or it is closed, or `CANCELLED`) —
 * "Decision no longer required" (COPY-M-9, round 3; see `computeSubjectState`).
 *
 * The parse is EXHAUSTIVE, by the same device as `computeSubjectState` below:
 * `CANCELLED` today always arrives WITH `supersededAt` (`cancelInTx` sets both fields in
 * one record), so under the filter `isNull(supersededAt)` such a row
 * should no longer occur — but this is an invariant of the SERVICE, not of the database (there is no
 * CHECK constraint), and the explicit branch here defensively keeps it from silently becoming
 * "live" if the invariant is ever broken.
 */
export type ApprovalRowClassification = 'live' | 'decided' | 'superseded'

export function classifyApprovalRow(status: ApprovalStatus): ApprovalRowClassification {
  switch (status) {
    case 'PENDING':
      return 'live'
    case 'APPROVED':
    case 'REJECTED':
      return 'decided'
    case 'CANCELLED':
      return 'superseded'
    default: {
      const exhaustive: never = status
      throw new Error(`classifyApprovalRow: unknown status ${String(exhaustive)}`)
    }
  }
}

/**
 * Which approval rows must be read for this batch of notifications — by
 * identifiers, without repeats (in one query for the whole list).
 */
export function approvalIdsToCheck(rows: SubjectRef[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!awaitsApproval(row.type)) continue
    if (row.approvalId === null) continue
    seen.add(row.approvalId)
  }
  return [...seen]
}

/**
 * Summary. Five answers instead of three (ORCH-2, fix round 6, #664, extends
 * QA-M-3/QA-L-2):
 *   - `missing` — the object has vanished (no row among those found);
 *   - `archived` — the object is intact, but the work on it is finished (QA-M-3/QA-L-2);
 *   - `approvalDecided` — the object is alive, this notification is about an approval, and
 *     THIS approver has already replied (`classifyApprovalRow` → `decided`), but
 *     nobody cancelled the generation — the question is closed on their side;
 *   - `approvalSuperseded` — the object is alive, the notification is about an approval, but
 *     there is no longer a live reply for this approver: the offer
 *     was withdrawn, re-created, closed by a neighbour's refusal, or the row was not found
 *     at all;
 *   - `active` — everything is in place, the button leads where it promises.
 *
 * Previously the last two states were one "missing" — "Project deleted" on a
 * LIVE project whose offer had simply been withdrawn. The same lie that
 * QA-M-3/QA-L-2 found for the archive, only for the approval: the label must
 * describe what happened, rather than borrowing a foreign meaning from a neighbouring
 * state.
 *
 * A row WITHOUT a structural object (three legacy types) — is not "gone": it
 * never had an object; its button follows the stored link.
 *
 * The order of checks is meaningful, not accidental: the OBJECT's state decides
 * before the approval's liveness. The label is derived from the object's kind ("Project in
 * the archive"), and to say "Project deleted" (or "Proposal withdrawn") about an archived project
 * only because the proposal on it was closed — exactly the lie the finding was made for.
 * (the lie that the finding was raised to catch).
 */
export type SubjectResolution = SubjectState | 'missing' | 'approvalSuperseded' | 'approvalDecided'

export function computeSubjectState(
  row: SubjectRef,
  statesByType: Map<NotificationSubjectType, Map<string, SubjectState>>,
  liveApprovalIds: Set<string>,
  decidedApprovalIds: Set<string>,
): SubjectResolution {
  if (row.subjectType === null || row.subjectId === null) return 'active'
  const state = statesByType.get(row.subjectType)?.get(row.subjectId)
  if (state === undefined) return 'missing'
  // The parse is EXHAUSTIVE, not a pair of comparisons, and this is no decoration: the state
  // is assembled by hand from the `archived_at` column (`loadSubjectStates`), and
  // a value we do not expect must break the parse rather than turn
  // silently into "live" — silently that is an active button on an object about which
  // nothing is known. The same device as `describeNotification` (CR-M-1).
  // Mutation gate of round 5: with a pair of comparisons one of the two literals always
  // remained unchecked — which one depended on which of them was
  // compared against.
  switch (state) {
    case 'archived':
      return 'archived'
    case 'active':
      break
    default: {
      const exhaustive: never = state
      throw new Error(`computeSubjectState: unknown state ${String(exhaustive)}`)
    }
  }
  if (!awaitsApproval(row.type)) return 'active'
  // QA-H-1: a notification without an approval-row identifier cannot be recognised —
  // and to say "a decision is no longer required" about it would mean
  // asserting a fact we do not know. The button stays: it leads to the object's
  // page, where the real state of the proposal is shown. Such a row
  // can be written only by an assembly predating this round — both producers
  // put in the identifier, and the data shape (`notificationDataSchemaFor`) makes it
  // mandatory.
  if (row.approvalId === null) return 'active'
  if (liveApprovalIds.has(row.approvalId)) return 'active'
  // ORCH-2: "resolved" is checked SEPARATELY from "no live row at all" — the same
  // device that distinguished archive and deletion. The replied approver is
  // told that they have already replied, not that the proposal was withdrawn from under
  // their hands.
  if (decidedApprovalIds.has(row.approvalId)) return 'approvalDecided'
  return 'approvalSuperseded'
}
