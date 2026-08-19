/**
 * projects.spec.ts — unit tests for the paymentType field at the create/update
 * WRITE boundary (task-drop-share-override-and-receiver, review round 1 LOW-1).
 *
 * `createProjectSchema.paymentType` / `updateProjectSchema.paymentType` use a
 * non-type-predicate `.refine()` (see `paymentTypeStringSchema` in `./projects`)
 * so an unknown value is rejected at RUNTIME (Zod parse fails → the controller's
 * global ZodExceptionFilter turns this into a 400) while the Zod-INFERRED TS
 * type of the field stays plain `string | null | undefined` — NOT narrowed to
 * the 3-member `ProjectPaymentType` union. This is deliberate: the current
 * create/edit project forms in `apps/web` still submit free text for this field
 * (`value.paymentType.trim() || null`, typed `string | null`) pending a
 * follow-up frontend task that swaps it for a `Select`; narrowing the TYPE here
 * would red the monorepo typecheck for those two files, which are out of
 * Coder's zone-of-write on this task.
 */
import { describe, expect, it } from 'vitest'
import {
  createProjectSchema,
  updateProjectSchema,
  PROJECT_PAYMENT_TYPES,
  archivePendingTransactionSchema,
  archiveImpactSchema,
} from './projects'

const baseCreate = {
  name: 'Acme Project',
  companyName: 'Acme Corp',
  domain: 'FinTech',
  startDate: '2026-01-01T00:00:00.000Z',
  seniorId: 'a0000000-0000-4000-8000-000000000001',
  rate: 3000,
  currency: 'USDT',
}

describe('createProjectSchema.paymentType — runtime-strict, type-loose (LOW-1)', () => {
  it.each(PROJECT_PAYMENT_TYPES)('accepts the valid enum member %s', (value) => {
    const result = createProjectSchema.parse({ ...baseCreate, paymentType: value })
    expect(result.paymentType).toBe(value)
  })

  it('accepts undefined (absent — backend defaults to FOP)', () => {
    const result = createProjectSchema.parse({ ...baseCreate })
    expect(result.paymentType).toBeUndefined()
  })

  it('accepts null', () => {
    const result = createProjectSchema.parse({ ...baseCreate, paymentType: null })
    expect(result.paymentType).toBeNull()
  })

  it('rejects an invalid free-text value at parse time (400 via ZodExceptionFilter)', () => {
    expect(() => createProjectSchema.parse({ ...baseCreate, paymentType: 'Crypto USDT' })).toThrow()
  })

  it('rejects a value over 100 chars', () => {
    expect(() =>
      createProjectSchema.parse({ ...baseCreate, paymentType: 'x'.repeat(101) }),
    ).toThrow()
  })
})

describe('updateProjectSchema.paymentType — runtime-strict, type-loose (LOW-1)', () => {
  it.each(PROJECT_PAYMENT_TYPES)('accepts the valid enum member %s', (value) => {
    const result = updateProjectSchema.parse({ paymentType: value })
    expect(result.paymentType).toBe(value)
  })

  it('accepts undefined (absent — leave unchanged)', () => {
    const result = updateProjectSchema.parse({})
    expect(result.paymentType).toBeUndefined()
  })

  it('rejects an invalid free-text value at parse time', () => {
    expect(() => updateProjectSchema.parse({ paymentType: 'gig' })).toThrow()
  })
})

