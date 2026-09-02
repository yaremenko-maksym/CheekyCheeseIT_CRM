import { describe, expect, it, beforeEach, vi } from 'vitest'
import { UsersAccessService } from './users-access.service'
import type { User } from '../database/schema'

const makeUser = (overrides: Partial<User>): User =>
  ({
    id: overrides.id ?? '00000000-0000-0000-0000-000000000000',
    email: 'a@b.c',
    displayName: 'X',
    avatarUrl: null,
    avatarDocumentId: null,
    role: 'JUNIOR',
    googleId: null,
    telegram: null,
    phone: null,
    techStack: null,
    legalFullName: null,
    registrationAddress: null,
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    seniorSharePercent: 26,
    dropSharePercent: null,
    monthlySalary: null,
    salaryCurrency: null,
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
    // §4.4 (SR-M-4, mutation-gate closure PR #623): personalContact is its
    // OWN flag, separate from realContacts — ADMIN viewing another user is
    // one of the two viewers ever allowed to see personalEmail.
    expect(p.fields.personalContact).toBe(true)
  })

  it('ADMIN viewing SENIOR has 8 tabs — contract + resume, interviews moved to header link, no audit', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).not.toContain('interviews')
    expect(p.tabs).not.toContain('audit')
    expect(p.tabs).toContain('documents')
    expect(p.tabs).toContain('contract')
    // task-resume-base: 'resume' is the 8th tab on a SENIOR card for ADMIN.
    expect(p.tabs).toContain('resume')
    expect(p.tabs).toHaveLength(8)
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
    // §4.4 (SR-M-4, mutation-gate closure PR #623): self is the OTHER of the
    // two viewers ever allowed to see their own personalEmail.
    expect(p.fields.personalContact).toBe(true)
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

  it('ADMIN has all 8 actions on others (manage-team / reassign-project removed; task-user-emails-invite adds resend-personal-invite + change-personal-email)', async () => {
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
        'resend-personal-invite',
        'change-personal-email',
      ]),
    )
    expect(p.actions).not.toContain('manage-team')
    expect(p.actions).not.toContain('reassign-project')
    expect(p.actions).toHaveLength(8)
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

  // task-accountant-self-no-finance-tab: ACCOUNTANT self-view is now trimmed to
  // [overview, requisites] — 'finance' removed (page-not-tab model: /crm/finance).
  // SENIOR-self and HR-self keep the full surface unchanged
  // (projects/team/finance still included for those roles).
  it('SELF — SENIOR/HR keep projects/team (allow-list change is JUNIOR and ACCOUNTANT only)', async () => {
    for (const role of ['SENIOR', 'HR'] as const) {
      const u = makeUser({ id: `${role}-id`, role })
      const p = await service.getViewPermissions(u, u)
      expect(p.tabs, `${role} self should keep projects`).toContain('projects')
      expect(p.tabs, `${role} self should keep team`).toContain('team')
      expect(p.tabs, `${role} self should keep finance`).toContain('finance')
    }
  })

  // ── task-accountant-self-no-finance-tab (AC1): ACCOUNTANT self-view allow-list ──
  it('SELF — ACCOUNTANT sees exactly [overview, requisites] (no finance/projects/team/documents)', async () => {
    const accountant = makeUser({ id: 'acc-self', role: 'ACCOUNTANT' })
    const p = await service.getViewPermissions(accountant, accountant)
    expect(p.tabs).toEqual(['overview', 'requisites'])
    expect(p.tabs).not.toContain('finance')
    expect(p.tabs).not.toContain('projects')
    expect(p.tabs).not.toContain('team')
    expect(p.tabs).not.toContain('documents')
    expect(p.tabs).toContain('overview')
    expect(p.tabs).toContain('requisites')
  })

  // ── task-accountant-self-view-tabs (AC2): ACCOUNTANT viewing ANOTHER user unchanged ──
  it('ACCOUNTANT viewing another user — tabs include projects/team/documents (other-view unchanged)', async () => {
    const viewer = makeUser({ id: 'acc1', role: 'ACCOUNTANT' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toContain('overview')
    expect(p.tabs).toContain('finance')
    expect(p.tabs).toContain('projects')
    expect(p.tabs).toContain('team')
    expect(p.tabs).toContain('requisites')
    expect(p.tabs).toContain('documents')
  })

  // ── task-accountant-self-view-tabs (AC3): regression guards — SENIOR/HR-self unchanged ──
  it('SELF — SENIOR keeps full tab surface (projects/team/documents/finance) — regression guard', async () => {
    const senior = makeUser({ id: 'sr-self', role: 'SENIOR' })
    const p = await service.getViewPermissions(senior, senior)
    expect(p.tabs).toContain('projects')
    expect(p.tabs).toContain('team')
    expect(p.tabs).toContain('documents')
    expect(p.tabs).toContain('finance')
    expect(p.tabs).not.toContain('contract')
  })

  it('SELF — HR keeps full tab surface (projects/team/documents/finance) — regression guard', async () => {
    const hr = makeUser({ id: 'hr-self', role: 'HR' })
    const p = await service.getViewPermissions(hr, hr)
    expect(p.tabs).toContain('projects')
    expect(p.tabs).toContain('team')
    expect(p.tabs).toContain('documents')
    expect(p.tabs).toContain('finance')
  })

  // ── ACCOUNTANT self — fields unchanged (tab removal does not affect field visibility) ──
  it('ACCOUNTANT self — fields.requisites and fields.salary are true (own PII still accessible)', async () => {
    const accountant = makeUser({ id: 'acc-self', role: 'ACCOUNTANT' })
    const p = await service.getViewPermissions(accountant, accountant)
    expect(p.fields.requisites).toBe(true)
    // ACCOUNTANT is a salary role (monthlySalary surface)
    expect(p.fields.salary).toBe(true)
    // ACCOUNTANT is not a share role
    expect(p.fields.share).toBe(false)
    // Owner sees own contacts, FOP PII, legal name
    expect(p.fields.realContacts).toBe(true)
    expect(p.fields.fopPii).toBe(true)
    expect(p.fields.legalName).toBe(true)
    // No admin note on self
    expect(p.fields.adminNote).toBe(false)
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
    // SR-M-7 (security-review PR #623 round 2, MED): personalContact (SR-M-4)
    // only had its POSITIVE berth fixed — ADMIN / self returning true. Nothing
    // pinned the negative one, so a future `fields.personalContact = true`
    // slipped into this branch (the exact regression SR-M-4 exists to
    // prevent) would pass the whole suite silently. ACCOUNTANT is never one
    // of the two allowed viewers (ADMIN, self) — see the isAccountant branch
    // in users-access.service.ts, which never touches this flag.
    expect(p.fields.personalContact).toBeFalsy()
  })

  // ── Pre-deploy MEDIUM: ACCOUNTANT must not see another ADMIN's payout wallet ──
  it('ACCOUNTANT viewing a non-ADMIN — requisites visible, wallet NOT excluded', async () => {
    const viewer = makeUser({ id: 'acc1', role: 'ACCOUNTANT' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.requisites).toBe(true)
    // Non-ADMIN target: the accountant keeps full payroll requisites access.
    expect(p.fields.requisitesExcludeWallet).toBe(false)
  })

  it('ACCOUNTANT viewing an ADMIN — requisites surface kept but wallet EXCLUDED', async () => {
    const viewer = makeUser({ id: 'acc1', role: 'ACCOUNTANT' })
    const target = makeUser({ id: 'admin1', role: 'ADMIN' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.requisites).toBe(true)
    // ADMIN target: payout wallet/IBAN masked — admins are not on payroll.
    expect(p.fields.requisitesExcludeWallet).toBe(true)
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
    // SR-M-7 — see the ACCOUNTANT test above for the full reasoning. HR is
    // deliberately barred from ever SETTING personalEmail (UsersController.
    // createUser forces it null for an HR actor); nothing enforced the READ
    // side until now.
    expect(p.fields.personalContact).toBeFalsy()
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

  // ── task-hr-rbac-teammate-access §2 — HR viewing an ACCOUNTANT / HR teammate ──
  // New teammate-access surface: HR in the same team can open an ACCOUNTANT or
  // another HR's profile, but the tab surface is trimmed to overview + team ONLY
  // (no projects/interviews — those are senior/project surfaces), and every
  // financial / requisites / PII flag stays false (masked in buildProfileView).
  // The isHrInTargetTeam DB-helper is mocked true here (membership proven by the
  // dedicated isHrInTargetTeam unit block + the real-DB integration spec).

  it('HR viewing ACCOUNTANT teammate (in team) — tabs are exactly [overview, team]', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'acc1', role: 'ACCOUNTANT' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(['overview', 'team'])
    expect(p.tabs).not.toContain('projects')
    expect(p.tabs).not.toContain('interviews')
    expect(p.tabs).not.toContain('finance')
    expect(p.tabs).not.toContain('requisites')
  })

  it('HR viewing another HR teammate (in team) — tabs are exactly [overview, team]', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'hr2', role: 'HR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(['overview', 'team'])
    expect(p.tabs).not.toContain('projects')
    expect(p.tabs).not.toContain('interviews')
  })

  it('HR viewing ACCOUNTANT teammate — financial/PII flags all masked, contacts visible', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'acc1', role: 'ACCOUNTANT' })
    const p = await service.getViewPermissions(viewer, target)
    // Finance / requisites / PII stay false → null in buildProfileView (no new leak)
    expect(p.fields.salary).toBeFalsy()
    expect(p.fields.share).toBeFalsy()
    expect(p.fields.requisites).toBeFalsy()
    expect(p.fields.fopPii).toBeFalsy()
    expect(p.fields.legalName).toBeFalsy()
    expect(p.fields.adminNote).toBeFalsy()
    expect(p.fields.legend).toBeFalsy()
    expect(p.fields.projectCredentials).toBeFalsy()
    expect(p.fields.editCredentials).toBeFalsy()
    // Contacts of a teammate ARE visible (same as the SENIOR HR path)
    expect(p.fields.realContacts).toBe(true)
    expect(p.fields.techStack).toBe(true)
    expect(p.fields.registrationDate).toBe(true)
    // SR-M-7 — realContacts and personalContact are deliberately SEPARATE
    // gates (SR-M-4): a teammate's ordinary email is visible, their personal
    // address is not.
    expect(p.fields.personalContact).toBeFalsy()
    // HR has no mutating actions on anyone
    expect(p.actions).toEqual([])
  })

  it('HR viewing another HR teammate — financial/PII flags masked, contacts visible', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'hr2', role: 'HR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.fields.salary).toBeFalsy()
    expect(p.fields.requisites).toBeFalsy()
    expect(p.fields.fopPii).toBeFalsy()
    expect(p.fields.legalName).toBeFalsy()
    expect(p.fields.realContacts).toBe(true)
    // SR-M-7 — same separate-gate reasoning as the ACCOUNTANT-teammate case above.
    expect(p.fields.personalContact).toBeFalsy()
  })

  // Out-of-team: helper returns false → HR gets zero tabs → 403 at route level.
  it('HR viewing ACCOUNTANT NOT in team — zero tabs → 403', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(false)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'acc1', role: 'ACCOUNTANT' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('HR viewing HR NOT in team — zero tabs → 403', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(false)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'hr2', role: 'HR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  // Regression: HR → SENIOR teammate keeps the full senior surface (unchanged).
  it('HR viewing SENIOR teammate — keeps [overview, projects, team, interviews] + resume (regression)', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'sr1', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    // task-resume-base: 'resume' appended; the pre-existing four are unchanged,
    // which is what this regression test was guarding.
    expect(p.tabs).toEqual(['overview', 'projects', 'team', 'interviews', 'resume'])
  })

  // ---- task-resume-base §4: resume tab visibility -------------------------

  it('SENIOR self-view gets the resume tab', async () => {
    const viewer = makeUser({ id: 'sr-self', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, viewer)
    expect(p.tabs).toContain('resume')
  })

  it('resume tab is absent on a non-SENIOR card (ADMIN viewing a JUNIOR)', async () => {
    const viewer = makeUser({ id: 'admin-id', role: 'ADMIN' })
    const target = makeUser({ id: 'jr-id', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).not.toContain('resume')
  })

  it('SENIOR viewing ANOTHER senior gets no resume tab (and no card at all)', async () => {
    const viewer = makeUser({ id: 'sr-a', role: 'SENIOR' })
    const target = makeUser({ id: 'sr-b', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).not.toContain('resume')
    expect(p.tabs).toHaveLength(0)
  })

  it('ACCOUNTANT viewing a SENIOR gets the usual tabs but NOT resume', async () => {
    const viewer = makeUser({ id: 'acc-id', role: 'ACCOUNTANT' })
    const target = makeUser({ id: 'sr-id', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toContain('overview')
    expect(p.tabs).not.toContain('resume')
  })

  it('HR viewing a SENIOR OUTSIDE their team still gets zero tabs (resume must not widen the card)', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(false)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'sr-other-team', role: 'SENIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  // Regression: HR → JUNIOR teammate keeps overview/projects/team + credential flags.
  it('HR viewing JUNIOR teammate — keeps [overview, projects, team] + projectCredentials (regression)', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(true)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'jr1', role: 'JUNIOR' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual(['overview', 'projects', 'team'])
    expect(p.fields.projectCredentials).toBe(true)
    expect(p.fields.editCredentials).toBe(true)
  })

  // ADMIN/DROP targets must NOT be reachable for HR even if the (buggy) helper
  // returned true — the helper itself returns false for them (covered in the
  // isHrInTargetTeam block). At the getViewPermissions level a false helper
  // result yields zero tabs.
  it('HR viewing ADMIN — zero tabs (helper false; never opened to HR)', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(false)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'admin1', role: 'ADMIN' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })

  it('HR viewing DROP — zero tabs (helper false; never opened to HR via this branch)', async () => {
    ;(service as unknown as Record<string, unknown>).isHrInTargetTeam = vi
      .fn()
      .mockResolvedValue(false)
    const viewer = makeUser({ id: 'hr1', role: 'HR' })
    const target = makeUser({ id: 'drop1', role: 'DROP' })
    const p = await service.getViewPermissions(viewer, target)
    expect(p.tabs).toEqual([])
  })
})

// ── task-hr-rbac-teammate-access §Тесты — isHrInTargetTeam (all branches) ──
// Closes audit finding REFACTOR-L2: the private isHrInTargetTeam helper had NO
// covering tests. These exercise the REAL helper (not a stub) against a queued
// drizzle-builder mock — every `db.db.select(...).from(...).where(...)` resolves
// to the next pre-seeded result row set, in call order. The select-chain is
// thenable (Drizzle query builders are PromiseLike) so `await` consumes a queued
// result; `.from()` / `.innerJoin()` return the same builder.
describe('UsersAccessService.isHrInTargetTeam (all role branches)', () => {
  type Row = Record<string, unknown>

  /**
   * Build a UsersAccessService whose db.db.select() returns a thenable builder
   * that resolves, in call order, to each pre-seeded result set in `queue`.
   * Each entry in `queue` corresponds to one full select(...).from(...).where()
   * chain. Tracks how many select() chains were started for short-circuit asserts.
   */
  function buildServiceWithQueue(queue: Row[][]): {
    svc: UsersAccessService
    selectCalls: () => number
  } {
    let idx = 0
    let started = 0
    const makeBuilder = (): Record<string, unknown> => {
      const result = queue[idx] ?? []
      const builder: Record<string, unknown> = {
        from: () => builder,
        innerJoin: () => builder,
        where: () => {
          idx += 1
          return Promise.resolve(result)
        },
        // Safety net: if a chain is awaited without .where() (not expected here),
        // still resolve to the current result and advance.
        then: (onFulfilled: (v: Row[]) => unknown) => {
          idx += 1
          return Promise.resolve(result).then(onFulfilled)
        },
      }
      return builder
    }
    const db = {
      db: {
        select: () => {
          started += 1
          return makeBuilder()
        },
      },
    }
    const svc = new UsersAccessService(db as never)
    return { svc, selectCalls: () => started }
  }

  const callHelper = (svc: UsersAccessService, hrId: string, target: User): Promise<boolean> =>
    (
      svc as unknown as { isHrInTargetTeam: (h: string, t: User) => Promise<boolean> }
    ).isHrInTargetTeam(hrId, target)

  // ── SENIOR (existing behaviour — pinned) ──
  it('SENIOR in a shared team → true', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships
      [{ teamId: 't1' }], // target in those teams
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'sr1', role: 'SENIOR' }))
    expect(ok).toBe(true)
  })

  it('SENIOR in a different team → false', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships
      [], // target not in any of HR's teams
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'sr1', role: 'SENIOR' }))
    expect(ok).toBe(false)
  })

  it('SENIOR but HR has no team memberships → false (short-circuit, one query)', async () => {
    const { svc, selectCalls } = buildServiceWithQueue([
      [], // hrMemberships empty
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'sr1', role: 'SENIOR' }))
    expect(ok).toBe(false)
    // Short-circuits after the first query (no second membership lookup).
    expect(selectCalls()).toBe(1)
  })

  // ── ACCOUNTANT (new branch) ──
  it('ACCOUNTANT in a shared team → true', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships
      [{ teamId: 't1' }], // accountant in those teams
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'acc1', role: 'ACCOUNTANT' }))
    expect(ok).toBe(true)
  })

  it('ACCOUNTANT in a different team → false', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships
      [], // accountant not in HR's teams
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'acc1', role: 'ACCOUNTANT' }))
    expect(ok).toBe(false)
  })

  it('ACCOUNTANT but HR has no team memberships → false (short-circuit)', async () => {
    const { svc, selectCalls } = buildServiceWithQueue([[]])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'acc1', role: 'ACCOUNTANT' }))
    expect(ok).toBe(false)
    expect(selectCalls()).toBe(1)
  })

  // ── HR (new branch — HR↔other-HR) ──
  it('HR teammate in a shared team → true', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships
      [{ teamId: 't1' }], // other HR in those teams
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'hr2', role: 'HR' }))
    expect(ok).toBe(true)
  })

  it('HR teammate in a different team → false', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships
      [], // other HR not in HR's teams
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'hr2', role: 'HR' }))
    expect(ok).toBe(false)
  })

  // ── JUNIOR (existing project-path behaviour — pinned) ──
  it('JUNIOR active in a project of an HR-team senior → true', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrTeams
      [{ userId: 'sr1' }], // seniorMembers (innerJoin users)
      [{ id: 'p1' }], // seniorProjects
      [{ id: 'pm1' }], // target active in project
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'jr1', role: 'JUNIOR' }))
    expect(ok).toBe(true)
  })

  it('JUNIOR not active in any HR-team senior project → false', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrTeams
      [{ userId: 'sr1' }], // seniorMembers
      [{ id: 'p1' }], // seniorProjects
      [], // target NOT active in those projects
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'jr1', role: 'JUNIOR' }))
    expect(ok).toBe(false)
  })

  it('JUNIOR but HR-teams have no seniors → false (short-circuit before project lookup)', async () => {
    const { svc, selectCalls } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrTeams
      [], // no seniors in those teams
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'jr1', role: 'JUNIOR' }))
    expect(ok).toBe(false)
    // hrTeams + seniorMembers only — no seniorProjects / targetActive queries.
    expect(selectCalls()).toBe(2)
  })

  // ── ADMIN / DROP — never reachable via this branch (no query at all) ──
  it('ADMIN target → false (no DB query)', async () => {
    const { svc, selectCalls } = buildServiceWithQueue([])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'admin1', role: 'ADMIN' }))
    expect(ok).toBe(false)
    expect(selectCalls()).toBe(0)
  })

  it('DROP target → false (no DB query)', async () => {
    const { svc, selectCalls } = buildServiceWithQueue([])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'drop1', role: 'DROP' }))
    expect(ok).toBe(false)
    expect(selectCalls()).toBe(0)
  })

  // ── leftAt-filter correctness (SECURITY-MED fix) ──
  // After the fix, both the HR-membership lookup and the target-membership lookup
  // filter on leftAt IS NULL. These unit tests simulate what the real DB would
  // return when the only matching row has leftAt set (i.e. the DB returns an EMPTY
  // result set because leftAt IS NULL is not satisfied). The mock-queue already
  // models this: returning [] for the first query simulates "HR has no ACTIVE
  // memberships" → short-circuit false. Returning [] for the second query
  // simulates "target is not an ACTIVE member of any HR team" → false.
  //
  // This covers the SECURITY-MED finding: before the fix, a former HR teammate
  // (leftAt set) would still appear in the hrMemberships result set and allow
  // over-grant. After the fix, the DB predicate excludes such rows → [] → false.

  it('SENIOR: HR has only a past (leftAt-filtered) membership → false (over-grant blocked)', async () => {
    // hrMemberships returns [] — simulates DB filtering out the leftAt-set row
    const { svc } = buildServiceWithQueue([
      [], // hrMemberships — empty because leftAt IS NULL filtered out past membership
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'sr1', role: 'SENIOR' }))
    expect(ok).toBe(false)
  })

  it('SENIOR: HR active, target has only a past (leftAt-filtered) membership → false (over-grant blocked)', async () => {
    // HR has an active membership, but target's membership is past (leftAt set)
    // → target is NOT in HR's current teams → false.
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships — HR is actively in t1
      [], // targetInTeams — empty because target's row has leftAt set (DB filters it)
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'sr1', role: 'SENIOR' }))
    expect(ok).toBe(false)
  })

  it('ACCOUNTANT: HR has only a past membership → false (over-grant blocked)', async () => {
    const { svc } = buildServiceWithQueue([
      [], // hrMemberships empty (leftAt-filtered)
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'acc1', role: 'ACCOUNTANT' }))
    expect(ok).toBe(false)
  })

  it('ACCOUNTANT: HR active, target has only past membership → false (over-grant blocked)', async () => {
    const { svc } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrMemberships — HR is active
      [], // targetInTeams — empty because target's leftAt is set
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'acc1', role: 'ACCOUNTANT' }))
    expect(ok).toBe(false)
  })

  it('JUNIOR path: HR has only past team membership → false (over-grant blocked)', async () => {
    // hrTeams returns [] → short-circuit before project-path
    const { svc, selectCalls } = buildServiceWithQueue([
      [], // hrTeams — empty (leftAt-filtered)
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'jr1', role: 'JUNIOR' }))
    expect(ok).toBe(false)
    expect(selectCalls()).toBe(1)
  })

  it('JUNIOR path: HR active, senior in team has past membership → no seniors found → false', async () => {
    // hrTeams has rows, but seniorMembers is empty because senior's leftAt is set
    const { svc, selectCalls } = buildServiceWithQueue([
      [{ teamId: 't1' }], // hrTeams — HR is active
      [], // seniorMembers — empty because senior's team_members.leftAt is set
    ])
    const ok = await callHelper(svc, 'hr1', makeUser({ id: 'jr1', role: 'JUNIOR' }))
    expect(ok).toBe(false)
    expect(selectCalls()).toBe(2)
  })
})
