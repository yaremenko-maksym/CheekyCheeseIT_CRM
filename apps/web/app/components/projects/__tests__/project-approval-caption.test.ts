/**
 * task-projects-followups-web (backlog 201, AC4). Pins every branch of
 * `resolveProjectApprovalCaption` — the shared helper `ProjectRow.tsx` and
 * the project detail page header both call for the SAME caption text (see
 * that function's own doc for why it exists and what each branch means).
 *
 * task-i18n-stage3c-pr3 (Task 3, Step 3, template K, COPY-H-proj-2). The
 * function now resolves against the REAL compiled catalog (SPEC-H-1) via
 * the shared `@lingui/core` `i18n` singleton — `loadCatalog` activates the
 * locale BEFORE each call, same pattern as every other catalog-backed unit
 * test in this repo (`role-select.locale.test.tsx`). The old "от <имя>"
 * (nominative-only, wrong case) frame is gone — no test asserts it, and the
 * new frame has no case to get wrong on either language.
 */
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '@/test/i18n'
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

describe('resolveProjectApprovalCaption (uk)', () => {
  it('DRAFT, senior-only project, still pending — "Підтверджує <сеньйор>"', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(makeInput(), undefined)
    expect(caption).toBe('Підтверджує Oleksiy Kovalenko')
  })

  it('DRAFT, drop-project, BOTH still pending — "Підтверджують: <дроп>, <сеньйор>" (drop first)', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        dropApprovalPending: true,
      }),
      undefined,
    )
    expect(caption).toBe('Підтверджують: Nadiya Dropivska, Oleksiy Kovalenko')
  })

  it('DRAFT, drop-project, senior already confirmed (один подтвердил), dropName known — third-party caption names the drop (COPY-M-2: symmetric with the "both pending" branch)', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      undefined,
    )
    expect(caption).toBe('Підтверджує Nadiya Dropivska')
  })

  it('DRAFT, drop-project, senior already confirmed, dropName masked to null (e.g. SENIOR viewer) — third-party caption falls back to generic "дропа"', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: null,
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      undefined,
    )
    expect(caption).toBe('Підтверджує дропа')
  })

  it('DRAFT, drop-project, drop already confirmed (один подтвердил) — third-party caption names only the senior', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: true,
        dropApprovalPending: false,
      }),
      undefined,
    )
    expect(caption).toBe('Підтверджує Oleksiy Kovalenko')
  })

  it('DRAFT, viewer IS the senior and already confirmed — first-person caption, waiting on the drop', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      SENIOR_ID,
    )
    expect(caption).toBe('Ви підтвердили. Чекаємо дропа')
  })

  it('DRAFT, viewer IS the drop and already confirmed — first-person caption, waiting on the senior', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: true,
        dropApprovalPending: false,
      }),
      DROP_ID,
    )
    expect(caption).toBe('Ви підтвердили. Чекаємо сеньйора')
  })

  it("DRAFT, viewer has an id but is NOT the senior (e.g. ADMIN viewing someone else's draft), senior already confirmed — third-party caption, NOT the first-person one", async () => {
    // Kills the `viewerId === project.seniorId` equality check specifically
    // (both a `&&`→`||` LogicalOperator mutant and a `true`-substitution
    // ConditionalExpression mutant on `viewerIsSenior`): a truthy but
    // NON-MATCHING viewerId must still fall through to the generic caption,
    // not the "Ви підтвердили…" one a broken equality would wrongly produce.
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      THIRD_PARTY_ID,
    )
    expect(caption).toBe('Підтверджує Nadiya Dropivska')
  })

  it('DRAFT, viewer has an id but is NOT the drop, drop already confirmed — third-party caption, NOT the first-person one', async () => {
    // Same mutant class as above, mirrored onto `viewerIsDrop`'s own
    // equality check.
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: true,
        dropApprovalPending: false,
      }),
      THIRD_PARTY_ID,
    )
    expect(caption).toBe('Підтверджує Oleksiy Kovalenko')
  })

  it('DRAFT, senior-only project, seniorName is null on the DTO — falls back to "сеньйора", never prints "null" (COPY-M-4)', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(makeInput({ seniorName: null }), undefined)
    expect(caption).toBe('Підтверджує сеньйора')
    expect(caption).not.toContain('null')
  })

  it('DRAFT, drop-project, BOTH pending, seniorName is empty string on the DTO — falls back to "сеньйора" (COPY-M-4, empty string is also falsy)', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        dropApprovalPending: true,
        seniorName: '',
      }),
      undefined,
    )
    expect(caption).toBe('Підтверджують: Nadiya Dropivska, сеньйора')
  })

  it('REJECTED with a reason (отклонён с причиной) — quoted caption, verbatim, no translation', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({ status: 'REJECTED', rejectionReason: 'немає бюджету на Q3' }),
      undefined,
    )
    expect(caption).toBe('«немає бюджету на Q3»')
  })

  it('REJECTED with no reason on the DTO (masked) — null', async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(
      makeInput({ status: 'REJECTED', rejectionReason: null }),
      undefined,
    )
    expect(caption).toBeNull()
  })

  it("ACTIVE — null (nothing to say; archival itself is a separate axis — archivedAt — not modeled by this helper at all, see ProjectRow.tsx's own isArchived-first priority)", async () => {
    await loadCatalog('uk')
    const caption = resolveProjectApprovalCaption(makeInput({ status: 'ACTIVE' }), undefined)
    expect(caption).toBeNull()
  })
})

describe('resolveProjectApprovalCaption (en second original)', () => {
  it('DRAFT, senior-only project, still pending', async () => {
    await loadCatalog('en')
    const caption = resolveProjectApprovalCaption(makeInput(), undefined)
    expect(caption).toBe('Awaiting Oleksiy Kovalenko')
  })

  it('DRAFT, viewer IS the senior and already confirmed — first-person, waiting on the drop', async () => {
    await loadCatalog('en')
    const caption = resolveProjectApprovalCaption(
      makeInput({
        dropId: DROP_ID,
        dropName: 'Nadiya Dropivska',
        seniorApprovalPending: false,
        dropApprovalPending: true,
      }),
      SENIOR_ID,
    )
    expect(caption).toBe('You confirmed. Awaiting the drop')
  })
})
