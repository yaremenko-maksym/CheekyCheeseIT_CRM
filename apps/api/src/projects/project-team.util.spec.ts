/**
 * Unit tests — `buildEffectiveTeam` (leaf P-L3 of the projects.service decomposition).
 *
 * Pure util: project + viewer role + loaded team rows -> effective team with per-viewer
 * masking. Expected values are hand-written literals.
 */
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { ProjectWithRelations } from './project-map.util'
import { buildEffectiveTeam, type EffectiveTeamRow } from './project-team.util'

type Role = SessionUser['role']
const D = new Date('2026-01-02T03:04:05.000Z')

function project(over: Record<string, unknown> = {}): ProjectWithRelations {
  return {
    senior: {
      id: 'sen1',
      role: 'SENIOR',
      displayName: 'Sen',
      email: 'sen@x.test',
      avatarUrl: 'sen.png',
      avatarDocumentId: 'sen-doc',
    },
    drop: {
      id: 'drop1',
      displayName: 'Drp',
      email: 'drop@x.test',
      avatarUrl: 'drop.png',
      avatarDocumentId: 'drop-doc',
      dropSharePercent: 7,
    },
    members: [],
    ...over,
  } as unknown as ProjectWithRelations
}

function junior(id: string, over: Record<string, unknown> = {}) {
  return {
    id: `pm-${id}`,
    userId: `u-${id}`,
    joinedAt: D,
    leftAt: null,
    user: {
      role: 'JUNIOR',
      displayName: `Jun ${id}`,
      email: `${id}@x.test`,
      avatarUrl: 'j.png',
      avatarDocumentId: 'j-doc',
    },
    ...over,
  }
}

function row(id: string, role: string, over: Partial<EffectiveTeamRow> = {}): EffectiveTeamRow {
  return {
    id: `tm-${id}`,
    userId: `u-${id}`,
    displayName: `N ${id}`,
    email: `${id}@x.test`,
    avatarUrl: 'a.png',
    avatarDocumentId: 'a-doc',
    role,
    ...over,
  }
}

describe('buildEffectiveTeam — senior', () => {
  it('maps senior with literal SENIOR role and navigable profile', () => {
    const t = buildEffectiveTeam(project(), 'HR', [])
    expect(t.senior).toEqual({
      id: 'sen1',
      displayName: 'Sen',
      email: 'sen@x.test',
      avatarUrl: 'sen.png',
      avatarDocumentId: 'sen-doc',
      role: 'SENIOR',
      profileNavigable: true,
    })
  })

  it('null senior -> null', () => {
    expect(buildEffectiveTeam(project({ senior: null }), 'ADMIN', []).senior).toBeNull()
  })

  it('nullish avatar fields become null', () => {
    const p = project({
      senior: { id: 's', role: 'SENIOR', displayName: 'S', email: 'e' },
    })
    const t = buildEffectiveTeam(p, 'ADMIN', [])
    expect(t.senior?.avatarUrl).toBeNull()
    expect(t.senior?.avatarDocumentId).toBeNull()
  })

  const adminSenior = () =>
    project({
      senior: {
        id: 'adm',
        role: 'ADMIN',
        displayName: 'Adm',
        email: 'adm@x.test',
        avatarUrl: null,
        avatarDocumentId: null,
      },
    })

  it.each<[Role, string, boolean]>([
    ['ADMIN', 'adm@x.test', true],
    ['ACCOUNTANT', 'adm@x.test', true],
    ['SENIOR', '', false],
    ['HR', '', false],
    ['DROP', '', false],
  ])('ADMIN-senior seen by %s -> email %j, navigable %s', (role, email, nav) => {
    const t = buildEffectiveTeam(adminSenior(), role, [])
    expect(t.senior?.email).toBe(email)
    expect(t.senior?.profileNavigable).toBe(nav)
  })

  it('non-admin senior is never masked, even for SENIOR/HR viewers', () => {
    const t = buildEffectiveTeam(project(), 'SENIOR', [])
    expect(t.senior?.email).toBe('sen@x.test')
    expect(t.senior?.profileNavigable).toBe(true)
  })
})