// task-archive-pending-modal (AC2/AC8): the "what stays hanging" warning row
// shape, and the union it plugs into.
describe('archivePendingTransactionSchema — AC1/AC2 accrual kinds', () => {
  const base = {
    id: 'a0000000-0000-4000-8000-000000000009',
    salaryMonth: null,
    txDate: null,
    amount: '1500.00',
    currency: 'USD',
  }

  it.each(['SALARY', 'SENIOR_INCOME', 'DROP_INCOME'] as const)(
    'accepts type=%s (the exact three AC1 categories, no more, no fewer)',
    (type) => {
      const result = archivePendingTransactionSchema.parse({ ...base, type })
      expect(result.type).toBe(type)
    },
  )

  it('rejects a type outside the three accrual kinds — this schema is not a generic transaction type', () => {
    expect(() => archivePendingTransactionSchema.parse({ ...base, type: 'PAYOUT' })).toThrow()
  })

  it('rejects an empty type (the whole enum emptied out)', () => {
    expect(() => archivePendingTransactionSchema.parse({ ...base, type: '' })).toThrow()
  })

  it('parses a SALARY row carrying salaryMonth (txDate null)', () => {
    const result = archivePendingTransactionSchema.parse({
      ...base,
      type: 'SALARY',
      salaryMonth: '2026-07',
    })
    expect(result.salaryMonth).toBe('2026-07')
    expect(result.txDate).toBeNull()
  })

  it('parses a SENIOR_INCOME row carrying txDate (salaryMonth null)', () => {
    const result = archivePendingTransactionSchema.parse({
      ...base,
      type: 'SENIOR_INCOME',
      txDate: '2026-07-15T00:00:00.000Z',
    })
    expect(result.txDate).toBeInstanceOf(Date)
    expect(result.salaryMonth).toBeNull()
  })

  it('requires every field — an empty object does not parse', () => {
    expect(() => archivePendingTransactionSchema.parse({})).toThrow()
  })
})

describe('archiveImpactSchema — user/team variants carry pendingTransactions + projectNames', () => {
  it('parses a SENIOR user-impact with pendingTransactions + projectNames', () => {
    const result = archiveImpactSchema.parse({
      type: 'user',
      role: 'SENIOR',
      isPaired: true,
      teamName: 'Team X',
      projectsCount: 1,
      projectNames: ['Project A'],
      juniorsAffected: 1,
      hrAccountantsOnTeam: 2,
      pendingTransactions: [
        {
          id: 'a0000000-0000-4000-8000-000000000001',
          type: 'SENIOR_INCOME',
          salaryMonth: null,
          txDate: '2026-07-15T00:00:00.000Z',
          amount: '4000.00',
          currency: 'USD',
        },
      ],
    })
    expect(result.type).toBe('user')
    const userResult = result as Extract<typeof result, { type: 'user' }>
    expect(userResult.pendingTransactions).toHaveLength(1)
    expect(userResult.projectNames).toEqual(['Project A'])
  })

  it('parses a user-impact with pendingTransactions omitted (back-compat — old shape still parses)', () => {
    const result = archiveImpactSchema.parse({ type: 'user', role: 'ADMIN', noDependencies: true })
    expect(result.type).toBe('user')
  })

  it('parses a team-impact carrying pendingTransactions + projectNames forwarded from the senior/drop', () => {
    const result = archiveImpactSchema.parse({
      type: 'team',
      isPaired: true,
      teamName: 'Team X',
      seniorName: 'Senior One',
      projectsCount: 1,
      projectNames: ['Project A'],
      membersAffected: 2,
      pendingTransactions: [
        {
          id: 'a0000000-0000-4000-8000-000000000002',
          type: 'SALARY',
          salaryMonth: '2026-07',
          txDate: null,
          amount: '1500.00',
          currency: 'USD',
        },
      ],
    })
    expect(result.type).toBe('team')
    const teamResult = result as Extract<typeof result, { type: 'team' }>
    expect(teamResult.pendingTransactions).toHaveLength(1)
  })

  it('rejects a pendingTransactions entry with an out-of-union type', () => {
    expect(() =>
      archiveImpactSchema.parse({
        type: 'user',
        role: 'JUNIOR',
        projectsCount: 0,
        pendingTransactions: [
          {
            id: 'a0000000-0000-4000-8000-000000000003',
            type: 'PAYOUT',
            salaryMonth: null,
            txDate: null,
            amount: '10.00',
            currency: 'USD',
          },
        ],
      }),
    ).toThrow()
  })
})
