/**
 * Unit tests — SENIOR/JUNIOR member identity masking in ProjectsService.mapProject.
 *
 * task-junior-masking-server-test (backlog item 32). The masking that hides a
 * JUNIOR project member's identity from a SENIOR viewer lives entirely on the
 * server (`mapProject`'s `members` mapping) and was, until this spec, covered
 * by ZERO tests in `apps/api`. The only nominal guard was an E2E spec with a
 * mocked HTTP response that hard-codes the JUNIOR's real name in the members
 * array — i.e. exactly the response the real server refuses to produce. The
 * mocked test was green while asserting a situation that cannot happen. This
 * is the fourth recurrence of that pattern (see memory `feedback_mocked_e2e_guards`
 * — incidents #157 / #158 were real data-leaks hiding behind the same shape
 * of false confidence).
 *
 * Target (apps/api/src/projects/projects.service.ts, `mapProject`):
 *   const isJuniorMember = (m.user?.role ?? 'JUNIOR') === 'JUNIOR'
 *   const redact = viewerRole === 'SENIOR' && isJuniorMember
 *   ...
 *   userId: redact ? '[redacted]' : m.userId,
 *   displayName: redact ? '' : (m.user?.displayName ?? ''),
 *   email: redact ? '' : (m.user?.email ?? ''),
 *   avatarUrl: redact ? null : (m.user?.avatarUrl ?? null),
 *   avatarDocumentId: redact ? null : (m.user?.avatarDocumentId ?? null),
 *
 * Scenarios (each pins ONE half of the `redact` guard in isolation):
 *
 *   MEMBER-MASK-1  SENIOR viewer, JUNIOR member  → redacted (displayName='',
 *                  userId='[redacted]', email='', avatarUrl/avatarDocumentId
 *                  null). Direct assertion that AC1 (task file) demands.
 *
 *   MEMBER-MASK-2  SENIOR viewer, HR member — SAME project, NOT a JUNIOR →
 *                  NOT redacted. Removing `isJuniorMember` from the guard
 *                  (leaving only `viewerRole === 'SENIOR'`) makes this test
 *                  fail: every member would be redacted for a SENIOR viewer,
 *                  including the HR member. This is what pins the
 *                  `isJuniorMember` half specifically (AC3, half 2).
 *
 *   MEMBER-MASK-3  ADMIN viewer, the SAME JUNIOR member → NOT redacted
 *                  (reverse-direction control, AC2). Removing
 *                  `viewerRole === 'SENIOR'` from the guard (leaving only
 *                  `isJuniorMember`) makes this test fail: every viewer,
 *                  including ADMIN, would redact JUNIOR members. This is
 *                  what pins the `viewerRole === 'SENIOR'` half specifically
 *                  (AC3, half 1). Without this scenario a passing test only
 *                  proves "JUNIOR members are always masked", not "masked
 *                  specifically from SENIOR" — see task file "Почему это
 *                  важнее, чем выглядит".
 *
 *   MEMBER-MASK-4  ADMIN viewer, HR member → NOT redacted (trivial positive
 *                  control, completes the 2x2 grid started by 1/2/3).
 *
 * Mutation-testing proof (AC3): both halves of the guard were verified by
 * hand — temporarily deleting each half of the condition in
 * `projects.service.ts`, running `pnpm --filter @crm/api test -- senior-junior-member-mask`,
 * observing the expected test fail, then reverting (source unchanged in this
 * PR — see PR body for the two failing-run transcripts, not committed here).
 *
 * Fixture note (AC5): the JUNIOR member's raw displayName/userId/email/avatar
 * values are realistic, non-default, non-empty data — deliberately NOT equal
 * to the masked placeholders ('' / '[redacted]' / null). A fixture that
 * accidentally used an empty displayName or a literal '[redacted]' userId
 * would make "masked by the server" and "forgot to seed the fixture"
 * indistinguishable (see task file AC5 + prior incident referenced there).
 *
 * Harness: pure unit test, no real DB — mirrors the established pattern in
 * `senior-drop-mask.unit.spec.ts` (assertAccess + loadTeamOverridesBySenior
 * stubbed via vi.spyOn so the RBAC gate and the finance-share resolver don't
 * get in the way of exercising the mapping/masking logic under test). Reaches
 * `mapProject` through the PUBLIC `ProjectsService.findOne` — no HTTP layer,
 * no supertest/app.inject, so this cannot be fooled by a mocked response the
 * way the E2E spec was.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

const S1_ID = 'senior-uuid-9001'

const seniorViewer: SessionUser = {
  id: S1_ID,
  email: 'senior@x.com',
  displayName: 'Senior One',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const adminViewer: SessionUser = {
  id: 'admin-uuid-9001',
  email: 'admin@company.com',
  displayName: 'Admin User',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// Member identities — realistic, non-default values (AC5)
// ---------------------------------------------------------------------------

/** JUNIOR member of the project — must be masked from the SENIOR viewer. */
const J1_ID = 'junior-real-uuid-2077'
const J1_DISPLAY_NAME = 'Иван Джуниоров'
const J1_EMAIL = 'ivan.juniorov@cheekycheese.dev'
const J1_AVATAR_URL = 'https://cdn.example.com/avatars/ivan.png'
const J1_AVATAR_DOCUMENT_ID = 'doc-avatar-junior-2077'

