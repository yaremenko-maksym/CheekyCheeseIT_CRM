import { COMPANY_ACCOUNT_LABEL } from '@crm/shared'
import { isInternalCompanySide, isRegistryConflict } from './finance-predicates.util'

const pgViolation = (constraint: string | undefined) => ({ code: '23505', constraint })

describe('isRegistryConflict', () => {
  it('is true for the active-hash registry index', () => {
    expect(isRegistryConflict(pgViolation('uq_consumed_tx_hashes_active_tx_hash'))).toBe(true)
  })

  it('is true for the legacy registry index (rolling deploy)', () => {
    expect(isRegistryConflict(pgViolation('uq_consumed_tx_hashes_tx_hash'))).toBe(true)
  })

  it('is false for an unrelated unique constraint', () => {
    expect(isRegistryConflict(pgViolation('uq_transactions_salary_idempotency_key'))).toBe(false)
  })

  it('is false for a non-violation error', () => {
    expect(isRegistryConflict(new Error('boom'))).toBe(false)
    expect(isRegistryConflict(undefined)).toBe(false)
  })
})

describe('isInternalCompanySide (RBAC masking boundary)', () => {
  it('is true for the company-account label', () => {
    expect(isInternalCompanySide('u1', COMPANY_ACCOUNT_LABEL, 'SENIOR', null)).toBe(true)
    expect(isInternalCompanySide(null, COMPANY_ACCOUNT_LABEL, null, null)).toBe(true)
  })

  it('is true for COMPANY_ACCOUNT funding with a null or undefined side id', () => {
    expect(isInternalCompanySide(null, 'x', null, 'COMPANY_ACCOUNT')).toBe(true)
    expect(isInternalCompanySide(undefined, 'x', null, 'COMPANY_ACCOUNT')).toBe(true)
  })

  it('is false for COMPANY_ACCOUNT funding when the side has a live non-ADMIN id', () => {
    expect(isInternalCompanySide('u1', 'x', 'SENIOR', 'COMPANY_ACCOUNT')).toBe(false)
  })

  it('is true for a live ADMIN partner', () => {
    expect(isInternalCompanySide('u1', 'Max', 'ADMIN', null)).toBe(true)
  })

  it('is false for ADMIN role without a side id', () => {
    expect(isInternalCompanySide(null, 'Max', 'ADMIN', null)).toBe(false)
    expect(isInternalCompanySide(undefined, 'Max', 'ADMIN', undefined)).toBe(false)
    expect(isInternalCompanySide('', 'Max', 'ADMIN', null)).toBe(false)
  })

  it('is true for an orphaned ADMIN_PERSONAL payer (null or undefined id)', () => {
    expect(isInternalCompanySide(null, 'Deleted Admin', null, 'ADMIN_PERSONAL')).toBe(true)
    expect(isInternalCompanySide(undefined, 'Deleted Admin', null, 'ADMIN_PERSONAL')).toBe(true)
  })

  it('is false for ADMIN_PERSONAL when the side has a live non-ADMIN id', () => {
    expect(isInternalCompanySide('u1', 'Emp', 'SENIOR', 'ADMIN_PERSONAL')).toBe(false)
  })

  it('is false for a normal employee with a live id and no funding marker', () => {
    expect(isInternalCompanySide('u1', 'Emp', 'SENIOR', null)).toBe(false)
    expect(isInternalCompanySide('u1', null, undefined, undefined)).toBe(false)
    expect(isInternalCompanySide(null, null, null, null)).toBe(false)
  })
})
