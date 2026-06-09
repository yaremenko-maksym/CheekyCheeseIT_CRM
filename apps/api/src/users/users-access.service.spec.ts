import { describe, expect, it, beforeEach, vi } from 'vitest'
import { UsersAccessService } from './users-access.service'
import type { User } from '../database/schema'

const makeUser = (overrides: Partial<User>): User =>
  ({
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
  }) as User

describe('UsersAccessService.getViewPermissions', () => {
  let service: UsersAccessService

  beforeEach(() => {
    service = new UsersAccessService({ db: {} } as never)
    // Mock the private DB-helper methods so tests don't hit a real DB
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(false)
    ;(service as unknown as Record<string, unknown>).isSeniorViewingOwnProjectMember = vi
      .fn()
      .mockResolvedValue(false)
    ;(service as unknown as Record<string, unknown>).isJuniorUnderSenior = vi
      .fn()
      .mockResolvedValue(false)
  })

  it('ADMIN viewing JUNIOR sees 7 tabs including contract (no Собеседования, no audit)', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'jr-id', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(
      expect.arrayContaining([
        'overview',
        'finance',
        'projects',
        'team',
        'requisites',
        'documents',
        'contract',
      ]),
    )
    expect(p.tabs).not.toContain('interviews')
    expect(p.tabs).not.toContain('audit')
    expect(p.tabs).toHaveLength(7)
  })

  it('ADMIN viewing SENIOR has 7 tabs — contract tab added, interviews moved to header link, no audit', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).not.toContain('interviews')
    expect(p.tabs).not.toContain('audit')
    expect(p.tabs).toContain('documents')
    expect(p.tabs).toContain('contract')
    expect(p.tabs).toHaveLength(7)
  })

  it('HR viewing SENIOR in own team — no finance, no requisites, no audit', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
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

  it('SELF — SENIOR sees own tabs (interviews moved to header link, no audit)', async () => {
    const senior = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(senior, senior)
    expect(p.tabs).toEqual(
      expect.arrayContaining([
        'overview',
        'finance',
        'projects',
        'team',
        'requisites',
        'documents',
      ]),
    )
    expect(p.tabs).not.toContain('interviews')
    expect(p.tabs).not.toContain('audit')
    // Negative-regression guard: 'contract' tab is ADMIN-only (A3-2).
    // A SENIOR viewing their OWN profile must never see the contract editor tab —
    // it is only surfaced when an ADMIN views another user's profile.
    expect(p.tabs).not.toContain('contract')
  })

  it('SELF — HR sees own tabs without contract (ADMIN-only tab)', async () => {
    const hr = makeUser({ id: 'hr-id', role: 'HR' })
    const p = await service.getViewPermissions(hr, hr)
    // Negative-regression guard: 'contract' tab must not appear on SELF views
    // for any non-ADMIN role (A3-2 RBAC: only ADMIN viewing others gets contract tab).
    expect(p.tabs).not.toContain('contract')
  })

  it('SELF — JUNIOR sees own tabs without contract (ADMIN-only tab)', async () => {
    const junior = makeUser({ id: 'jr-id', role: 'JUNIOR' })
    const p = await service.getViewPermissions(junior, junior)
    expect(p.tabs).not.toContain('contract')
  })

  it('ADMIN SELF does NOT include audit tab (audit tab removed from all roles)', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const p = await service.getViewPermissions(admin, admin)
    expect(p.tabs).not.toContain('audit')
  })

  it('ADMIN has all 6 actions on others (manage-team / reassign-project removed)', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'jr-id', role: 'JUNIOR' })
    const p = await service.getViewPermissions(admin, target)
    expect(p.actions).toEqual(
      expect.arrayContaining([
        'edit-profile',
        'change-role',
        'change-salary',
        'change-requisites',
        'set-note',
        'archive',
      ]),
    )
    expect(p.actions).not.toContain('manage-team')
    expect(p.actions).not.toContain('reassign-project')
    expect(p.actions).toHaveLength(6)
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

  it('SENIOR viewing JUNIOR member of their project — sees overview/projects/team', async () => {
    ;(service as unknown as Record<string, unknown>).isSeniorViewingOwnProjectMember = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'sr1', role: 'SENIOR' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(['overview', 'projects', 'team'])
  })

  it('SENIOR viewing unrelated JUNIOR — no tabs', async () => {
    // isSeniorViewingOwnProjectMember returns false (default mock)
    const viewer = makeUser({ id: 'sr1', role: 'SENIOR' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('JUNIOR viewing their project SENIOR — gets overview/projects/team + fields.legend=true', async () => {
    ;(service as unknown as Record<string, unknown>).isJuniorUnderSenior = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(['overview', 'projects', 'team'])
    expect(p.fields.legend).toBe(true)
  })

  it('JUNIOR viewing unrelated SENIOR — no tabs', async () => {
    // isJuniorUnderSenior returns false (default mock)
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('JUNIOR viewing another JUNIOR — no tabs (unchanged)', async () => {
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'jr2', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('ADMIN viewing SENIOR — fields.legend=true', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const senior = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(admin, senior)
    expect(p.fields.legend).toBe(true)
  })

  it('ADMIN viewing JUNIOR — fields.legend is falsy', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const junior = makeUser({ id: 'jr-id', role: 'JUNIOR' })
    const p = await service.getViewPermissions(admin, junior)
    expect(p.fields.legend).toBeFalsy()
  })

  it('HR viewing SENIOR in own team — fields.legend=true', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const hr = makeUser({ id: 'hr-id', role: 'HR' })
    const senior = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(hr, senior)
    expect(p.fields.legend).toBe(true)
  })

  it('SENIOR viewing self — fields.legend=true', async () => {
    const senior = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(senior, senior)
    expect(p.fields.legend).toBe(true)
  })
})
