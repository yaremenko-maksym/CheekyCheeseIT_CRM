import { describe, expect, it } from 'vitest'
import { COMPANY_INFO } from './invoice-company-info.const'

describe('COMPANY_INFO', () => {
  it('is the hardcoded company identity handed to the invoice PDF', () => {
    expect(COMPANY_INFO).toEqual({ name: 'CheekyCheeseIT', address: 'Україна, м. Київ' })
  })
})
