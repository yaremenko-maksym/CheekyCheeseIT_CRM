/**
 * Characterization (unit) net for `UsersService.createUser`, pinned BEFORE it
 * is extracted from users.service.ts.
 *
 * `createUser` is a `users` + `user_emails` WRITER (plus `teams`,
 * `team_members`, `project_members`) with role/RBAC gates. This spec pins the
 * whole observable surface over a recording double: every statement in order,
 * which handle (tx vs plain db) each write goes through, the exact inserted
 * rows, the audit entry, the invite/mail hand-offs and the error codes.
 * WHERE clauses are compiled to SQL + params through PgDialect.
 *
 * Harness: `Object.assign(Object.create(UsersService.prototype), {...})`
 * (house convention). Deps: `db`, `auditLogService`, `teamsService`,
 * `inviteMailer`, and the lazy `_invites` collaborator. The shared helpers
 * `assertEmailAvailable` / `writeUserEmailOrConflict` (user-emails.util) are
 * NOT stubbed: they run for real over the double, so their observable effect
 * (the lower(email) probe, 23505 -> 409) is pinned too.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  CREATED,
  baseInput,
  code,
  inserts,
  makeHarness,
  uniqueViolation,
  usersInsertValues,
} from '../test/create-user-harness'
// r5 4.6 S5: the roster dirty producers are proven in job-sourcing; here they are inert.
vi.mock('../job-sourcing/dirty-producers')

const FIXED_NOW = new Date('2026-03-04T05:06:07.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UsersService.createUser — role gates (before any db access)', () => {
  it.each(['ADMIN', 'HR', 'SENIOR'] as const)(
    'rejects role ADMIN with 403 ADMIN_CREATION_FORBIDDEN even for actor %s',
    async (actorRole) => {
      const h = makeHarness()
      await expect(
        h.service.createUser(baseInput({ role: 'ADMIN', actorRole })),
      ).rejects.toMatchObject(code('ADMIN_CREATION_FORBIDDEN', 403))
      expect(h.log).toEqual([])
      expect(h.db.transaction).not.toHaveBeenCalled()
    },
  )

  it('rejects role DROP with 400 DROP_CREATE_VIA_DEDICATED_ENDPOINT before any db access', async () => {
    const h = makeHarness()
    await expect(h.service.createUser(baseInput({ role: 'DROP' }))).rejects.toMatchObject(
      code('DROP_CREATE_VIA_DEDICATED_ENDPOINT', 400),
    )
    expect(h.log).toEqual([])
  })

  it('DROP gate wins over the JOIN_DROP_TEAM checks', async () => {
    const h = makeHarness()
    await expect(
      h.service.createUser(baseInput({ role: 'DROP', teamMode: 'JOIN_DROP_TEAM' })),
    ).rejects.toMatchObject(code('DROP_CREATE_VIA_DEDICATED_ENDPOINT', 400))
  })

  it.each(['HR', 'JUNIOR', 'ACCOUNTANT'] as const)(
    'JOIN_DROP_TEAM is senior-only: role %s -> 400 JOIN_DROP_TEAM_SENIOR_ONLY (checked before dropTeamId)',
    async (role) => {
      const h = makeHarness()
      await expect(
        h.service.createUser(baseInput({ role, teamMode: 'JOIN_DROP_TEAM' })),
      ).rejects.toMatchObject(code('JOIN_DROP_TEAM_SENIOR_ONLY', 400))
      expect(h.log).toEqual([])
    },
  )

  it('JOIN_DROP_TEAM without dropTeamId -> 400 DROP_TEAM_ID_REQUIRED', async () => {
    const h = makeHarness()
    await expect(
      h.service.createUser(baseInput({ role: 'SENIOR', teamMode: 'JOIN_DROP_TEAM' })),
    ).rejects.toMatchObject(code('DROP_TEAM_ID_REQUIRED', 400))
    expect(h.log).toEqual([])
  })

  it('empty-string dropTeamId counts as missing', async () => {
    const h = makeHarness()
    await expect(
      h.service.createUser(
        baseInput({ role: 'SENIOR', teamMode: 'JOIN_DROP_TEAM', dropTeamId: '' }),
      ),
    ).rejects.toMatchObject(code('DROP_TEAM_ID_REQUIRED', 400))
  })

  it('HR actor who is NOT a member of the drop-team -> 403 HR_JOIN_OWN_DROP_TEAM_ONLY (membership probed with dropTeamId + actorId, nothing else touched)', async () => {
    const h = makeHarness({ isMember: false })
    await expect(
      h.service.createUser(
        baseInput({
          role: 'SENIOR',
          teamMode: 'JOIN_DROP_TEAM',
          dropTeamId: 'dt-1',
          actorRole: 'HR',
          actorId: 'hr-9',
        }),
      ),
    ).rejects.toMatchObject(code('HR_JOIN_OWN_DROP_TEAM_ONLY', 403))
    expect(h.log).toEqual([{ op: 'isActiveMemberOfTeam', args: ['dt-1', 'hr-9'] }])
  })

  it('HR actor who IS a member passes the scope check and attaches the new senior', async () => {
    const h = makeHarness({ isMember: true, created: { ...CREATED, role: 'SENIOR' } })
    await h.service.createUser(
      baseInput({
        role: 'SENIOR',
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: 'dt-1',
        actorRole: 'HR',
        actorId: 'hr-9',
      }),
    )
    expect(h.isActiveMemberOfTeam).toHaveBeenCalledWith('dt-1', 'hr-9')
    expect(h.addSeniorToDropTeam).toHaveBeenCalledWith('dt-1', 'user-new')
  })

  it.each(['ADMIN', 'SENIOR', 'ACCOUNTANT'] as const)(
    'non-HR actor %s is exempt from the drop-team membership scope',
    async (actorRole) => {
      const h = makeHarness({ isMember: false, created: { ...CREATED, role: 'SENIOR' } })
      await h.service.createUser(
        baseInput({ role: 'SENIOR', teamMode: 'JOIN_DROP_TEAM', dropTeamId: 'dt-1', actorRole }),
      )
      expect(h.isActiveMemberOfTeam).not.toHaveBeenCalled()
      expect(h.addSeniorToDropTeam).toHaveBeenCalledWith('dt-1', 'user-new')
    },
  )

  it('HR actor with the default CREATE_NEW mode is not membership-checked', async () => {
    const h = makeHarness({
      isMember: false,
      created: { ...CREATED, role: 'SENIOR' },
      staffRoles: { 'hr-9': 'HR' },
    })
    await h.service.createUser(baseInput({ role: 'SENIOR', actorRole: 'HR', actorId: 'hr-9' }))
    expect(h.isActiveMemberOfTeam).not.toHaveBeenCalled()
  })

  it.each(['SENIOR', 'HR', 'JUNIOR', 'ACCOUNTANT'] as const)(
    'role %s is creatable',
    async (role) => {
      const h = makeHarness({ created: { ...CREATED, role } })
      await expect(h.service.createUser(baseInput({ role }))).resolves.toEqual({
        ...CREATED,
        role,
      })
      expect(usersInsertValues(h.log).role).toBe(role)
    },
  )
})

describe('UsersService.createUser — email pre-flight', () => {
  it('duplicate users.email -> 409 USER_EMAIL_EXISTS (exact, case-sensitive lookup; no user_emails probe, no tx)', async () => {
    const h = makeHarness({ existingByEmail: { id: 'someone' } })
    await expect(h.service.createUser(baseInput())).rejects.toMatchObject(
      code('USER_EMAIL_EXISTS', 409),
    )
    expect(h.log).toEqual([
      { op: 'select', table: 'users', where: '"users"."email" = $1', params: ['Input@CC.com'] },
    ])
    expect(h.db.query.userEmails.findFirst).not.toHaveBeenCalled()
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('work address taken in user_emails -> 409 EMAIL_TAKEN_BY_ANOTHER_USER (case-folded probe, no tx)', async () => {
    const h = makeHarness({ userEmailRows: { 'input@cc.com': { userId: 'other' } } })
    await expect(h.service.createUser(baseInput())).rejects.toMatchObject(
      code('EMAIL_TAKEN_BY_ANOTHER_USER', 409),
    )
    expect(h.log).toEqual([
      { op: 'select', table: 'users', where: '"users"."email" = $1', params: ['Input@CC.com'] },
      {
        op: 'findFirst',
        table: 'user_emails',
        where: 'lower("user_emails"."email") = $1',
        params: ['input@cc.com'],
      },
    ])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('personal address taken in user_emails -> 409, probed AFTER the work address, before the tx', async () => {
    const h = makeHarness({ userEmailRows: { 'me@home.com': { userId: 'other' } } })
    await expect(
      h.service.createUser(baseInput({ personalEmail: 'Me@Home.com' })),
    ).rejects.toMatchObject(code('EMAIL_TAKEN_BY_ANOTHER_USER', 409))
    expect(h.log.map((e) => e.op)).toEqual(['select', 'findFirst', 'findFirst'])
    expect((h.log[1] as { params: unknown[] }).params).toEqual(['input@cc.com'])
    expect((h.log[2] as { params: unknown[] }).params).toEqual(['me@home.com'])
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it.each([undefined, null, ''])(
    'personalEmail=%j triggers no personal probe, no PERSONAL row, no invite',
    async (personalEmail) => {
      const h = makeHarness()
      await h.service.createUser(baseInput({ personalEmail }))
      expect(h.db.query.userEmails.findFirst).toHaveBeenCalledTimes(1)
      expect(inserts(h.log, 'user_emails')).toHaveLength(1)
      expect(h.issuePersonalEmailInviteTx).not.toHaveBeenCalled()
      expect(h.sendInvite).not.toHaveBeenCalled()
    },
  )
})

describe('UsersService.createUser — users insert payload', () => {
  it('minimal input: only the always-present columns, locale defaults to uk', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput())
    expect(usersInsertValues(h.log)).toStrictEqual({
      email: 'Input@CC.com',
      displayName: 'Input Name',
      role: 'JUNIOR',
      telegram: null,
      phone: null,
      avatarUrl: null,
      techStack: null,
      locale: 'uk',
    })
  })

  it('full input with USDT method: exact payload; bank fields dropped; salary stringified; legal name trimmed; locale en', async () => {
    const h = makeHarness()
    await h.service.createUser(
      baseInput({
        role: 'SENIOR',
        telegram: '@tg',
        phone: '+380',
        avatarUrl: 'https://a/b.png',
        techStack: ['ts', 'go', 'sql'],
        seniorSharePercent: 31,
        monthlySalary: 1234.5,
        salaryCurrency: 'EUR',
        legalFullName: '  Іваненко Іван Іванович  ',
        locale: 'en',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0xabc',
        walletUsdtLabel: 'main',
        bankUahRecipient: 'ignored',
        bankUahIban: 'ignored',
        bankUahRnokpp: 'ignored',
        bankUahBankName: 'ignored',
      }),
    )
    expect(usersInsertValues(h.log)).toStrictEqual({
      email: 'Input@CC.com',
      displayName: 'Input Name',
      role: 'SENIOR',
      telegram: '@tg',
      phone: '+380',
      avatarUrl: 'https://a/b.png',
      techStack: ['ts', 'go', 'sql'],
      locale: 'en',
      seniorSharePercent: 31,
      monthlySalary: '1234.5',
      salaryCurrency: 'EUR',
      legalFullName: 'Іваненко Іван Іванович',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0xabc',
      walletUsdtLabel: 'main',
    })
  })

  it('BANK_UAH_FOP method: bank fields persisted, wallet fields dropped', async () => {
    const h = makeHarness()
    await h.service.createUser(
      baseInput({
        paymentMethod: 'BANK_UAH_FOP',
        walletUsdtErc20: 'ignored',
        walletUsdtLabel: 'ignored',
        bankUahRecipient: 'ФОП Іваненко',
        bankUahIban: 'UA123',
        bankUahRnokpp: '1234567890',
        bankUahBankName: 'Mono',
      }),
    )
    expect(usersInsertValues(h.log)).toStrictEqual({
      email: 'Input@CC.com',
      displayName: 'Input Name',
      role: 'JUNIOR',
      telegram: null,
      phone: null,
      avatarUrl: null,
      techStack: null,
      locale: 'uk',
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: 'ФОП Іваненко',
      bankUahIban: 'UA123',
      bankUahRnokpp: '1234567890',
      bankUahBankName: 'Mono',
    })
  })

  it('requisites with a method but no values persist explicit nulls (USDT and BANK)', async () => {
    const usdt = makeHarness()
    await usdt.service.createUser(baseInput({ paymentMethod: 'USDT_ERC20' }))
    expect(usersInsertValues(usdt.log)).toMatchObject({
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: null,
      walletUsdtLabel: null,
    })
    expect(usersInsertValues(usdt.log)).not.toHaveProperty('bankUahIban')

    const bank = makeHarness()
    await bank.service.createUser(baseInput({ paymentMethod: 'BANK_UAH_FOP' }))
    expect(usersInsertValues(bank.log)).toMatchObject({
      paymentMethod: 'BANK_UAH_FOP',
      bankUahRecipient: null,
      bankUahIban: null,
      bankUahRnokpp: null,
      bankUahBankName: null,
    })
    expect(usersInsertValues(bank.log)).not.toHaveProperty('walletUsdtErc20')
  })

  it('no paymentMethod: requisite fields are ignored entirely', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ walletUsdtErc20: '0xabc', bankUahIban: 'UA1' }))
    const v = usersInsertValues(h.log)
    expect(v).not.toHaveProperty('paymentMethod')
    expect(v).not.toHaveProperty('walletUsdtErc20')
    expect(v).not.toHaveProperty('bankUahIban')
  })

  it('zero values are kept: seniorSharePercent=0 and monthlySalary=0 are written (not skipped as falsy)', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ seniorSharePercent: 0, monthlySalary: 0 }))
    const v = usersInsertValues(h.log)
    expect(v.seniorSharePercent).toBe(0)
    expect(v.monthlySalary).toBe('0')
  })

  it('monthlySalary null / salaryCurrency / seniorSharePercent omitted -> columns absent', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ monthlySalary: null }))
    const v = usersInsertValues(h.log)
    expect(v).not.toHaveProperty('monthlySalary')
    expect(v).not.toHaveProperty('salaryCurrency')
    expect(v).not.toHaveProperty('seniorSharePercent')
    expect(v).not.toHaveProperty('legalFullName')
  })

  it('blank (whitespace-only) legalFullName is not persisted', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ legalFullName: '   ' }))
    expect(usersInsertValues(h.log)).not.toHaveProperty('legalFullName')
  })
})

describe('UsersService.createUser — transactional write, audit, invite', () => {
  it('JUNIOR without extras: full ordered sequence, writes on the tx handle, audit has actorId null', async () => {
    const h = makeHarness()
    const result = await h.service.createUser(baseInput())

    expect(result).toBe(CREATED)
    expect(h.log).toEqual([
      { op: 'select', table: 'users', where: '"users"."email" = $1', params: ['Input@CC.com'] },
      {
        op: 'findFirst',
        table: 'user_emails',
        where: 'lower("user_emails"."email") = $1',
        params: ['input@cc.com'],
      },
      { op: 'tx-begin' },
      {
        op: 'insert',
        on: 'tx',
        table: 'users',
        values: {
          email: 'Input@CC.com',
          displayName: 'Input Name',
          role: 'JUNIOR',
          telegram: null,
          phone: null,
          avatarUrl: null,
          techStack: null,
          locale: 'uk',
        },
      },
      {
        op: 'insert',
        on: 'tx',
        table: 'user_emails',
        returning: false,
        values: {
          userId: 'user-new',
          // the STORED address (created.email), not the raw input
          email: 'stored@cc.com',
          kind: 'WORK',
          canLogin: true,
          verifiedAt: FIXED_NOW,
        },
      },
      { op: 'tx-end' },
      {
        op: 'audit',
        args: [
          {
            actorId: null,
            targetId: 'user-new',
            action: 'profile_created',
            changes: {
              displayName: { before: null, after: 'Stored Name' },
              role: { before: null, after: 'JUNIOR' },
            },
          },
        ],
      },
    ])
    // the lower(email) probe runs on the plain db handle, not the tx
    expect(h.db.query.userEmails.findFirst).toHaveBeenCalledTimes(1)
    expect(h.tx.insert).toHaveBeenCalledTimes(2)
  })

  it('audit records the persisted row values (not the input) and never an actor / impersonator', async () => {
    const h = makeHarness({ created: { ...CREATED, displayName: 'DB Name', role: 'HR' } })
    await h.service.createUser(baseInput({ role: 'HR', actorId: 'admin-7', actorRole: 'ADMIN' }))
    expect(h.auditRecord).toHaveBeenCalledTimes(1)
    expect(h.auditRecord.mock.calls[0]).toEqual([
      {
        actorId: null,
        targetId: 'user-new',
        action: 'profile_created',
        changes: {
          displayName: { before: null, after: 'DB Name' },
          role: { before: null, after: 'HR' },
        },
      },
    ])
  })

  it('personalEmail: PERSONAL row (no canLogin/verifiedAt) via returning, invite token issued on the tx, mail sent AFTER commit + audit', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ personalEmail: 'Me@Home.com', locale: 'en' }))

    expect(h.log.map((e) => e.op)).toEqual([
      'select',
      'findFirst',
      'findFirst',
      'tx-begin',
      'insert',
      'insert',
      'insert',
      'issueInvite',
      'tx-end',
      'audit',
      'sendInvite',
    ])
    const emailInserts = inserts(h.log, 'user_emails')
    expect(emailInserts[1]).toEqual({
      op: 'insert',
      on: 'tx',
      table: 'user_emails',
      returning: true,
      // address stored exactly as typed (case preserved)
      values: { userId: 'user-new', email: 'Me@Home.com', kind: 'PERSONAL' },
    })
    expect(h.issuePersonalEmailInviteTx).toHaveBeenCalledWith(h.tx, 'pe-1')
    expect(h.sendInvite).toHaveBeenCalledWith({
      to: 'Me@Home.com',
      displayName: 'Input Name',
      rawToken: 'raw-token-1',
      locale: 'en',
    })
  })

  it('invite mail locale defaults to uk (same const as users.locale)', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ personalEmail: 'me@home.com' }))
    expect(h.sendInvite).toHaveBeenCalledWith(expect.objectContaining({ locale: 'uk' }))
    expect(usersInsertValues(h.log).locale).toBe('uk')
  })

  it('invite mail carries the INPUT displayName, not the stored one', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ personalEmail: 'me@home.com' }))
    expect(h.sendInvite).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Input Name' }),
    )
  })

  it('PERSONAL insert returning no row -> no token issued and no mail (user still created)', async () => {
    const h = makeHarness({ personalRows: [] })
    await expect(h.service.createUser(baseInput({ personalEmail: 'me@home.com' }))).resolves.toBe(
      CREATED,
    )
    expect(h.issuePersonalEmailInviteTx).not.toHaveBeenCalled()
    expect(h.sendInvite).not.toHaveBeenCalled()
    expect(h.auditRecord).toHaveBeenCalledTimes(1)
  })

  it('unique violation on the WORK row -> 409 EMAIL_ALREADY_IN_USE; no audit, no team, no mail', async () => {
    const h = makeHarness({ workInsertError: uniqueViolation() })
    await expect(h.service.createUser(baseInput({ role: 'SENIOR' }))).rejects.toMatchObject(
      code('EMAIL_ALREADY_IN_USE', 409),
    )
    expect(h.auditRecord).not.toHaveBeenCalled()
    expect(h.db.insert).not.toHaveBeenCalled()
    expect(h.sendInvite).not.toHaveBeenCalled()
  })

  it('unique violation on the PERSONAL row -> 409 EMAIL_ALREADY_IN_USE; no invite, no audit, no mail', async () => {
    const h = makeHarness({ personalInsertError: uniqueViolation() })
    await expect(
      h.service.createUser(baseInput({ personalEmail: 'me@home.com' })),
    ).rejects.toMatchObject(code('EMAIL_ALREADY_IN_USE', 409))
    expect(h.issuePersonalEmailInviteTx).not.toHaveBeenCalled()
    expect(h.auditRecord).not.toHaveBeenCalled()
    expect(h.sendInvite).not.toHaveBeenCalled()
  })

  it('a non-unique user_emails failure is rethrown untouched (not mapped to 409)', async () => {
    const boom = new Error('value too long for type character varying(255)')
    const h = makeHarness({ personalInsertError: boom })
    await expect(h.service.createUser(baseInput({ personalEmail: 'me@home.com' }))).rejects.toBe(
      boom,
    )
    expect(h.auditRecord).not.toHaveBeenCalled()
  })

  it('users insert returning no row -> Error "Failed to create user" inside the tx; nothing after it runs', async () => {
    const h = makeHarness({ created: undefined })
    await expect(h.service.createUser(baseInput())).rejects.toThrow('Failed to create user')
    expect(inserts(h.log, 'user_emails')).toHaveLength(0)
    expect(h.auditRecord).not.toHaveBeenCalled()
  })

  it('transaction yielding no rows -> Error "Failed to create user" before audit', async () => {
    const h = makeHarness({ txReturnsEmpty: true })
    await expect(h.service.createUser(baseInput())).rejects.toThrow('Failed to create user')
    expect(h.auditRecord).not.toHaveBeenCalled()
  })
})

describe('UsersService.createUser — team / project linkage (post-commit, plain db handle)', () => {
  const senior = { ...CREATED, role: 'SENIOR' }
  const STAFF = { 'hr-1': 'HR', 'hr-2': 'HR', 'acc-1': 'ACCOUNTANT' }

  it('SENIOR default (CREATE_NEW): team named «Команда <displayName>» + members creator, hrIds in order, accountant', async () => {
    const h = makeHarness({ created: senior, staffRoles: STAFF })
    await h.service.createUser(
      baseInput({
        role: 'SENIOR',
        displayName: 'Ivan',
        hrIds: ['hr-1', 'hr-2'],
        accountantId: 'acc-1',
      }),
    )
    const tail = h.log.slice(h.log.findIndex((e) => e.op === 'audit') + 1)
    expect(tail).toEqual([
      { op: 'insert', on: 'db', table: 'teams', values: { name: 'Команда Ivan' } },
      // r5 4.6 S5: the memberships commit in one transaction with the senior's roster dirty row.
      { op: 'tx-begin' },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        returning: false,
        values: { teamId: 'team-new', userId: 'user-new' },
      },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        returning: false,
        values: { teamId: 'team-new', userId: 'hr-1' },
      },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        returning: false,
        values: { teamId: 'team-new', userId: 'hr-2' },
      },
      {
        op: 'insert',
        on: 'tx',
        table: 'team_members',
        returning: false,
        values: { teamId: 'team-new', userId: 'acc-1' },
      },
      { op: 'tx-end' },
    ])
    expect(h.addSeniorToDropTeam).not.toHaveBeenCalled()
  })

  it('SENIOR with no hrIds / accountant (null) -> only the creator is a member', async () => {
    const h = makeHarness({ created: senior })
    await h.service.createUser(
      baseInput({ role: 'SENIOR', teamMode: 'CREATE_NEW', accountantId: null }),
    )
    const members = inserts(h.log, 'team_members')
    expect(members.map((m) => (m.values as { userId: string }).userId)).toEqual(['user-new'])
  })

  it('SENIOR whose team insert returns no row -> no members written', async () => {
    const h = makeHarness({ created: senior, teamInsertRows: [], staffRoles: STAFF })
    await h.service.createUser(baseInput({ role: 'SENIOR', hrIds: ['hr-1'] }))
    expect(inserts(h.log, 'teams')).toHaveLength(1)
    expect(inserts(h.log, 'team_members')).toHaveLength(0)
  })

  it('SENIOR + JOIN_DROP_TEAM: attaches via TeamsService (after audit), no auto-team', async () => {
    const h = makeHarness({ created: senior })
    await h.service.createUser(
      baseInput({
        role: 'SENIOR',
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: 'dt-1',
        hrIds: ['hr-1'],
      }),
    )
    expect(h.addSeniorToDropTeam).toHaveBeenCalledTimes(1)
    expect(h.addSeniorToDropTeam).toHaveBeenCalledWith('dt-1', 'user-new')
    expect(inserts(h.log, 'teams')).toHaveLength(0)
    expect(inserts(h.log, 'team_members')).toHaveLength(0)
    const ops = h.log.map((e) => e.op)
    expect(ops.indexOf('addSeniorToDropTeam')).toBeGreaterThan(ops.indexOf('audit'))
  })

  it('SENIOR in CREATE_NEW mode ignores a stray dropTeamId: auto-team, no drop-team attach', async () => {
    const h = makeHarness({ created: senior })
    await h.service.createUser(
      baseInput({ role: 'SENIOR', teamMode: 'CREATE_NEW', dropTeamId: 'dt-1' }),
    )
    expect(h.addSeniorToDropTeam).not.toHaveBeenCalled()
    expect(inserts(h.log, 'teams')).toHaveLength(1)
    expect(inserts(h.log, 'team_members')).toHaveLength(1)
  })

  it.each(['HR', 'ACCOUNTANT', 'JUNIOR'] as const)(
    'role %s never gets an auto-team even with hrIds / accountantId',
    async (role) => {
      const h = makeHarness({ created: { ...CREATED, role } })
      await h.service.createUser(baseInput({ role, hrIds: ['hr-1'], accountantId: 'acc-1' }))
      expect(inserts(h.log, 'teams')).toHaveLength(0)
      expect(inserts(h.log, 'team_members')).toHaveLength(0)
      expect(h.addSeniorToDropTeam).not.toHaveBeenCalled()
    },
  )

  it('JUNIOR with projectId -> project_members row {projectId, userId} on the plain db', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ role: 'JUNIOR', projectId: 'proj-1' }))
    expect(inserts(h.log, 'project_members')).toEqual([
      {
        op: 'insert',
        on: 'db',
        table: 'project_members',
        returning: false,
        values: { projectId: 'proj-1', userId: 'user-new' },
      },
    ])
  })

  it.each([undefined, null, ''])(
    'JUNIOR with projectId=%j -> no project_members row',
    async (projectId) => {
      const h = makeHarness()
      await h.service.createUser(baseInput({ role: 'JUNIOR', projectId }))
      expect(inserts(h.log, 'project_members')).toHaveLength(0)
    },
  )

  it.each(['SENIOR', 'HR', 'ACCOUNTANT'] as const)(
    'projectId is ignored for role %s',
    async (role) => {
      const h = makeHarness({ created: { ...CREATED, role } })
      await h.service.createUser(baseInput({ role, projectId: 'proj-1' }))
      expect(inserts(h.log, 'project_members')).toHaveLength(0)
    },
  )

  it('team / project linkage is skipped entirely when audit fails to run (ordering: audit precedes linkage)', async () => {
    const h = makeHarness({ created: senior })
    h.auditRecord.mockRejectedValueOnce(new Error('audit down'))
    await expect(h.service.createUser(baseInput({ role: 'SENIOR' }))).rejects.toThrow('audit down')
    expect(h.db.insert).not.toHaveBeenCalled()
  })
})

describe('UsersService.createUser — SENIOR technology floor (>= 3 distinct)', () => {
  const STACKS_BELOW = [null, [], ['React'], ['React', 'Go'], ['a', 'a', 'a'], ['a', '', ' ']]

  it.each(['ADMIN', 'HR'] as const)(
    '%s creating a SENIOR with 0, 1 or 2 distinct technologies -> 400 SENIOR_MIN_TECHNOLOGIES, nothing written',
    async (actorRole) => {
      for (const techStack of STACKS_BELOW) {
        const h = makeHarness({ created: { ...CREATED, role: 'SENIOR' } })
        await expect(
          h.service.createUser(
            baseInput({ role: 'SENIOR', techStack, actorRole, actorId: 'hr-9', hrIds: [] }),
          ),
        ).rejects.toMatchObject(code('SENIOR_MIN_TECHNOLOGIES', 400))
        expect(h.db.transaction).not.toHaveBeenCalled()
        expect(inserts(h.log, 'users')).toHaveLength(0)
      }
    },
  )

  it('creating a SENIOR with exactly 3 technologies succeeds and stores them as given', async () => {
    const h = makeHarness({ created: { ...CREATED, role: 'SENIOR' } })
    await h.service.createUser(baseInput({ role: 'SENIOR', techStack: ['React', 'Go', 'Docker'] }))
    expect(usersInsertValues(h.log).techStack).toEqual(['React', 'Go', 'Docker'])
  })

  it('other roles are created without any technology', async () => {
    const h = makeHarness()
    await h.service.createUser(baseInput({ role: 'JUNIOR', techStack: null }))
    expect(inserts(h.log, 'users')).toHaveLength(1)
  })
})
