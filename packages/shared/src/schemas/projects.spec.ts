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
import { createProjectSchema, updateProjectSchema, PROJECT_PAYMENT_TYPES } from './projects'

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
