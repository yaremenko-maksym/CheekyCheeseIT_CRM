/**
 * task-projects-followups-web (backlog 201, AC4). Pins every branch of
 * `resolveProjectApprovalCaption` — the shared helper `ProjectRow.tsx` and
 * the project detail page header both call for the SAME caption text (see
 * that function's own doc for why it exists and what each branch means).
 */
import { describe, expect, it } from 'vitest'
import type { ProjectDto } from '@crm/shared'
import {
  resolveProjectApprovalCaption,
  type ProjectApprovalCaptionInput,
} from '../project-approval-caption'

const SENIOR_ID = '00000000-0000-0000-0000-0000000000b1'
const DROP_ID = '00000000-0000-0000-0000-0000000000b2'
const THIRD_PARTY_ID = '00000000-0000-0000-0000-0000000000c9'

function makeInput(
  overrides: Partial<ProjectApprovalCaptionInput> = {},
): ProjectApprovalCaptionInput {
  const base: Pick<
    ProjectDto,
    | 'status'
    | 'rejectionReason'
    | 'seniorId'
    | 'seniorName'
    | 'dropId'
    | 'dropName'
    | 'seniorApprovalPending'
    | 'dropApprovalPending'
  > = {
    status: 'DRAFT',
    rejectionReason: null,
    seniorId: SENIOR_ID,
    seniorName: 'Oleksiy Kovalenko',
    dropId: null,
    dropName: null,
    seniorApprovalPending: true,
    dropApprovalPending: undefined,
  }
  return { ...base, ...overrides }
}

describe('resolveProjectApprovalCaption', () => {
  it('DRAFT, senior-only project, still pending — "от <синьор>"', () => {
    const caption = resolveProjectApprovalCaption(makeInput(), undefined)
    expect(caption).toBe('от Oleksiy Kovalenko')
  })

  it('DRAFT, drop-project, BOTH still pending — "от <дроп> и <синьор>" (drop first)', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        dropApprovalPending: true,
      }),
      undefined,
    )
    expect(caption).toBe('от Nadiya Dropivska и Oleksiy Kovalenko')
  })

  it('DRAFT, drop-project, senior already confirmed (один подтвердил), dropName known — third-party caption names the drop (COPY-M-2: symmetric with the "both pending" branch)', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      undefined,
    )
    expect(caption).toBe('от Nadiya Dropivska')
  })

  it('DRAFT, drop-project, senior already confirmed, dropName masked to null (e.g. SENIOR viewer) — third-party caption falls back to generic "дропа"', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: null,
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      undefined,
    )
    expect(caption).toBe('от дропа')
  })

  it('DRAFT, drop-project, drop already confirmed (один подтвердил) — third-party caption names only the senior', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: true,
        dropApprovalPending: false,
      }),
      undefined,
    )
    expect(caption).toBe('от Oleksiy Kovalenko')
  })

  it('DRAFT, viewer IS the senior and already confirmed (зритель подтвердил) — first-person caption, waiting on the drop', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      SENIOR_ID,
    )
    expect(caption).toBe('Вы подтвердили. Ждём дропа')
  })

  it('DRAFT, viewer IS the drop and already confirmed (зритель подтвердил) — first-person caption, waiting on the senior', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: true,
        dropApprovalPending: false,
      }),
      DROP_ID,
    )
    expect(caption).toBe('Вы подтвердили. Ждём синьора')
  })

  it("DRAFT, viewer has an id but is NOT the senior (e.g. ADMIN viewing someone else's draft), senior already confirmed — third-party caption, NOT the first-person one", () => {
    // Kills the `viewerId === project.seniorId` equality check specifically
    // (both a `&&`→`||` LogicalOperator mutant and a `true`-substitution
    // ConditionalExpression mutant on `viewerIsSenior`): a truthy but
    // NON-MATCHING viewerId must still fall through to the generic caption,
    // not the "Вы подтвердили…" one a broken equality would wrongly produce.
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      THIRD_PARTY_ID,
    )
    expect(caption).toBe('от Nadiya Dropivska')
  })

  it('DRAFT, viewer has an id but is NOT the drop, drop already confirmed — third-party caption, NOT the first-person one', () => {
    // Same mutant class as above, mirrored onto `viewerIsDrop`'s own
    // equality check.
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: true,
        dropApprovalPending: false,
      }),
      THIRD_PARTY_ID,
    )
    expect(caption).toBe('от Oleksiy Kovalenko')
  })

  it('DRAFT, senior-only project, seniorName is null on the DTO — falls back to "от синьора", never prints "null" (COPY-M-4)', () => {
    const caption = resolveProjectApprovalCaption(makeInput({ seniorName: null }), undefined)
    expect(caption).toBe('от синьора')
    expect(caption).not.toContain('null')
  })

  it('DRAFT, drop-project, BOTH pending, seniorName is empty string on the DTO — falls back to "от синьора" (COPY-M-4, empty string is also falsy)', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        dropApprovalPending: true,
        seniorName: '',
      }),
      undefined,
    )
    expect(caption).toBe('от Nadiya Dropivska и синьора')
  })

  it('REJECTED with a reason (отклонён с причиной) — quoted caption', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({ status: 'REJECTED', rejectionReason: 'нет бюджета на Q3' }),
      undefined,
    )
    expect(caption).toBe('«нет бюджета на Q3»')
  })

  it('REJECTED with no reason on the DTO (отклонён без причины, e.g. non-ADMIN masking) — null', () => {
    const caption = resolveProjectApprovalCaption(
      makeInput({ status: 'REJECTED', rejectionReason: null }),
      undefined,
    )
    expect(caption).toBeNull()
  })

  it("ACTIVE — null (nothing to say; archival itself is a separate axis — archivedAt — not modeled by this helper at all, see ProjectRow.tsx's own isArchived-first priority)", () => {
    const caption = resolveProjectApprovalCaption(makeInput({ status: 'ACTIVE' }), undefined)
    expect(caption).toBeNull()
  })
})
