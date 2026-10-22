import { describe, expect, it } from 'vitest'
import type { ViewPermissions } from '@crm/shared'
import type { User } from '../database/schema'
import {
  collectExposedRequisiteFields,
  computePendingSeniorShare,
  projectProfileUser,
} from './profile-view.util'

const target = {
  id: 'u-1',
  displayName: 'Senior One',
  pendingSeniorSharePercent: 40,
  seniorSharePercent: 30,
}

describe('computePendingSeniorShare', () => {
  it('returns null for any non-PENDING status', () => {
    expect(computePendingSeniorShare(target, 'NONE')).toBeNull()
    expect(computePendingSeniorShare(target, 'APPROVED')).toBeNull()
    expect(computePendingSeniorShare(target, '')).toBeNull()
  })

  it('builds the DTO from the pending percent when PENDING', () => {
    expect(computePendingSeniorShare(target, 'PENDING')).toEqual({
      percent: 40,
      effectivePercentAfterApproval: 40,
      approverId: 'u-1',
      approverName: 'Senior One',
    })
  })

  it('falls back to the active percent when pending percent is null', () => {
    expect(
      computePendingSeniorShare({ ...target, pendingSeniorSharePercent: null }, 'PENDING'),
    ).toEqual({
      percent: 30,
      effectivePercentAfterApproval: 30,
      approverId: 'u-1',
      approverName: 'Senior One',
    })
  })

  it('keeps a pending percent of 0 (nullish, not falsy, fallback)', () => {
    const r = computePendingSeniorShare({ ...target, pendingSeniorSharePercent: 0 }, 'PENDING')
    expect(r?.percent).toBe(0)
    expect(r?.effectivePercentAfterApproval).toBe(0)
  })
})

describe('collectExposedRequisiteFields', () => {
  it('returns only non-null requisite fields, in canonical order', () => {
    expect(
      collectExposedRequisiteFields({
        id: 'x',
        adminNote: 'secret',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0xabc',
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: 'UA00',
        bankUahRnokpp: null,
        bankUahBankName: 'Mono',
      }),
    ).toEqual(['paymentMethod', 'walletUsdtErc20', 'bankUahIban', 'bankUahBankName'])
  })

  it('returns empty when all requisites are masked', () => {
    expect(
      collectExposedRequisiteFields({
        paymentMethod: null,
        walletUsdtErc20: null,
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
      }),
    ).toEqual([])
  })

  it('treats undefined as not exposed and ignores non-requisite keys', () => {
    expect(collectExposedRequisiteFields({ adminNote: 'x', walletUsdtLabel: 'main' })).toEqual([
      'walletUsdtLabel',
    ])
    expect(collectExposedRequisiteFields({})).toEqual([])
  })

  it('counts empty-string values as exposed (only null/undefined are masked)', () => {
    expect(collectExposedRequisiteFields({ bankUahRnokpp: '' })).toEqual(['bankUahRnokpp'])
  })
})

