import { describe, expect, it, beforeEach, vi } from 'vitest'
import { UsersAccessService } from './users-access.service'
import type { User } from '../database/schema'

const makeUser = (overrides: Partial<User>): User => ({
  id: overrides.id ?? '00000000-0000-0000-0000-000000000000',
  email: 'a@b.c',
  displayName: 'X',
  avatar: null,
  role: 'JUNIOR',
  googleId: null,
  telegram: null,
  phone: null,
  techStack: null,
  paymentMethod: null,
  walletUsdtErc20: null,
  walletUsdtLabel: null,
  bankUahRecipient: null,
  bankUahIban: null,
  bankUahRnokpp: null,
  bankUahBankName: null,
  seniorSharePercent: 26,
  monthlySalary: null,
  archivedAt: null,
  adminNote: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as User)

describe('UsersAccessService.getViewPermissions', () => {
  let service: UsersAccessService

  beforeEach(() => {
    service = new UsersAccessService({ db: {} } as never)
    // Mock the private DB-helper methods so tests don't hit a real DB
    ;(service as any).isHrInTargetTeam = vi.fn().mockResolvedValue(false)
    ;(service as any).isSharedProject = vi.fn().mockResolvedValue(false)
  })

  it('ADMIN viewing JUNIOR sees 6 tabs (no Собеседования)', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'jr-id', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(expect.arrayContaining(['overview', 'finance', 'projects', 'team', 'requisites', 'audit']))
    expect(p.tabs).not.toContain('interviews')
  })

  it('ADMIN viewing SENIOR includes Собеседования (7 tabs)', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toContain('interviews')
    expect(p.tabs).toHaveLength(7)
  })

  it('HR viewing SENIOR in own team — no finance, no requisites, no audit', async () => {
    ;(service as any).isHrInTargetTeam = vi.fn().mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr-id', role: 'HR' })
    const target = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toContain('overview')
    expect(p.tabs).toContain('interviews')
    expect(p.tabs).not.toContain('finance')
    expect(p.tabs).not.toContain('requisites')
    expect(p.tabs).not.toContain('audit')
  })

  it('JUNIOR viewing other JUNIOR — header only (no tabs)', async () => {
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'jr2', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('SELF — SENIOR sees own tabs including Собеседования (no audit)', async () => {
    const senior = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(senior, senior)
    expect(p.tabs).toEqual(expect.arrayContaining(['overview', 'finance', 'projects', 'team', 'interviews', 'requisites']))
    expect(p.tabs).not.toContain('audit')
  })

  it('ADMIN SELF includes audit tab', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const p = await service.getViewPermissions(admin, admin)
    expect(p.tabs).toContain('audit')
  })

  it('ADMIN has all 8 actions on others', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'jr-id', role: 'JUNIOR' })
    const p = await service.getViewPermissions(admin, target)
    expect(p.actions).toEqual(expect.arrayContaining([
      'edit-profile', 'change-role', 'change-salary', 'change-requisites',
      'manage-team', 'reassign-project', 'set-note', 'archive',
    ]))
  })

  it('ADMIN cannot archive themselves', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const p = await service.getViewPermissions(admin, admin)
    expect(p.actions).not.toContain('archive')
  })

  it('non-ADMIN has zero actions', async () => {
    const hr = makeUser({ id: 'hr-id', role: 'HR' })
    const target = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(hr, target)
    expect(p.actions).toEqual([])
  })
})
