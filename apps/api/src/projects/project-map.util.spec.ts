/**
 * Unit tests — `mapProjectToDto` (leaf P-L2 of the projects.service decomposition).
 *
 * Pure util: project row + viewer role -> DTO with all RBAC masking. Expected values are
 * hand-written literals (not recomputed with the production formula).
 */
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { mapProjectToDto, type ProjectWithRelations } from './project-map.util'

type Role = SessionUser['role']

const D = new Date('2026-01-02T03:04:05.000Z')

function fixture(over: Record<string, unknown> = {}): ProjectWithRelations {
  const base = {
    id: 'p1',
    name: 'Proj',
    companyName: 'Acme',
    domain: 'acme.io',
    logoDocumentId: 'logo-doc',
    logoExternalUrl: 'https://x.test/logo.png',
    startDate: D,
    seniorId: 'sen1',
    dropId: 'drop1',
    rate: 100,
    currency: 'USD',
    seniorSharePercentOverride: 30,
    dropSharePercentOverride: 12,
    techStack: 'ts',
    teamSize: 4,
    benefits: 'ben',
    paymentType: 'HOURLY',
    salaryReview: 'yearly',
    corpTech: 'corp',
    notesGeneral: 'notes',
    status: 'ACTIVE',
    archivedAt: null,
    createdAt: D,
    updatedAt: D,
    senior: {
      id: 'sen1',
      role: 'SENIOR',
      displayName: 'Sen',
      seniorSharePercent: 40,
    },
    drop: { id: 'drop1', displayName: 'Drp', dropSharePercent: 7 },
    legend: { fullName: 'Persona', presentedRole: 'Lead' },
    members: [],
    ...over,
  }
  return base as unknown as ProjectWithRelations
}

function member(role: string | null, id = 'm1') {
  return {
    id,
    userId: `u-${id}`,
    joinedAt: D,
    leftAt: null,
    user:
      role === null
        ? null
        : {
            role,
            displayName: `name-${id}`,
            email: `${id}@x.test`,
            avatarUrl: `av-${id}`,
            avatarDocumentId: `avd-${id}`,
          },
  }
}

const map = (p: ProjectWithRelations, role: Role, ...rest: unknown[]) =>
  (mapProjectToDto as (...a: unknown[]) => ReturnType<typeof mapProjectToDto>)(
    p,
    undefined,
    role,
    ...rest,
  )

