import type { SessionUser } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { mapTeam } from './team-mapping.util'
import type { ProjectWithMembers, TeamWithMembers } from './team-mapping.util'

const D = new Date('2026-01-02T03:04:05.000Z')
const D2 = new Date('2026-02-03T04:05:06.000Z')

function user(id: string, role: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    role,
    displayName: `name-${id}`,
    email: `${id}@x.test`,
    avatarUrl: `av-${id}`,
    avatarDocumentId: `doc-${id}`,
    techStack: ['ts'],
    phone: `+1${id}`,
    telegram: `@${id}`,
    ...extra,
  }
}

function member(id: string, u: ReturnType<typeof user> | null, leftAt: Date | null = null) {
  return { id: `tm-${id}`, userId: id, joinedAt: D, leftAt, user: u }
}

function team(type: 'SENIOR' | 'DROP', members: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 't1',
    name: 'Team',
    type,
    telegram: null,
    telegramChannel: null,
    notes: null,
    seniorSharePercentOverride: null,
    archivedAt: null,
    createdAt: D,
    updatedAt: D2,
    members,
    ...extra,
  } as unknown as TeamWithMembers
}

function project(seniorId: string, members: unknown[]) {
  return { id: 'p1', seniorId, members } as unknown as ProjectWithMembers
}

function pm(id: string, u: ReturnType<typeof user> | null, leftAt: Date | null = null) {
  return { id: `pm-${id}`, userId: id, joinedAt: D2, leftAt, user: u }
}

const viewer = (id: string, role: string) => ({ id, role }) as unknown as SessionUser