/** HR member of the SAME project — NOT a JUNIOR, must never be masked from SENIOR. */
const H1_ID = 'hr-real-uuid-3088'
const H1_DISPLAY_NAME = 'Ольга HR-івна'
const H1_EMAIL = 'olga.hr@cheekycheese.dev'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeProjectWithMembers() {
  return {
    id: 'proj-member-mask-001',
    name: 'Member Mask Project',
    companyName: 'MaskCorp',
    domain: 'maskcorp.io',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: S1_ID,
    dropId: null,
    rate: 4500,
    currency: 'USDT',
    seniorSharePercentOverride: null,
    techStack: 'TypeScript, NestJS',
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    senior: {
      id: S1_ID,
      displayName: 'Senior One',
      email: 'senior@x.com',
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'SENIOR',
      seniorSharePercent: 26,
    },
    drop: null,
    legend: null,
    // `id` is the project_members row id — NEVER redacted by mapProject
    // (only userId/displayName/email/avatar* are), so tests below locate a
    // member by `.id` and keep working regardless of the masking outcome.
    members: [
      {
        id: 'pm-junior-001',
        userId: J1_ID,
        joinedAt: new Date('2026-01-05'),
        leftAt: null,
        user: {
          id: J1_ID,
          displayName: J1_DISPLAY_NAME,
          email: J1_EMAIL,
          avatarUrl: J1_AVATAR_URL,
          avatarDocumentId: J1_AVATAR_DOCUMENT_ID,
          role: 'JUNIOR',
        },
      },
      {
        id: 'pm-hr-001',
        userId: H1_ID,
        joinedAt: new Date('2026-01-06'),
        leftAt: null,
        user: {
          id: H1_ID,
          displayName: H1_DISPLAY_NAME,
          email: H1_EMAIL,
          avatarUrl: null,
          avatarDocumentId: null,
          role: 'HR',
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Harness (mirrors senior-drop-mask.unit.spec.ts)
// ---------------------------------------------------------------------------

function buildHarness(project: ReturnType<typeof makeProjectWithMembers>) {
  const db = {
    db: {
      query: {
        projects: { findFirst: async () => ({ ...project }) },
        users: { findFirst: async () => null },
        projectFinanceSettings: { findFirst: async () => null },
        teamMembers: { findFirst: async () => null, findMany: async () => [] },
        transactions: { findMany: async () => [] },
      },
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
          innerJoin: () => ({ where: () => Promise.resolve([]) }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({ values: async () => undefined }),
    },
  }

  const auditLog = {
    record: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ entries: [], total: 0 })),
  }
  const usersSvc = { unarchive: vi.fn(), unarchivePairTx: vi.fn() }
  const hrAccess = new HrAccessService(db as never)

  const service = new ProjectsService(db as never, auditLog as never, usersSvc as never, hrAccess)

  // Bypass the access gate + team-override load — this spec targets the
  // mapping/masking logic (mapProject), not the RBAC gate or the finance
  // share resolver (both already covered elsewhere).
  vi.spyOn(service as never, 'assertAccess').mockResolvedValue(undefined)
  vi.spyOn(service as never, 'loadTeamOverridesBySenior').mockResolvedValue(new Map())

  return { service }
}

function findMemberById<T extends { id: string }>(members: T[], id: string): T {
  const found = members.find((m) => m.id === id)
  if (!found) throw new Error(`member ${id} not found in mapped result`)
  return found
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapProject — SENIOR/JUNIOR member identity masking', () => {
  it('MEMBER-MASK-1. SENIOR viewer, JUNIOR member → redacted (name/id/email/avatar)', async () => {
    const { service } = buildHarness(makeProjectWithMembers())
    const result = await service.findOne('proj-member-mask-001', seniorViewer)
    const junior = findMemberById(result.members, 'pm-junior-001')

    expect(junior.userId, 'SENIOR viewer: JUNIOR userId must be redacted').toBe('[redacted]')
    expect(junior.displayName, 'SENIOR viewer: JUNIOR displayName must be empty').toBe('')
    expect(junior.email, 'SENIOR viewer: JUNIOR email must be empty').toBe('')
    expect(junior.avatarUrl, 'SENIOR viewer: JUNIOR avatarUrl must be null').toBeNull()
    expect(
      junior.avatarDocumentId,
      'SENIOR viewer: JUNIOR avatarDocumentId must be null',
    ).toBeNull()
  })

  it('MEMBER-MASK-2. SENIOR viewer, HR member (non-JUNIOR, same project) → NOT redacted', async () => {
    const { service } = buildHarness(makeProjectWithMembers())
    const result = await service.findOne('proj-member-mask-001', seniorViewer)
    const hr = findMemberById(result.members, 'pm-hr-001')

    // Pins the `isJuniorMember` half of the guard: if that half were dropped,
    // every member (HR included) would be redacted for a SENIOR viewer and
    // these assertions would fail.
    expect(hr.userId, 'SENIOR viewer: HR userId must stay real').toBe(H1_ID)
    expect(hr.displayName, 'SENIOR viewer: HR displayName must stay real').toBe(H1_DISPLAY_NAME)
    expect(hr.email, 'SENIOR viewer: HR email must stay real').toBe(H1_EMAIL)
  })

  it('MEMBER-MASK-3. ADMIN viewer, the SAME JUNIOR member → NOT redacted (reverse direction)', async () => {
    const { service } = buildHarness(makeProjectWithMembers())
    const result = await service.findOne('proj-member-mask-001', adminViewer)
    const junior = findMemberById(result.members, 'pm-junior-001')

    // Pins the `viewerRole === 'SENIOR'` half of the guard: if that half were
    // dropped, every viewer (ADMIN included) would redact JUNIOR members and
    // these assertions would fail. Without this scenario, MEMBER-MASK-1 alone
    // only proves "JUNIOR members are always masked" — not "masked
    // specifically from SENIOR viewers".
    expect(junior.userId, 'ADMIN viewer: JUNIOR userId must be the real id').toBe(J1_ID)
    expect(junior.displayName, 'ADMIN viewer: JUNIOR displayName must be real').toBe(
      J1_DISPLAY_NAME,
    )
    expect(junior.email, 'ADMIN viewer: JUNIOR email must be real').toBe(J1_EMAIL)
    expect(junior.avatarUrl, 'ADMIN viewer: JUNIOR avatarUrl must be real').toBe(J1_AVATAR_URL)
    expect(junior.avatarDocumentId, 'ADMIN viewer: JUNIOR avatarDocumentId must be real').toBe(
      J1_AVATAR_DOCUMENT_ID,
    )
  })

  it('MEMBER-MASK-4. ADMIN viewer, HR member → NOT redacted (positive control)', async () => {
    const { service } = buildHarness(makeProjectWithMembers())
    const result = await service.findOne('proj-member-mask-001', adminViewer)
    const hr = findMemberById(result.members, 'pm-hr-001')

    expect(hr.userId).toBe(H1_ID)
    expect(hr.displayName).toBe(H1_DISPLAY_NAME)
    expect(hr.email).toBe(H1_EMAIL)
  })
})