describe('mapProjectToDto', () => {
  it('ADMIN gets the full unmasked DTO', () => {
    const dto = map(fixture(), 'ADMIN')
    expect(dto).toEqual({
      id: 'p1',
      name: 'Proj',
      companyName: 'Acme',
      domain: 'acme.io',
      logoDocumentId: 'logo-doc',
      logoExternalUrl: 'https://x.test/logo.png',
      startDate: '2026-01-02T03:04:05.000Z',
      seniorId: 'sen1',
      seniorName: 'Sen',
      seniorPresentedRole: null,
      dropId: 'drop1',
      dropName: 'Drp',
      dropSharePercent: 7,
      dropSharePercentOverride: 12,
      dropSharePercentDefault: 7,
      effectiveDropSharePercent: 12,
      effectiveDropShareSource: 'PROJECT',
      rate: 100,
      currency: 'USD',
      seniorSharePercentOverride: 30,
      seniorSharePercentDefault: 40,
      effectiveSeniorSharePercent: 30,
      effectiveSeniorShareSource: 'PROJECT',
      pendingSeniorShare: null,
      techStack: 'ts',
      teamSize: 4,
      benefits: 'ben',
      paymentType: 'HOURLY',
      salaryReview: 'yearly',
      corpTech: 'corp',
      notesGeneral: 'notes',
      status: 'ACTIVE',
      rejectionReason: null,
      seniorApprovalPending: false,
      dropApprovalPending: false,
      archivedAt: null,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
      members: [],
    })
  })

  it('JUNIOR gets the masked allowlist view with legend persona', () => {
    const dto = map(fixture({ members: [member('SENIOR')] }), 'JUNIOR')
    expect(dto).toMatchObject({
      seniorId: null,
      seniorName: 'Persona',
      seniorPresentedRole: 'Lead',
      dropId: null,
      dropName: null,
      dropSharePercent: null,
      dropSharePercentOverride: null,
      dropSharePercentDefault: null,
      effectiveDropSharePercent: null,
      effectiveDropShareSource: null,
      rate: null,
      currency: null,
      seniorSharePercentOverride: null,
      seniorSharePercentDefault: 0,
      effectiveSeniorSharePercent: null,
      effectiveSeniorShareSource: null,
      paymentType: null,
      salaryReview: null,
      notesGeneral: null,
      members: [],
    })
  })

  it('JUNIOR still sees the non-sensitive fields (no over-masking)', () => {
    const dto = map(fixture(), 'JUNIOR')
    expect(dto).toMatchObject({
      id: 'p1',
      name: 'Proj',
      companyName: 'Acme',
      domain: 'acme.io',
      startDate: '2026-01-02T03:04:05.000Z',
      techStack: 'ts',
      teamSize: 4,
      benefits: 'ben',
      corpTech: 'corp',
      status: 'ACTIVE',
      logoDocumentId: 'logo-doc',
      logoExternalUrl: 'https://x.test/logo.png',
    })
  })

  it.each<[Role, string | null]>([
    ['ADMIN', 'Drp'],
    ['ACCOUNTANT', 'Drp'],
    ['HR', 'Drp'],
    ['DROP', 'Drp'],
    ['SENIOR', null],
    ['JUNIOR', null],
  ])('dropName boundary: %s sees %s', (role, expected) => {
    expect(map(fixture(), role).dropName).toBe(expected)
  })

  it('JUNIOR without a legend gets null persona fields', () => {
    const dto = map(fixture({ legend: null }), 'JUNIOR')
    expect(dto.seniorName).toBeNull()
    expect(dto.seniorPresentedRole).toBeNull()
  })

  it('non-JUNIOR never gets the legend persona', () => {
    const dto = map(fixture(), 'HR')
    expect(dto.seniorName).toBe('Sen')
    expect(dto.seniorPresentedRole).toBeNull()
  })

  it('legend without presentedRole yields null role for JUNIOR', () => {
    const dto = map(fixture({ legend: { fullName: 'P', presentedRole: null } }), 'JUNIOR')
    expect(dto.seniorPresentedRole).toBeNull()
  })

  it('nullable project columns fall back to null', () => {
    const dto = map(
      fixture({
        logoDocumentId: null,
        logoExternalUrl: null,
        techStack: null,
        teamSize: null,
        benefits: null,
        paymentType: null,
        salaryReview: null,
        corpTech: null,
        notesGeneral: null,
        seniorSharePercentOverride: null,
        dropSharePercentOverride: null,
        seniorId: null,
        dropId: null,
        archivedAt: new Date('2026-02-03T00:00:00.000Z'),
      }),
      'ADMIN',
    )
    expect(dto).toMatchObject({
      logoDocumentId: null,
      logoExternalUrl: null,
      techStack: null,
      teamSize: null,
      benefits: null,
      paymentType: null,
      salaryReview: null,
      corpTech: null,
      notesGeneral: null,
      seniorSharePercentOverride: null,
      dropSharePercentOverride: null,
      seniorId: null,
      dropId: null,
      archivedAt: '2026-02-03T00:00:00.000Z',
    })
  })

  it('undefined nullable columns also collapse to null', () => {
    const dto = map(
      fixture({
        logoDocumentId: undefined,
        logoExternalUrl: undefined,
        techStack: undefined,
        teamSize: undefined,
        benefits: undefined,
        paymentType: undefined,
        salaryReview: undefined,
        corpTech: undefined,
        notesGeneral: undefined,
        seniorSharePercentOverride: undefined,
        dropSharePercentOverride: undefined,
        seniorId: undefined,
        dropId: undefined,
      }),
      'ADMIN',
    )
    expect(dto.logoDocumentId).toBeNull()
    expect(dto.logoExternalUrl).toBeNull()
    expect(dto.techStack).toBeNull()
    expect(dto.teamSize).toBeNull()
    expect(dto.benefits).toBeNull()
    expect(dto.paymentType).toBeNull()
    expect(dto.salaryReview).toBeNull()
    expect(dto.corpTech).toBeNull()
    expect(dto.notesGeneral).toBeNull()
    expect(dto.seniorSharePercentOverride).toBeNull()
    expect(dto.dropSharePercentOverride).toBeNull()
    expect(dto.seniorId).toBeNull()
    expect(dto.dropId).toBeNull()
  })

  it('no senior: seniorName is empty string, default share 26, no effective share', () => {
    const dto = map(fixture({ senior: null, seniorSharePercentOverride: null }), 'ADMIN')
    expect(dto.seniorName).toBe('')
    expect(dto.seniorSharePercentDefault).toBe(26)
    expect(dto.effectiveSeniorSharePercent).toBeNull()
    expect(dto.effectiveSeniorShareSource).toBeNull()
  })

  it('no drop: all drop-derived fields are null', () => {
    const dto = map(fixture({ drop: null, dropId: null, dropSharePercentOverride: null }), 'ADMIN')
    expect(dto.dropName).toBeNull()
    expect(dto.dropSharePercent).toBeNull()
    expect(dto.dropSharePercentDefault).toBeNull()
    expect(dto.effectiveDropSharePercent).toBeNull()
    expect(dto.effectiveDropShareSource).toBeNull()
  })

  it('drop without personal percent defaults to 5 and resolves USER_DEFAULT', () => {
    const dto = map(
      fixture({
        drop: { id: 'drop1', displayName: 'Drp', dropSharePercent: null },
        dropSharePercentOverride: null,
      }),
      'ADMIN',
    )
    expect(dto.dropSharePercentDefault).toBe(5)
    expect(dto.effectiveDropSharePercent).toBe(5)
    expect(dto.effectiveDropShareSource).toBe('USER_DEFAULT')
    expect(dto.dropSharePercent).toBeNull()
  })

  it('drop personal percent without override resolves USER_DEFAULT with that value', () => {
    const dto = map(fixture({ dropSharePercentOverride: null }), 'ADMIN')
    expect(dto.effectiveDropSharePercent).toBe(7)
    expect(dto.effectiveDropShareSource).toBe('USER_DEFAULT')
  })

  it('senior share: user default when no override and no team', () => {
    const dto = map(fixture({ seniorSharePercentOverride: null }), 'ADMIN')
    expect(dto.effectiveSeniorSharePercent).toBe(40)
    expect(dto.effectiveSeniorShareSource).toBe('USER_DEFAULT')
  })

  it('senior share: a single team override applies; map without entry or undefined map does not', () => {
    const p = fixture({ seniorSharePercentOverride: null })
    const withTeam = mapProjectToDto(
      p,
      new Map([['sen1', [{ id: 't1', seniorSharePercentOverride: 33 }]]]),
      'ADMIN',
    )
    expect(withTeam.effectiveSeniorSharePercent).toBe(33)
    expect(withTeam.effectiveSeniorShareSource).toBe('TEAM')

    const otherSenior = mapProjectToDto(
      p,
      new Map([['other', [{ id: 't1', seniorSharePercentOverride: 33 }]]]),
      'ADMIN',
    )
    expect(otherSenior.effectiveSeniorShareSource).toBe('USER_DEFAULT')

    const noMap = mapProjectToDto(p, undefined, 'ADMIN')
    expect(noMap.effectiveSeniorSharePercent).toBe(40)
  })

  describe('seniorId masking for ADMIN-as-senior projects', () => {
    const adminSenior = {
      id: 'sen1',
      role: 'ADMIN',
      displayName: 'Boss',
      seniorSharePercent: 40,
    }
    it.each<[Role, string | null]>([
      ['ADMIN', 'sen1'],
      ['ACCOUNTANT', 'sen1'],
      ['SENIOR', null],
      ['HR', null],
      ['DROP', null],
      ['JUNIOR', null],
    ])('%s sees seniorId=%s', (role, expected) => {
      expect(map(fixture({ senior: adminSenior }), role).seniorId).toBe(expected)
    })

    it('regular senior: non-privileged viewer still sees the real id', () => {
      expect(map(fixture(), 'HR').seniorId).toBe('sen1')
    })
  })

  it('SENIOR: dropName masked, dropId and dropSharePercent kept', () => {
    const dto = map(fixture(), 'SENIOR')
    expect(dto.dropName).toBeNull()
    expect(dto.dropId).toBe('drop1')
    expect(dto.dropSharePercent).toBe(7)
  })

  describe('pendingSeniorShare', () => {
    const pending = { percent: 15, effectivePercentAfterApproval: 15 } as never
    it.each<[Role, boolean]>([
      ['ADMIN', true],
      ['SENIOR', true],
      ['ACCOUNTANT', false],
      ['HR', false],
      ['DROP', false],
      ['JUNIOR', false],
    ])('%s visible=%s', (role, visible) => {
      const dto = map(fixture(), role, new Map(), new Map(), pending)
      expect(dto.pendingSeniorShare).toEqual(visible ? pending : null)
    })

    it('undefined collapses to null for ADMIN', () => {
      expect(map(fixture(), 'ADMIN').pendingSeniorShare).toBeNull()
    })
  })

  describe('rejectionReason', () => {
    const reasons = new Map([['p1', 'because']])
    it('REJECTED + ADMIN sees the reason', () => {
      expect(map(fixture({ status: 'REJECTED' }), 'ADMIN', reasons).rejectionReason).toBe('because')
    })
    it('REJECTED + ADMIN without an entry gets null', () => {
      expect(map(fixture({ status: 'REJECTED' }), 'ADMIN').rejectionReason).toBeNull()
    })
    it.each<Role>(['SENIOR', 'DROP', 'HR', 'ACCOUNTANT', 'JUNIOR'])(
      'REJECTED + %s gets null',
      (role) => {
        expect(map(fixture({ status: 'REJECTED' }), role, reasons).rejectionReason).toBeNull()
      },
    )
    it('non-REJECTED ADMIN gets null even with an entry', () => {
      expect(map(fixture({ status: 'ACTIVE' }), 'ADMIN', reasons).rejectionReason).toBeNull()
    })
  })

  describe('approval-pending flags', () => {
    const pendingBoth = new Map([['p1', new Set(['sen1', 'drop1'])]])
    it('DRAFT: flags reflect raw ids still pending', () => {
      const dto = map(fixture({ status: 'DRAFT' }), 'ADMIN', new Map(), pendingBoth)
      expect(dto.seniorApprovalPending).toBe(true)
      expect(dto.dropApprovalPending).toBe(true)
    })
    it('DRAFT: only the pending one is flagged', () => {
      const dto = map(
        fixture({ status: 'DRAFT' }),
        'ADMIN',
        new Map(),
        new Map([['p1', new Set(['drop1'])]]),
      )
      expect(dto.seniorApprovalPending).toBe(false)
      expect(dto.dropApprovalPending).toBe(true)
    })
    it('DRAFT: no entry for the project -> both false', () => {
      const dto = map(fixture({ status: 'DRAFT' }), 'ADMIN')
      expect(dto.seniorApprovalPending).toBe(false)
      expect(dto.dropApprovalPending).toBe(false)
    })
    it('DRAFT without a drop: dropApprovalPending false', () => {
      const dto = map(
        fixture({ status: 'DRAFT', dropId: null, drop: null }),
        'ADMIN',
        new Map(),
        pendingBoth,
      )
      expect(dto.dropApprovalPending).toBe(false)
      expect(dto.seniorApprovalPending).toBe(true)
    })
    it('flags use the RAW id even when seniorId is masked for the viewer', () => {
      const adminSenior = { id: 'sen1', role: 'ADMIN', displayName: 'B', seniorSharePercent: 1 }
      const dto = map(
        fixture({ status: 'DRAFT', senior: adminSenior }),
        'HR',
        new Map(),
        pendingBoth,
      )
      expect(dto.seniorId).toBeNull()
      expect(dto.seniorApprovalPending).toBe(true)
    })
    it('non-DRAFT: both false even if pending ids exist', () => {
      const dto = map(fixture({ status: 'ACTIVE' }), 'ADMIN', new Map(), pendingBoth)
      expect(dto.seniorApprovalPending).toBe(false)
      expect(dto.dropApprovalPending).toBe(false)
    })
  })

  describe('members', () => {
    const members = [member('JUNIOR', 'a'), member('SENIOR', 'b'), member(null, 'c')]
    const j = {
      id: 'a',
      userId: 'u-a',
      displayName: 'name-a',
      email: 'a@x.test',
      avatarUrl: 'av-a',
      avatarDocumentId: 'avd-a',
      role: 'JUNIOR',
      joinedAt: '2026-01-02T03:04:05.000Z',
      leftAt: null,
    }
    const s = {
      ...j,
      id: 'b',
      userId: 'u-b',
      displayName: 'name-b',
      email: 'b@x.test',
      avatarUrl: 'av-b',
      avatarDocumentId: 'avd-b',
      role: 'SENIOR',
    }
    const orphan = {
      id: 'c',
      userId: 'u-c',
      displayName: '',
      email: '',
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'JUNIOR',
      joinedAt: '2026-01-02T03:04:05.000Z',
      leftAt: null,
    }

    it('ADMIN sees every member unredacted; user-less member defaults to JUNIOR', () => {
      expect(map(fixture({ members }), 'ADMIN').members).toEqual([j, s, orphan])
    })

    it('SENIOR sees JUNIOR members (and user-less ones) redacted, others intact', () => {
      const redacted = {
        id: 'a',
        userId: '[redacted]',
        displayName: '',
        email: '',
        avatarUrl: null,
        avatarDocumentId: null,
        role: 'JUNIOR',
        joinedAt: '2026-01-02T03:04:05.000Z',
        leftAt: null,
      }
      expect(map(fixture({ members }), 'SENIOR').members).toEqual([
        redacted,
        s,
        { ...redacted, id: 'c' },
      ])
    })

    it('HR does not get redaction', () => {
      expect(map(fixture({ members: [member('JUNIOR', 'a')] }), 'HR').members).toEqual([j])
    })

    it('leftAt is serialised when set', () => {
      const m = { ...member('SENIOR', 'b'), leftAt: new Date('2026-03-04T00:00:00.000Z') }
      expect(map(fixture({ members: [m] }), 'ADMIN').members[0]!.leftAt).toBe(
        '2026-03-04T00:00:00.000Z',
      )
    })
  })
})