describe('mapTeam — senior-team envelope', () => {
  it('copies scalar fields, nulls optional ones and stringifies archivedAt', () => {
    const t = team('SENIOR', [], {
      telegram: '@t',
      telegramChannel: '@ch',
      notes: 'n',
      seniorSharePercentOverride: '40',
      archivedAt: D2,
    })
    expect(mapTeam(t, [], viewer('a', 'ADMIN'))).toEqual({
      id: 't1',
      name: 'Team',
      type: 'SENIOR',
      telegram: '@t',
      telegramChannel: '@ch',
      notes: 'n',
      seniorSharePercentOverride: '40',
      archivedAt: '2026-02-03T04:05:06.000Z',
      createdAt: D,
      updatedAt: D2,
      members: [],
    })
    const bare = mapTeam(team('SENIOR', []), [], viewer('a', 'ADMIN'))
    expect(bare.telegram).toBeNull()
    expect(bare.telegramChannel).toBeNull()
    expect(bare.notes).toBeNull()
    expect(bare.seniorSharePercentOverride).toBeNull()
    expect(bare.archivedAt).toBeNull()
  })

  it('lists active non-ADMIN/non-JUNIOR members, drops left/ADMIN/JUNIOR/dangling rows', () => {
    const t = team('SENIOR', [
      member('s', user('s', 'SENIOR')),
      member('h', user('h', 'HR'), null),
      member('gone', user('gone', 'HR'), D2),
      member('adm', user('adm', 'ADMIN')),
      member('jun', user('jun', 'JUNIOR')),
      member('dangling', null),
    ])
    const out = mapTeam(t, [], viewer('a', 'ADMIN'))
    expect(out.members.map((m) => m.userId)).toEqual(['s', 'h'])
    expect(out.members[0]).toEqual({
      id: 'tm-s',
      userId: 's',
      displayName: 'name-s',
      email: 's@x.test',
      avatarUrl: 'av-s',
      avatarDocumentId: 'doc-s',
      techStack: ['ts'],
      phone: '+1s',
      telegram: '@s',
      role: 'SENIOR',
      joinedAt: D,
      leftAt: null,
    })
  })

  it('nulls missing profile fields', () => {
    const t = team('SENIOR', [
      member(
        's',
        user('s', 'SENIOR', {
          avatarUrl: null,
          avatarDocumentId: null,
          techStack: null,
          phone: null,
          telegram: null,
        }),
      ),
    ])
    const m = mapTeam(t, [], viewer('a', 'ADMIN')).members[0]
    expect(m).toMatchObject({
      avatarUrl: null,
      avatarDocumentId: null,
      techStack: null,
      phone: null,
      telegram: null,
    })
  })

  it('appends active juniors of the CURRENT senior, deduplicated, with ISO joinedAt', () => {
    const j1 = user('j1', 'JUNIOR', { avatarUrl: null, techStack: null, phone: null })
    const t = team('SENIOR', [
      member('old', user('old', 'SENIOR'), D2),
      member('s', user('s', 'SENIOR')),
    ])
    const projects = [
      project('s', [pm('j1', j1), pm('j2', user('j2', 'JUNIOR'), D2), pm('x', user('x', 'HR'))]),
      project('s', [pm('j1', j1)]),
      project('other', [pm('j9', user('j9', 'JUNIOR'))]),
      project('old', [pm('j8', user('j8', 'JUNIOR'))]),
    ]
    const out = mapTeam(t, projects, viewer('a', 'ADMIN'))
    expect(out.members.map((m) => m.userId)).toEqual(['s', 'j1'])
    expect(out.members[1]).toEqual({
      id: 'pm-j1',
      userId: 'j1',
      displayName: 'name-j1',
      email: 'j1@x.test',
      avatarUrl: null,
      avatarDocumentId: 'doc-j1',
      techStack: null,
      phone: null,
      telegram: '@j1',
      role: 'JUNIOR',
      joinedAt: '2026-02-03T04:05:06.000Z',
    })
  })

  it('ignores a team with no active senior when listing juniors', () => {
    const t = team('SENIOR', [member('old', user('old', 'SENIOR'), D2)])
    const out = mapTeam(t, [project('old', [pm('j', user('j', 'JUNIOR'))])], viewer('a', 'ADMIN'))
    expect(out.members).toEqual([])
  })

  it('JUNIOR viewer sees only themself among juniors and has SENIOR contacts masked', () => {
    const t = team('SENIOR', [member('s', user('s', 'SENIOR')), member('h', user('h', 'HR'))])
    const projects = [
      project('s', [pm('me', user('me', 'JUNIOR')), pm('other', user('other', 'JUNIOR'))]),
    ]
    const out = mapTeam(t, projects, viewer('me', 'JUNIOR'))
    expect(out.members.map((m) => m.userId)).toEqual(['s', 'h', 'me'])
    const [senior, hr, me] = out.members
    expect(senior).toMatchObject({
      email: null,
      phone: null,
      telegram: null,
      displayName: 'name-s',
    })
    expect(senior.avatarUrl).toBe('av-s')
    expect(hr).toMatchObject({ email: 'h@x.test', phone: '+1h', telegram: '@h' })
    expect(me).toMatchObject({ email: 'me@x.test', phone: '+1me', telegram: '@me' })
  })

  it('SENIOR viewer sees no juniors and unmasked contacts', () => {
    const t = team('SENIOR', [member('s', user('s', 'SENIOR'))])
    const projects = [project('s', [pm('j', user('j', 'JUNIOR'))])]
    const out = mapTeam(t, projects, viewer('s', 'SENIOR'))
    expect(out.members.map((m) => m.userId)).toEqual(['s'])
    expect(out.members[0].email).toBe('s@x.test')
  })

  it('non-JUNIOR viewers never mask contacts (ADMIN, HR, ACCOUNTANT)', () => {
    const t = team('SENIOR', [member('s', user('s', 'SENIOR'))])
    for (const role of ['ADMIN', 'HR', 'ACCOUNTANT']) {
      expect(mapTeam(t, [], viewer('v', role)).members[0].email).toBe('s@x.test')
    }
  })

  it('serialises leftAt of an active-filter-passing row as null', () => {
    const t = team('SENIOR', [member('s', user('s', 'SENIOR'))])
    expect(mapTeam(t, [], viewer('a', 'ADMIN')).members[0].leftAt).toBeNull()
  })
})

describe('mapTeam — senior-team edge cases', () => {
  it('picks the SENIOR even when other members (incl. a dangling-user row) precede it', () => {
    const t = team('SENIOR', [
      member('dangling', null),
      member('h', user('h', 'HR')),
      member('s', user('s', 'SENIOR')),
    ])
    const out = mapTeam(t, [project('s', [pm('j', user('j', 'JUNIOR'))])], viewer('a', 'ADMIN'))
    expect(out.members.map((m) => m.userId)).toEqual(['h', 's', 'j'])
  })

  it('skips a project member whose user relation is dangling', () => {
    const t = team('SENIOR', [member('s', user('s', 'SENIOR'))])
    const out = mapTeam(
      t,
      [project('s', [pm('ghost', null), pm('j', user('j', 'JUNIOR'))])],
      viewer('a', 'ADMIN'),
    )
    expect(out.members.map((m) => m.userId)).toEqual(['s', 'j'])
  })

  it('passes populated junior profile fields through verbatim', () => {
    const t = team('SENIOR', [member('s', user('s', 'SENIOR'))])
    const out = mapTeam(t, [project('s', [pm('j', user('j', 'JUNIOR'))])], viewer('a', 'ADMIN'))
    expect(out.members[1]).toMatchObject({
      avatarUrl: 'av-j',
      avatarDocumentId: 'doc-j',
      techStack: ['ts'],
      phone: '+1j',
      telegram: '@j',
    })
  })

  it('masks a DROP member (not only SENIOR) from a JUNIOR viewer', () => {
    const t = team('SENIOR', [member('d', user('d', 'DROP')), member('s', user('s', 'SENIOR'))])
    const [d] = mapTeam(t, [], viewer('me', 'JUNIOR')).members
    expect(d).toMatchObject({ userId: 'd', email: null, phone: null, telegram: null })
  })
})