describe('projectProfileUser', () => {
  const now = new Date('2026-01-02T03:04:05Z')
  const full = {
    id: 'u-1',
    email: 'real@x.test',
    googleId: 'g-secret',
    displayName: 'Persona',
    role: 'SENIOR',
    avatarUrl: 'http://a/png',
    avatarDocumentId: 'doc-1',
    archivedAt: now,
    createdAt: now,
    updatedAt: now,
    phone: '+380',
    telegram: '@tg',
    adminNote: 'note',
    registrationAddress: 'addr',
    legalFullName: 'Legal Name',
    monthlySalary: '1000',
    salaryCurrency: 'USD',
    seniorSharePercent: 30,
    pendingSeniorSharePercent: 40,
    dropSharePercent: 12,
    techStack: ['ts'],
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0xabc',
    walletUsdtLabel: 'main',
    bankUahRecipient: 'Recipient',
    bankUahIban: 'UA00',
    bankUahRnokpp: '123',
    bankUahBankName: 'Mono',
    locale: 'uk',
  } as unknown as User
  const NULLABLE = [
    'phone',
    'telegram',
    'adminNote',
    'registrationAddress',
    'legalFullName',
    'salaryCurrency',
    'dropSharePercent',
    'techStack',
    'paymentMethod',
    'walletUsdtErc20',
    'walletUsdtLabel',
    'bankUahRecipient',
    'bankUahIban',
    'bankUahRnokpp',
    'bankUahBankName',
  ]
  const withAll = (value: null | undefined): User =>
    ({ ...full, ...Object.fromEntries(NULLABLE.map((k) => [k, value])) }) as unknown as User
  const perms = (fields: Record<string, boolean>): ViewPermissions => ({
    tabs: ['overview'],
    actions: [],
    fields,
  })
  const row = { email: 'me@personal.test', canLogin: true }
  const pending = {
    percent: 40,
    effectivePercentAfterApproval: 40,
    approverId: 'u-1',
    approverName: 'Persona',
  }

  const ALL_FLAGS = [
    'realContacts',
    'personalContact',
    'adminNote',
    'fopPii',
    'legalName',
    'salary',
    'share',
    'techStack',
    'requisites',
  ]
  const allOn = Object.fromEntries(ALL_FLAGS.map((f) => [f, true]))

  it('exposes every gated field when all flags are on, never leaking googleId/locale/pendingSeniorSharePercent', () => {
    const out = projectProfileUser(full, perms(allOn), row, pending)
    expect(out).toEqual({
      id: 'u-1',
      displayName: 'Persona',
      role: 'SENIOR',
      avatarUrl: 'http://a/png',
      avatarDocumentId: 'doc-1',
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
      email: 'real@x.test',
      phone: '+380',
      telegram: '@tg',
      personalEmail: 'me@personal.test',
      personalEmailCanLogin: true,
      personalContactVisible: true,
      adminNote: 'note',
      registrationAddress: 'addr',
      legalFullName: 'Legal Name',
      monthlySalary: '1000',
      salaryCurrency: 'USD',
      seniorSharePercent: 30,
      pendingSeniorShare: pending,
      dropSharePercent: 12,
      techStack: ['ts'],
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xabc',
      walletUsdtLabel: 'main',
      bankUahRecipient: 'Recipient',
      bankUahIban: 'UA00',
      bankUahRnokpp: '123',
      bankUahBankName: 'Mono',
    })
    expect(Object.keys(out)).not.toContain('googleId')
    expect(Object.keys(out)).not.toContain('locale')
    expect(Object.keys(out)).not.toContain('pendingSeniorSharePercent')
  })

  it('masks every gated field when no flag is set (missing flags are denied)', () => {
    expect(projectProfileUser(full, perms({}), row, null)).toEqual({
      id: 'u-1',
      displayName: 'Persona',
      role: 'SENIOR',
      avatarUrl: 'http://a/png',
      avatarDocumentId: 'doc-1',
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
      email: null,
      phone: null,
      telegram: null,
      personalEmail: null,
      personalEmailCanLogin: null,
      personalContactVisible: false,
      adminNote: null,
      registrationAddress: null,
      legalFullName: null,
      monthlySalary: null,
      salaryCurrency: null,
      seniorSharePercent: 0,
      pendingSeniorShare: null,
      dropSharePercent: null,
      techStack: null,
      paymentMethod: null,
      walletUsdtErc20: null,
      walletUsdtLabel: null,
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
    })
  })

  it('treats explicit false flags the same as missing', () => {
    const off = Object.fromEntries(ALL_FLAGS.map((f) => [f, false]))
    expect(projectProfileUser(full, perms(off), row, null)).toEqual(
      projectProfileUser(full, perms({}), row, null),
    )
  })

  it.each([
    ['realContacts', ['email', 'phone', 'telegram']],
    ['personalContact', ['personalEmail', 'personalEmailCanLogin', 'personalContactVisible']],
    ['adminNote', ['adminNote']],
    ['fopPii', ['registrationAddress']],
    ['legalName', ['legalFullName']],
    ['salary', ['monthlySalary', 'salaryCurrency']],
    ['share', ['seniorSharePercent', 'dropSharePercent']],
    ['techStack', ['techStack']],
    [
      'requisites',
      [
        'paymentMethod',
        'walletUsdtErc20',
        'walletUsdtLabel',
        'bankUahRecipient',
        'bankUahIban',
        'bankUahRnokpp',
        'bankUahBankName',
      ],
    ],
  ])('flag %s opens exactly its own fields', (flag, opened) => {
    const masked: Record<string, unknown> = { ...projectProfileUser(full, perms({}), row, null) }
    const out: Record<string, unknown> = {
      ...projectProfileUser(full, perms({ [flag]: true }), row, null),
    }
    const changed = Object.keys(out).filter(
      (k) => JSON.stringify(out[k]) !== JSON.stringify(masked[k]),
    )
    expect(changed.sort()).toEqual([...opened].sort())
  })

  it('requisitesExcludeWallet hides destination fields but keeps paymentMethod', () => {
    const out = projectProfileUser(
      full,
      perms({ requisites: true, requisitesExcludeWallet: true }),
      row,
      null,
    )
    expect(out.paymentMethod).toBe('USDT_ERC20')
    expect(out.walletUsdtErc20).toBeNull()
    expect(out.walletUsdtLabel).toBeNull()
    expect(out.bankUahRecipient).toBeNull()
    expect(out.bankUahIban).toBeNull()
    expect(out.bankUahRnokpp).toBeNull()
    expect(out.bankUahBankName).toBeNull()
  })

  it('requisitesExcludeWallet=false without requisites exposes nothing', () => {
    const out = projectProfileUser(full, perms({ requisitesExcludeWallet: false }), row, null)
    expect(out.paymentMethod).toBeNull()
    expect(out.walletUsdtErc20).toBeNull()
    expect(out.bankUahIban).toBeNull()
  })

  it('normalises null and undefined target columns to null under open gates', () => {
    for (const t of [withAll(null), withAll(undefined)]) {
      const out: Record<string, unknown> = {
        ...projectProfileUser(t, perms(allOn), undefined, null),
      }
      for (const k of NULLABLE) expect(out[k]).toBeNull()
      expect(out.personalEmail).toBeNull()
      expect(out.personalEmailCanLogin).toBeNull()
      expect(out.personalContactVisible).toBe(true)
    }
  })

  it('personalEmailCanLogin keeps false (not coerced to null)', () => {
    const out = projectProfileUser(
      full,
      perms({ personalContact: true }),
      { email: 'p@x.test', canLogin: false },
      null,
    )
    expect(out.personalEmailCanLogin).toBe(false)
  })

  it('ignores the personal row when personalContact is off', () => {
    const out = projectProfileUser(full, perms({ realContacts: true }), row, null)
    expect(out.personalEmail).toBeNull()
    expect(out.personalEmailCanLogin).toBeNull()
  })

  it('passes pendingSeniorShare through unchanged (gating is the caller’s)', () => {
    expect(projectProfileUser(full, perms({}), undefined, pending).pendingSeniorShare).toBe(pending)
    expect(projectProfileUser(full, perms({}), undefined, null).pendingSeniorShare).toBeNull()
  })
})
