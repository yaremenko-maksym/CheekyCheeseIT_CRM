/**
 * Unit tests — project-update-data.util (leaf of the projects.service decomposition).
 * Expected values are hand-written literals.
 */
import { describe, expect, it } from 'vitest'
import type { UpdateProjectDto } from '@crm/shared'
import {
  assertFinanceFieldsAllowed,
  buildProjectUpdateData,
  isFinanceOnlyPatch,
  resolveActiveDropId,
} from './project-update-data.util'

function codeOf(fn: () => void): { code: unknown; status: number } | null {
  try {
    fn()
    return null
  } catch (e) {
    const err = e as { getStatus: () => number; getResponse: () => { code?: unknown } }
    return { code: err.getResponse().code, status: err.getStatus() }
  }
}

describe('assertFinanceFieldsAllowed', () => {
  it.each(['ADMIN', 'ACCOUNTANT'] as const)('%s may send every finance field', (role) => {
    expect(
      codeOf(() =>
        assertFinanceFieldsAllowed(
          { seniorSharePercentOverride: 10, dropSharePercentOverride: null, paymentType: 'FOP' },
          role,
        ),
      ),
    ).toBeNull()
  })

  it.each(['HR', 'SENIOR', 'JUNIOR', 'DROP'] as const)(
    '%s with no finance field passes',
    (role) => {
      expect(codeOf(() => assertFinanceFieldsAllowed({}, role))).toBeNull()
    },
  )

  it('HR sending senior override (even null) gets SENIOR_SHARE_OVERRIDE_FORBIDDEN', () => {
    expect(
      codeOf(() => assertFinanceFieldsAllowed({ seniorSharePercentOverride: null }, 'HR')),
    ).toEqual({ code: 'SENIOR_SHARE_OVERRIDE_FORBIDDEN', status: 403 })
  })

  it('HR sending drop override gets DROP_SHARE_OVERRIDE_FORBIDDEN', () => {
    expect(
      codeOf(() => assertFinanceFieldsAllowed({ dropSharePercentOverride: null }, 'HR')),
    ).toEqual({ code: 'DROP_SHARE_OVERRIDE_FORBIDDEN', status: 403 })
  })

  it('HR sending paymentType gets PAYMENT_TYPE_CHANGE_FORBIDDEN', () => {
    expect(codeOf(() => assertFinanceFieldsAllowed({ paymentType: 'FOP' }, 'HR'))).toEqual({
      code: 'PAYMENT_TYPE_CHANGE_FORBIDDEN',
      status: 403,
    })
  })

  it('senior override is reported before drop override and paymentType', () => {
    expect(
      codeOf(() =>
        assertFinanceFieldsAllowed(
          { seniorSharePercentOverride: 5, dropSharePercentOverride: 5, paymentType: 'FOP' },
          'HR',
        ),
      ),
    ).toEqual({ code: 'SENIOR_SHARE_OVERRIDE_FORBIDDEN', status: 403 })
  })

  it('drop override is reported before paymentType', () => {
    expect(
      codeOf(() =>
        assertFinanceFieldsAllowed({ dropSharePercentOverride: 5, paymentType: 'FOP' }, 'HR'),
      ),
    ).toEqual({ code: 'DROP_SHARE_OVERRIDE_FORBIDDEN', status: 403 })
  })
})

describe('isFinanceOnlyPatch', () => {
  it('empty patch is not finance-only', () => {
    expect(isFinanceOnlyPatch({})).toBe(false)
  })
  it('only finance keys is finance-only', () => {
    expect(
      isFinanceOnlyPatch({
        seniorSharePercentOverride: 1,
        dropSharePercentOverride: 2,
        paymentType: 'FOP',
      }),
    ).toBe(true)
  })
  it.each(['seniorSharePercentOverride', 'dropSharePercentOverride', 'paymentType'] as const)(
    '%s alone is finance-only',
    (k) => {
      expect(isFinanceOnlyPatch({ [k]: null } as UpdateProjectDto)).toBe(true)
    },
  )
  it('one non-finance key breaks it', () => {
    expect(isFinanceOnlyPatch({ paymentType: 'FOP', name: 'x' })).toBe(false)
  })
})