describe('mapTeam — DROP branch', () => {
  const dropTeam = () =>
    team(
      'DROP',
      [
        member('d', user('d', 'DROP')),
        member('s', user('s', 'SENIOR')),
        member('h', user('h', 'HR')),
        member('acc', user('acc', 'ACCOUNTANT')),
        member('adm', user('adm', 'ADMIN')),
        member('jun', user('jun', 'JUNIOR')),
        member('gone', user('gone', 'HR'), D2),
        member('dangling', null),
      ],
      { telegramChannel: '@drop', archivedAt: D2, seniorSharePercentOverride: '30' },
    )

  it('returns envelope + active non-ADMIN/non-JUNIOR members and ignores allProjects', () => {
    const out = mapTeam(
      dropTeam(),
      [project('s', [pm('j', user('j', 'JUNIOR'))])],
      viewer('a', 'ADMIN'),
    )
    expect(out).toMatchObject({
      id: 't1',
      name: 'Team',
      type: 'DROP',
      telegram: null,
      telegramChannel: '@drop',
      notes: null,
      seniorSharePercentOverride: '30',
      archivedAt: '2026-02-03T04:05:06.000Z',
      createdAt: D,
      updatedAt: D2,
    })
    expect(out.members.map((m) => m.userId)).toEqual(['d', 's', 'h', 'acc'])
    expect(out.members[0]).toEqual({
      id: 'tm-d',
      userId: 'd',
      displayName: 'name-d',
      email: 'd@x.test',
      avatarUrl: 'av-d',
      avatarDocumentId: 'doc-d',
      techStack: ['ts'],
      phone: '+1d',
      telegram: '@d',
      role: 'DROP',
      joinedAt: D,
      leftAt: null,
    })
  })

  it('passes populated telegram and notes through', () => {
    const out = mapTeam(team('DROP', [], { telegram: '@t', notes: 'n' }), [], viewer('a', 'ADMIN'))
    expect(out.telegram).toBe('@t')
    expect(out.notes).toBe('n')
  })

  it('nulls missing optional scalars', () => {
    const out = mapTeam(team('DROP', []), [], viewer('a', 'ADMIN'))
    expect(out.telegram).toBeNull()
    expect(out.notes).toBeNull()
    expect(out.seniorSharePercentOverride).toBeNull()
    expect(out.archivedAt).toBeNull()
  })

  it('nulls missing profile fields on members', () => {
    const t = team('DROP', [
      member(
        'd',
        user('d', 'DROP', {
          avatarUrl: null,
          avatarDocumentId: null,
          techStack: null,
          phone: null,
          telegram: null,
        }),
      ),
    ])
    expect(mapTeam(t, [], viewer('a', 'ADMIN')).members[0]).toMatchObject({
      avatarUrl: null,
      avatarDocumentId: null,
      techStack: null,
      phone: null,
      telegram: null,
    })
  })

  it('JUNIOR viewer: DROP and SENIOR contacts masked, HR/ACCOUNTANT not', () => {
    const out = mapTeam(dropTeam(), [], viewer('me', 'JUNIOR'))
    const byId = Object.fromEntries(out.members.map((m) => [m.userId, m]))
    for (const id of ['d', 's']) {
      expect(byId[id]).toMatchObject({ email: null, phone: null, telegram: null })
      expect(byId[id].displayName).toBe(`name-${id}`)
    }
    for (const id of ['h', 'acc']) {
      expect(byId[id]).toMatchObject({ email: `${id}@x.test`, phone: `+1${id}` })
    }
  })

  it('non-JUNIOR viewers get unmasked DROP contacts', () => {
    for (const role of ['ADMIN', 'SENIOR', 'HR', 'DROP']) {
      expect(mapTeam(dropTeam(), [], viewer('v', role)).members[0].email).toBe('d@x.test')
    }
  })
})
