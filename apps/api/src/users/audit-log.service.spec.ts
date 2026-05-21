import { describe, expect, it } from 'vitest'
import { AuditLogService } from './audit-log.service'

describe('AuditLogService.diff', () => {
  const svc = new AuditLogService(null as never)

  it('returns empty object when before === after', () => {
    expect(svc.diff({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({})
  })

  it('captures changed fields only', () => {
    const d = svc.diff({ a: 1, b: 2 }, { a: 1, b: 3 })
    expect(d).toEqual({ b: { before: 2, after: 3 } })
  })

  it('handles null → value and value → null', () => {
    const d = svc.diff({ x: null }, { x: 'hello' })
    expect(d).toEqual({ x: { before: null, after: 'hello' } })
  })

  it('ignores fields in the blocklist', () => {
    const d = svc.diff({ a: 1, updatedAt: '2020' }, { a: 2, updatedAt: '2021' })
    expect(d).toEqual({ a: { before: 1, after: 2 } })
  })

  it('handles arrays via deep equality', () => {
    expect(svc.diff({ t: ['a', 'b'] }, { t: ['a', 'b'] })).toEqual({})
    expect(svc.diff({ t: ['a'] }, { t: ['a', 'b'] })).toEqual({ t: { before: ['a'], after: ['a', 'b'] } })
  })
})