describe('resolveActiveDropId', () => {
  const dbWith = (row: unknown) =>
    ({ query: { users: { findFirst: () => Promise.resolve(row) } } }) as never

  it('returns the id of an active DROP user', async () => {
    await expect(
      resolveActiveDropId(dbWith({ id: 'd1', role: 'DROP', archivedAt: null }), 'd1'),
    ).resolves.toBe('d1')
  })
  it('404 DROP_NOT_FOUND when missing', async () => {
    await expect(resolveActiveDropId(dbWith(undefined), 'x')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DROP_NOT_FOUND', statusCode: 404 }),
    })
  })
  it('400 USER_NOT_DROP for another role', async () => {
    await expect(
      resolveActiveDropId(dbWith({ id: 'u', role: 'SENIOR', archivedAt: null }), 'u'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'USER_NOT_DROP', statusCode: 400 }),
    })
  })
  it('400 DROP_ARCHIVED for archived drop', async () => {
    await expect(
      resolveActiveDropId(dbWith({ id: 'd', role: 'DROP', archivedAt: new Date() }), 'd'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DROP_ARCHIVED', statusCode: 400 }),
    })
  })
})

describe('buildProjectUpdateData', () => {
  it('empty patch only stamps updatedAt', () => {
    const r = buildProjectUpdateData({}, undefined, undefined)
    expect(Object.keys(r)).toEqual(['updatedAt'])
    expect(r.updatedAt).toBeInstanceOf(Date)
  })

  it('copies plain scalar fields', () => {
    const r = buildProjectUpdateData(
      { name: 'N', companyName: 'C', domain: 'd.io', rate: 12, currency: 'USD' },
      undefined,
      undefined,
    )
    expect(r).toMatchObject({
      name: 'N',
      companyName: 'C',
      domain: 'd.io',
      rate: 12,
      currency: 'USD',
    })
  })

  it('nullable text fields: value kept, null kept', () => {
    const r = buildProjectUpdateData(
      {
        techStack: 'ts',
        teamSize: null,
        benefits: 'b',
        salaryReview: null,
        corpTech: 'c',
        notesGeneral: null,
      },
      undefined,
      undefined,
    )
    expect(r).toMatchObject({
      techStack: 'ts',
      teamSize: null,
      benefits: 'b',
      salaryReview: null,
      corpTech: 'c',
      notesGeneral: null,
    })
  })

  it('setting a logo document clears the external url unless one was sent', () => {
    expect(buildProjectUpdateData({ logoDocumentId: 'doc' }, undefined, undefined)).toMatchObject({
      logoDocumentId: 'doc',
      logoExternalUrl: null,
    })
    const both = buildProjectUpdateData(
      { logoDocumentId: 'doc', logoExternalUrl: 'https://x' },
      undefined,
      undefined,
    )
    expect(both.logoExternalUrl).toBe('https://x')
    expect(both.logoDocumentId).toBe('doc')
  })

  it('clearing the logo document does not touch the external url', () => {
    const r = buildProjectUpdateData({ logoDocumentId: null }, undefined, undefined)
    expect(r.logoDocumentId).toBeNull()
    expect('logoExternalUrl' in r).toBe(false)
  })

  it('setting an external url clears the document id unless one was sent', () => {
    expect(
      buildProjectUpdateData({ logoExternalUrl: 'https://x' }, undefined, undefined),
    ).toMatchObject({ logoExternalUrl: 'https://x', logoDocumentId: null })
    const r = buildProjectUpdateData({ logoExternalUrl: null }, undefined, undefined)
    expect(r.logoExternalUrl).toBeNull()
    expect('logoDocumentId' in r).toBe(false)
    const withDoc = buildProjectUpdateData(
      { logoExternalUrl: 'https://x', logoDocumentId: 'doc' },
      undefined,
      undefined,
    )
    expect(withDoc.logoDocumentId).toBe('doc')
  })

  it('drop override and dropId are written only when defined (null clears)', () => {
    const none = buildProjectUpdateData({}, undefined, undefined)
    expect('dropSharePercentOverride' in none).toBe(false)
    expect('dropId' in none).toBe(false)
    const set = buildProjectUpdateData({}, 'drop-1', 15)
    expect(set).toMatchObject({ dropId: 'drop-1', dropSharePercentOverride: 15 })
    const cleared = buildProjectUpdateData({}, null, null)
    expect(cleared.dropId).toBeNull()
    expect(cleared.dropSharePercentOverride).toBeNull()
  })

  it('never writes seniorSharePercentOverride', () => {
    const r = buildProjectUpdateData({ seniorSharePercentOverride: 33 }, undefined, undefined)
    expect('seniorSharePercentOverride' in r).toBe(false)
  })

  it('paymentType: valid value applied, null ignored, junk rejected', () => {
    expect(buildProjectUpdateData({ paymentType: 'FOP' }, undefined, undefined).paymentType).toBe(
      'FOP',
    )
    expect(
      'paymentType' in buildProjectUpdateData({ paymentType: null }, undefined, undefined),
    ).toBe(false)
    expect(() =>
      buildProjectUpdateData({ paymentType: 'BOGUS' as never }, undefined, undefined),
    ).toThrow()
  })
})