describe('buildEffectiveTeam — hrs / accountants', () => {
  it('splits team rows by role, ignoring other roles', () => {
    const rows = [
      row('h1', 'HR'),
      row('a1', 'ACCOUNTANT'),
      row('s1', 'SENIOR'),
      row('h2', 'HR', { avatarUrl: null, avatarDocumentId: null }),
    ]
    const t = buildEffectiveTeam(project(), 'ADMIN', rows)
    expect(t.hrs).toEqual([
      {
        id: 'tm-h1',
        userId: 'u-h1',
        displayName: 'N h1',
        email: 'h1@x.test',
        avatarUrl: 'a.png',
        avatarDocumentId: 'a-doc',
        role: 'HR',
      },
      {
        id: 'tm-h2',
        userId: 'u-h2',
        displayName: 'N h2',
        email: 'h2@x.test',
        avatarUrl: null,
        avatarDocumentId: null,
        role: 'HR',
      },
    ])
    expect(t.accountants).toEqual([
      {
        id: 'tm-a1',
        userId: 'u-a1',
        displayName: 'N a1',
        email: 'a1@x.test',
        avatarUrl: 'a.png',
        avatarDocumentId: 'a-doc',
        role: 'ACCOUNTANT',
      },
    ])
  })

  it('no rows -> empty arrays', () => {
    const t = buildEffectiveTeam(project(), 'ADMIN', [])
    expect(t.hrs).toEqual([])
    expect(t.accountants).toEqual([])
  })
})

describe('buildEffectiveTeam — juniors (RBAC #1)', () => {
  it('SENIOR viewer gets no juniors', () => {
    const p = project({ members: [junior('1')] })
    expect(buildEffectiveTeam(p, 'SENIOR', []).juniors).toEqual([])
  })

  it.each<Role>(['ADMIN', 'HR', 'ACCOUNTANT', 'DROP'])('%s viewer sees active juniors', (role) => {
    const p = project({ members: [junior('1')] })
    expect(buildEffectiveTeam(p, role, []).juniors).toEqual([
      {
        id: 'pm-1',
        userId: 'u-1',
        displayName: 'Jun 1',
        email: '1@x.test',
        avatarUrl: 'j.png',
        avatarDocumentId: 'j-doc',
        role: 'JUNIOR',
        joinedAt: '2026-01-02T03:04:05.000Z',
        leftAt: null,
      },
    ])
  })

  it('excludes left members and non-JUNIOR members', () => {
    const p = project({
      members: [
        junior('left', { leftAt: D }),
        { ...junior('sen'), user: { role: 'SENIOR', displayName: 'x', email: 'y' } },
        { ...junior('nouser'), user: null },
        junior('ok'),
      ],
    })
    const t = buildEffectiveTeam(p, 'ADMIN', [])
    expect(t.juniors.map((j) => j.id)).toEqual(['pm-ok'])
  })

  it('nullish junior avatar fields become null', () => {
    const j = junior('1', {
      user: { role: 'JUNIOR', displayName: 'J', email: 'e' },
    })
    const t = buildEffectiveTeam(project({ members: [j] }), 'ADMIN', [])
    expect(t.juniors[0].avatarUrl).toBeNull()
    expect(t.juniors[0].avatarDocumentId).toBeNull()
  })
})

describe('buildEffectiveTeam — drop (RBAC #2)', () => {
  it('SENIOR viewer gets null drop', () => {
    expect(buildEffectiveTeam(project(), 'SENIOR', []).drop).toBeNull()
  })

  it.each<Role>(['ADMIN', 'HR', 'ACCOUNTANT', 'DROP'])('%s viewer sees the drop', (role) => {
    expect(buildEffectiveTeam(project(), role, []).drop).toEqual({
      id: 'drop1',
      displayName: 'Drp',
      email: 'drop@x.test',
      avatarUrl: 'drop.png',
      avatarDocumentId: 'drop-doc',
      role: 'DROP',
      dropSharePercent: 7,
    })
  })

  it('missing drop -> null; nullish share defaults to 5 and nullish avatars to null', () => {
    expect(buildEffectiveTeam(project({ drop: null }), 'ADMIN', []).drop).toBeNull()
    expect(buildEffectiveTeam(project({ drop: undefined }), 'ADMIN', []).drop).toBeNull()
    const p = project({ drop: { id: 'd', displayName: 'D', email: 'e' } })
    const d = buildEffectiveTeam(p, 'ADMIN', []).drop
    expect(d?.dropSharePercent).toBe(5)
    expect(d?.avatarUrl).toBeNull()
    expect(d?.avatarDocumentId).toBeNull()
  })
})
