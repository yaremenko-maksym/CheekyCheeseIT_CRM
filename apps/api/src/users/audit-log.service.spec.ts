import { describe, expect, it } from 'vitest'
import { AuditLogService, REDACTED_TOKEN, SENSITIVE_FIELDS } from './audit-log.service'

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
    expect(svc.diff({ t: ['a'] }, { t: ['a', 'b'] })).toEqual({
      t: { before: ['a'], after: ['a', 'b'] },
    })
  })

  // ── PII redaction (п.1) ──────────────────────────────────────────────────

  describe('PII redaction', () => {
    it('redacts legalFullName — key present but values replaced with token', () => {
      const d = svc.diff(
        { legalFullName: 'Іваненко Іван Іванович' },
        { legalFullName: 'Петренко Петро Петрович' },
      )
      expect(d).toHaveProperty('legalFullName')
      expect(d['legalFullName']!.before).toBe(REDACTED_TOKEN)
      expect(d['legalFullName']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts email — key present, values redacted', () => {
      const d = svc.diff({ email: 'old@example.com' }, { email: 'new@example.com' })
      expect(d).toHaveProperty('email')
      expect(d['email']!.before).toBe(REDACTED_TOKEN)
      expect(d['email']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts googleId — key present, values redacted', () => {
      const d = svc.diff({ googleId: '111111' }, { googleId: '222222' })
      expect(d).toHaveProperty('googleId')
      expect(d['googleId']!.before).toBe(REDACTED_TOKEN)
      expect(d['googleId']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts phone — key present, values redacted', () => {
      const d = svc.diff({ phone: '+380501234567' }, { phone: '+380671234567' })
      expect(d).toHaveProperty('phone')
      expect(d['phone']!.before).toBe(REDACTED_TOKEN)
      expect(d['phone']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts telegram — key present, values redacted', () => {
      const d = svc.diff({ telegram: '@old_handle' }, { telegram: '@new_handle' })
      expect(d).toHaveProperty('telegram')
      expect(d['telegram']!.before).toBe(REDACTED_TOKEN)
      expect(d['telegram']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts walletUsdtErc20 (USDT ERC-20 address) — key present, values redacted', () => {
      const d = svc.diff({ walletUsdtErc20: '0xAAAA' }, { walletUsdtErc20: '0xBBBB' })
      expect(d).toHaveProperty('walletUsdtErc20')
      expect(d['walletUsdtErc20']!.before).toBe(REDACTED_TOKEN)
      expect(d['walletUsdtErc20']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts walletUsdtLabel — key present, values redacted', () => {
      const d = svc.diff({ walletUsdtLabel: 'My wallet' }, { walletUsdtLabel: 'New wallet' })
      expect(d).toHaveProperty('walletUsdtLabel')
      expect(d['walletUsdtLabel']!.before).toBe(REDACTED_TOKEN)
      expect(d['walletUsdtLabel']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts bankUahRecipient — key present, values redacted', () => {
      const d = svc.diff({ bankUahRecipient: 'ФОП Іваненко' }, { bankUahRecipient: 'ФОП Петренко' })
      expect(d).toHaveProperty('bankUahRecipient')
      expect(d['bankUahRecipient']!.before).toBe(REDACTED_TOKEN)
      expect(d['bankUahRecipient']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts bankUahIban — key present, values redacted', () => {
      const d = svc.diff({ bankUahIban: 'UA1234567890' }, { bankUahIban: 'UA9999999999' })
      expect(d).toHaveProperty('bankUahIban')
      expect(d['bankUahIban']!.before).toBe(REDACTED_TOKEN)
      expect(d['bankUahIban']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts bankUahRnokpp — key present, values redacted', () => {
      const d = svc.diff({ bankUahRnokpp: '1234567890' }, { bankUahRnokpp: '9876543210' })
      expect(d).toHaveProperty('bankUahRnokpp')
      expect(d['bankUahRnokpp']!.before).toBe(REDACTED_TOKEN)
      expect(d['bankUahRnokpp']!.after).toBe(REDACTED_TOKEN)
    })

    it('redacts bankUahBankName — key present, values redacted', () => {
      const d = svc.diff({ bankUahBankName: 'ПриватБанк' }, { bankUahBankName: 'Монобанк' })
      expect(d).toHaveProperty('bankUahBankName')
      expect(d['bankUahBankName']!.before).toBe(REDACTED_TOKEN)
      expect(d['bankUahBankName']!.after).toBe(REDACTED_TOKEN)
    })

    // HIGH-1: adminNote — PII free-text note, must be redacted
    it('redacts adminNote (HIGH-1) — key present, values redacted', () => {
      const d = svc.diff(
        { adminNote: 'Проблемный сотрудник, склонен к опозданиям' },
        { adminNote: 'Исправился, показатели улучшились' },
      )
      expect(d).toHaveProperty('adminNote')
      expect(d['adminNote']!.before).toBe(REDACTED_TOKEN)
      expect(d['adminNote']!.after).toBe(REDACTED_TOKEN)
    })

    // MED-2: monthlySalary — financially-sensitive, must be redacted
    it('redacts monthlySalary (MED-2) — key present, values redacted', () => {
      const d = svc.diff({ monthlySalary: 3000 }, { monthlySalary: 3500 })
      expect(d).toHaveProperty('monthlySalary')
      expect(d['monthlySalary']!.before).toBe(REDACTED_TOKEN)
      expect(d['monthlySalary']!.after).toBe(REDACTED_TOKEN)
    })

    it('mixed diff — sensitive fields redacted, non-sensitive pass through', () => {
      const d = svc.diff(
        {
          displayName: 'Old Name',
          legalFullName: 'Іваненко Іван',
          phone: '+380501111111',
          role: 'JUNIOR',
        },
        {
          displayName: 'New Name',
          legalFullName: 'Петренко Петро',
          phone: '+380672222222',
          role: 'SENIOR',
        },
      )
      // Non-sensitive: real values
      expect(d['displayName']).toEqual({ before: 'Old Name', after: 'New Name' })
      expect(d['role']).toEqual({ before: 'JUNIOR', after: 'SENIOR' })
      // Sensitive: redacted
      expect(d['legalFullName']!.before).toBe(REDACTED_TOKEN)
      expect(d['legalFullName']!.after).toBe(REDACTED_TOKEN)
      expect(d['phone']!.before).toBe(REDACTED_TOKEN)
      expect(d['phone']!.after).toBe(REDACTED_TOKEN)
    })

    it('empty diff when sensitive field unchanged — no entry written', () => {
      const d = svc.diff(
        { legalFullName: 'Іваненко Іван', displayName: 'Same' },
        { legalFullName: 'Іваненко Іван', displayName: 'Same' },
      )
      expect(d).toEqual({})
    })

    it('SENSITIVE_FIELDS set covers all 15 expected fields', () => {
      const expected = [
        'email',
        'googleId',
        'phone',
        'telegram',
        'legalFullName',
        'walletUsdtErc20',
        'walletUsdtLabel',
        'bankUahRecipient',
        'bankUahIban',
        'bankUahRnokpp',
        'bankUahBankName',
        // HIGH-1 + MED-2 additions
        'adminNote',
        'monthlySalary',
        // SEC-08: FOP PII fields
        'registrationAddress',
        'usrRecord',
      ]
      for (const field of expected) {
        expect(SENSITIVE_FIELDS.has(field), `Expected "${field}" in SENSITIVE_FIELDS`).toBe(true)
      }
      expect(SENSITIVE_FIELDS.size).toBe(15)
    })
  })
})
