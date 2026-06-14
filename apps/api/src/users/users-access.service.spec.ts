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
    // Real private method is `isJuniorUnderLegendSubject` (renamed from the old
    // `isJuniorUnderSenior` to cover SENIOR + DROP). Mocking the OLD name was a
    // silent no-op: the real DB-backed method stayed live against the empty `db`
    // mock, so the JUNIOR-under-legend masking branch (:161) was never truly
    // exercised by these unit tests (HIGH-2).
    ;(service as unknown as Record<string, unknown>).isJuniorUnderLegendSubject = vi
      .fn()
      .mockResolvedValue(false)
    // task-drop-profile-lockdown: the isDropInTargetTeam helper was DELETED — DROP
    // has no access to any other user's profile, so there is no own-team lookup to
    // mock. DROP→non-self always yields zero tabs (asserted below).
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
    // Negative-regression guard: 'contract' tab must not appear on SENIOR self-view.
    // Contract is surfaced: (a) ADMIN viewing another user, or (b) DROP self-view
    // (UT finding 3a: DROP has a signed employee_contract). SENIOR self = neither case.
    expect(p.tabs).not.toContain('contract')
  })

  it('SELF — HR sees own tabs without contract (contract only for ADMIN-viewing-others and DROP self)', async () => {
    const hr = makeUser({ id: 'hr-id', role: 'HR' })
    const p = await service.getViewPermissions(hr, hr)
    // Negative-regression guard: 'contract' tab must not appear on HR/SENIOR/JUNIOR/ACCOUNTANT self views.
    // ADMIN viewing others gets contract tab; DROP self also gets contract tab (UT finding 3a).
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

  // RBAC rule #1: SENIOR must never see JUNIOR profile regardless of project membership.
  // isSeniorViewingOwnProjectMember is never called when target.role === 'JUNIOR'.
  it('SENIOR viewing JUNIOR from their own project — zero tabs (profile blocked per RBAC #1)', async () => {
    const spy = vi.fn().mockResolvedValue(true)
    ;(service as unknown as Record<string, unknown>).isSeniorViewingOwnProjectMember = spy
    const viewer = makeUser({ id: 'sr1', role: 'SENIOR' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
    // The DB helper should NOT be called — short-circuit before the check
    expect(spy).not.toHaveBeenCalled()
  })

  it('SENIOR viewing unrelated JUNIOR — no tabs', async () => {
    // isSeniorViewingOwnProjectMember returns false (default mock)
    const viewer = makeUser({ id: 'sr1', role: 'SENIOR' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  // task-junior-ux-1-backend §2 (SENIOR→SENIOR side-fix): SENIOR must NOT view
  // profiles of other SENIORs or DROPs. Zero tabs regardless of project membership.
  // This closes the gap where isSeniorViewingOwnProjectMember was called for
  // non-JUNIOR targets — potentially exposing SENIOR/DROP identity to peers.
  it('SENIOR viewing another SENIOR — zero tabs (identity isolation, task-junior-ux-1-backend §2)', async () => {
    // Even if isSeniorViewingOwnProjectMember returns true (same-project senior),
    // the target is non-JUNIOR so the code must not enter the project-member path.
    const spy = vi.fn().mockResolvedValue(true)
    ;(service as unknown as Record<string, unknown>).isSeniorViewingOwnProjectMember = spy
    const viewer = makeUser({ id: 'sr1', role: 'SENIOR' })
    const target = makeUser({ id: 'sr2', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
    // DB helper must NOT be called — the non-JUNIOR gate short-circuits before it
    expect(spy).not.toHaveBeenCalled()
  })

  it('SENIOR viewing a DROP user — zero tabs (identity isolation, task-junior-ux-1-backend §2)', async () => {
    const spy = vi.fn().mockResolvedValue(true)
    ;(service as unknown as Record<string, unknown>).isSeniorViewingOwnProjectMember = spy
    const viewer = makeUser({ id: 'sr1', role: 'SENIOR' })
    const target = makeUser({ id: 'drop1', role: 'DROP' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  // Regression: ADMIN/HR visibility of JUNIOR must NOT be broken by RBAC #1.
  it('ADMIN viewing JUNIOR — keeps full tabs (regression)', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toContain('overview')
    expect(p.tabs).toContain('finance')
    expect(p.tabs).toContain('contract')
  })

  it('HR viewing JUNIOR in their team — keeps tabs (regression)', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toContain('overview')
  })

  // task-junior-ut-round2 §3 (security, data-leak): JUNIOR self-view is an
  // EXPLICIT allow-list — overview/requisites ONLY. Projects/Team/Finance/Documents
  // are removed: they surface senior/drop identity and project/team internals.
  // task-junior-ut-round3 §6a: 'documents' also removed from JUNIOR self-view
  // (data-privacy: /crm/project hub is the junior's primary project surface).
  it('JUNIOR viewing themselves — allow-list overview/requisites only (no documents/projects/team/finance)', async () => {
    const junior = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(junior, junior)
    expect(p.tabs).toEqual(['overview', 'requisites'])
    expect(p.tabs).not.toContain('documents')
    expect(p.tabs).not.toContain('projects')
    expect(p.tabs).not.toContain('team')
    expect(p.tabs).not.toContain('finance')
  })

  it('JUNIOR self — own salary still visible (fields.salary), requisites visible — not a leak of own data', async () => {
    const junior = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(junior, junior)
    expect(p.fields.salary).toBe(true)
    expect(p.fields.requisites).toBe(true)
    // share is for SENIOR/ADMIN/DROP — JUNIOR self must not have it
    expect(p.fields.share).toBe(false)
  })

  it('SELF — SENIOR/HR/ACCOUNTANT keep projects/team (allow-list change is JUNIOR-only)', async () => {
    for (const role of ['SENIOR', 'HR', 'ACCOUNTANT'] as const) {
      const u = makeUser({ id: `${role}-id`, role })
      const p = await service.getViewPermissions(u, u)
      expect(p.tabs, `${role} self should keep projects`).toContain('projects')
      expect(p.tabs, `${role} self should keep team`).toContain('team')
      expect(p.tabs, `${role} self should keep finance`).toContain('finance')
    }
  })

  // task-drop-profile-rbac-r2 (Finding A): DROP self-view is now an EXPLICIT
  // allow-list — overview + requisites ONLY. finance/team/contract were removed:
  //   - finance  → DROP sees финансы on /crm/routing, not in a profile tab.
  //   - team     → reachable via /crm/team/$teamId, not as a tab.
  //   - contract → DROP reads контракт on /crm/documents (page-not-tab model).
  // documents was already removed (dedicated /crm/documents page). projects was
  // already removed (routing hub). SENIOR/ADMIN profiles are NOT affected.
  it('SELF — DROP sees ONLY overview + requisites (Finding A: finance/team/contract/documents/projects removed)', async () => {
    const drop = makeUser({ id: 'drop-id', role: 'DROP' })
    const p = await service.getViewPermissions(drop, drop)
    expect(p.tabs).toEqual(['overview', 'requisites'])
    expect(p.tabs).not.toContain('finance')
    expect(p.tabs).not.toContain('team')
    expect(p.tabs).not.toContain('contract')
    expect(p.tabs).not.toContain('documents')
    expect(p.tabs).not.toContain('projects')
  })

  // Regression: SENIOR/ADMIN self-view still includes projects (DROP change is DROP-only).
  it('SELF — SENIOR still has projects tab (not affected by DROP exclusion)', async () => {
    const senior = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(senior, senior)
    expect(p.tabs).toContain('projects')
  })

  // Regression: ADMIN viewing DROP target still gets full tabs (ADMIN branch unchanged).
  it('ADMIN viewing DROP — still gets all 6 standard tabs including projects', async () => {
    const admin = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const drop = makeUser({ id: 'drop-id', role: 'DROP' })
    const p = await service.getViewPermissions(admin, drop)
    expect(p.tabs).toContain('projects')
    expect(p.tabs).toContain('finance')
    expect(p.tabs).toContain('requisites')
  })

  it('JUNIOR viewing their project SENIOR — gets overview/projects/team + fields.legend=true', async () => {
    // Method was renamed: isJuniorUnderSenior → isJuniorUnderLegendSubject (covers SENIOR + DROP)
    ;(service as unknown as Record<string, unknown>).isJuniorUnderLegendSubject = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(['overview', 'projects', 'team'])
    expect(p.fields.legend).toBe(true)
  })

  it('JUNIOR viewing unrelated SENIOR — no tabs', async () => {
    // isJuniorUnderLegendSubject returns false (default mock)
    ;(service as unknown as Record<string, unknown>).isJuniorUnderLegendSubject = vi
      .fn()
      .mockResolvedValue(false)
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  // HIGH-2: with the mock correctly wired to isJuniorUnderLegendSubject, flipping
  // it to TRUE must drive the masking branch (:161) — full identity-masking
  // assertion in one place so a regression in tabs OR field-flags fails here.
  it('JUNIOR under legend subject (mock=true) — masked tabs/fields/actions (legend boundary)', async () => {
    const spy = vi.fn().mockResolvedValue(true)
    ;(service as unknown as Record<string, unknown>).isJuniorUnderLegendSubject = spy
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR', techStack: 'React, Node' })
    const p = await service.getViewPermissions(viewer, target)

    // The masking branch was actually entered (proves the mock is wired now).
    expect(spy).toHaveBeenCalledWith('jr1', 'sr1')
    // Persona-only tabs.
    expect(p.tabs).toEqual(['overview', 'projects', 'team'])
    // Legend persona surfaced; real identity hidden.
    expect(p.fields.legend).toBe(true)
    expect(p.fields.realContacts).toBe(false)
    expect(p.fields.fopPii).toBe(false)
    expect(p.fields.adminNote).toBe(false)
    expect(p.fields.techStack).toBe(true)
    expect(p.fields.registrationDate).toBe(true)
    // JUNIOR has no mutating actions on anyone.
    expect(p.actions).toEqual([])
  })

  it('JUNIOR under legend subject — DROP target (mock=true) — masked realContacts/legend', async () => {
    const spy = vi.fn().mockResolvedValue(true)
    ;(service as unknown as Record<string, unknown>).isJuniorUnderLegendSubject = spy
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'drop1', role: 'DROP' })
    const p = await service.getViewPermissions(viewer, target)
    expect(spy).toHaveBeenCalledWith('jr1', 'drop1')
    expect(p.tabs).toEqual(['overview', 'projects', 'team'])
    expect(p.fields.legend).toBe(true)
    expect(p.fields.realContacts).toBe(false)
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

  it('SENIOR viewing self — fields.legend=false (subject excluded from own legend)', async () => {
    // New model: subject cannot view their own legend
    const senior = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(senior, senior)
    expect(p.fields.legend).toBe(false)
  })

  it('ADMIN viewing DROP — fields.legend=true', async () => {
    const adminUser = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const dropUser = makeUser({ id: 'drop-id', role: 'DROP' })
    const p = await service.getViewPermissions(adminUser, dropUser)
    expect(p.fields.legend).toBe(true)
  })

  it('HR viewing DROP in own team — fields.legend=true', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const hrUser = makeUser({ id: 'hr-id', role: 'HR' })
    const dropUser = makeUser({ id: 'drop-id', role: 'DROP' })
    const p = await service.getViewPermissions(hrUser, dropUser)
    expect(p.fields.legend).toBe(true)
  })

  // ── RBAC A01 (2026-06-10): PII / contact field flags ──
  // These exercise the REAL getViewPermissions logic (only the DB-helper lookups
  // are stubbed) so a regression in flag wiring is caught — closing the gap where
  // buildProfileView tests mocked getViewPermissions entirely.
  it('JUNIOR viewing their project SENIOR — realContacts/fopPii/adminNote all false (legend boundary)', async () => {
    ;(service as unknown as Record<string, unknown>).isJuniorUnderLegendSubject = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.realContacts).toBe(false)
    expect(p.fields.fopPii).toBe(false)
    expect(p.fields.adminNote).toBe(false)
  })

  it('JUNIOR viewing their project DROP — realContacts false (legend boundary)', async () => {
    ;(service as unknown as Record<string, unknown>).isJuniorUnderLegendSubject = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const target = makeUser({ id: 'drop1', role: 'DROP' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.realContacts).toBe(false)
  })

  it('ADMIN viewing another user — adminNote/fopPii/realContacts all true', async () => {
    const viewer = makeUser({ id: 'admin1', role: 'ADMIN' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.adminNote).toBe(true)
    expect(p.fields.fopPii).toBe(true)
    expect(p.fields.realContacts).toBe(true)
  })

  it('ADMIN viewing self — adminNote false, fopPii true (own FOP), realContacts true', async () => {
    const admin = makeUser({ id: 'admin1', role: 'ADMIN' })
    const p = await service.getViewPermissions(admin, admin)
    expect(p.fields.adminNote).toBe(false)
    expect(p.fields.fopPii).toBe(true)
    expect(p.fields.realContacts).toBe(true)
  })

  it('SELF (SENIOR) — fopPii/realContacts true, adminNote false', async () => {
    const senior = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(senior, senior)
    expect(p.fields.fopPii).toBe(true)
    expect(p.fields.realContacts).toBe(true)
    expect(p.fields.adminNote).toBe(false)
  })

  it('ACCOUNTANT viewing another — fopPii false, adminNote false, realContacts true', async () => {
    const viewer = makeUser({ id: 'acc1', role: 'ACCOUNTANT' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.fopPii).toBe(false)
    expect(p.fields.adminNote).toBe(false)
    expect(p.fields.realContacts).toBe(true)
  })

  it('HR viewing SENIOR in own team — fopPii false, adminNote false, realContacts true', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.fopPii).toBe(false)
    expect(p.fields.adminNote).toBe(false)
    expect(p.fields.realContacts).toBe(true)
  })

  // ── task-junior-ut-round2 §6 — projectCredentials / editCredentials flags ──
  it('ADMIN viewing JUNIOR — projectCredentials/editCredentials true', async () => {
    const admin = makeUser({ id: 'admin1', role: 'ADMIN' })
    const junior = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(admin, junior)
    expect(p.fields.projectCredentials).toBe(true)
    expect(p.fields.editCredentials).toBe(true)
  })

  it('ADMIN viewing SENIOR — projectCredentials/editCredentials falsy (junior-only)', async () => {
    const admin = makeUser({ id: 'admin1', role: 'ADMIN' })
    const senior = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(admin, senior)
    expect(p.fields.projectCredentials).toBeFalsy()
    expect(p.fields.editCredentials).toBeFalsy()
  })

  it('ADMIN self — projectCredentials/editCredentials falsy (never self)', async () => {
    const admin = makeUser({ id: 'admin1', role: 'ADMIN' })
    const p = await service.getViewPermissions(admin, admin)
    expect(p.fields.projectCredentials).toBeFalsy()
    expect(p.fields.editCredentials).toBeFalsy()
  })

  it('HR (in team) viewing JUNIOR — projectCredentials/editCredentials true', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const hr = makeUser({ id: 'hr1', role: 'HR' })
    const junior = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(hr, junior)
    expect(p.fields.projectCredentials).toBe(true)
    expect(p.fields.editCredentials).toBe(true)
  })

  it('HR (NOT in team) viewing JUNIOR — no tabs, no credential flags', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(false)
    const hr = makeUser({ id: 'hr1', role: 'HR' })
    const junior = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(hr, junior)
    expect(p.fields.projectCredentials).toBeFalsy()
    expect(p.fields.editCredentials).toBeFalsy()
  })

  it('JUNIOR self — no projectCredentials flag (self does not see the section)', async () => {
    const junior = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(junior, junior)
    expect(p.fields.projectCredentials).toBeFalsy()
  })

  // ── task-drop-profile-lockdown: DROP has NO access to ANY other profile ──
  // The #202 "own-team open card" (Finding B) was removed. DROP→non-self ALWAYS
  // yields zero tabs → 403. DROP self-view (overview+requisites, Finding A) is
  // unchanged. Team page (/crm/team/$teamId) shows teammate contacts inline —
  // the profile surface is fully closed for DROP.

  it('DROP viewing own-team SENIOR — zero tabs → 403 (open card removed)', async () => {
    const viewer = makeUser({ id: 'drop1', role: 'DROP' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
    expect(p.actions).toEqual([])
    // No persona/legend leak either — there is no view to render.
    expect(p.fields.legend).toBeFalsy()
  })

  it('DROP viewing own-team JUNIOR — zero tabs → 403', async () => {
    const viewer = makeUser({ id: 'drop1', role: 'DROP' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('DROP viewing another DROP — zero tabs → 403', async () => {
    const viewer = makeUser({ id: 'drop1', role: 'DROP' })
    const target = makeUser({ id: 'drop2', role: 'DROP' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('DROP viewing a NON-teammate — zero tabs → 403 (unchanged for outsiders)', async () => {
    const viewer = makeUser({ id: 'drop1', role: 'DROP' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('DROP self-view — overview + requisites ONLY (Finding A, unchanged)', async () => {
    const drop = makeUser({ id: 'drop1', role: 'DROP' })
    const p = await service.getViewPermissions(drop, drop)
    expect(p.tabs).toEqual(['overview', 'requisites'])
  })

  // Regression: closing the DROP profile must NOT weaken access for OTHER roles.
  // A SENIOR viewing a teammate still gets zero tabs (handled by the isSenior branch).
  it('SENIOR viewing own-team SENIOR — still zero tabs (unaffected by DROP lockdown)', async () => {
    const viewer = makeUser({ id: 'sr1', role: 'SENIOR' })
    const target = makeUser({ id: 'sr2', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })
})
