import { USERS, type MockUser } from './mock-data'

// ---------------------------------------------------------------------------
// UserWithPermissionsResponse builders — used by profile-page specs
// ---------------------------------------------------------------------------

/** Shared profile-DTO fields not present on the fixture seed users. */
function profileExtras(user: MockUser) {
  return {
    walletUsdtErc20: user.paymentMethod === 'USDT_ERC20' ? '0x1234567890abcdef' : null,
    walletUsdtLabel: null,
    bankUahRecipient: user.paymentMethod === 'BANK_UAH_FOP' ? 'Test User' : null,
    bankUahIban: user.paymentMethod === 'BANK_UAH_FOP' ? 'UA213223130000026007233566001' : null,
    bankUahRnokpp: user.paymentMethod === 'BANK_UAH_FOP' ? '1234567890' : null,
    bankUahBankName: null,
    archivedAt: null,
    adminNote: null,
    // Drop role - phase 1: nullable for non-DROP roles. Default 5 for the
    // drop seed user (overridden per-user in USERS).
    dropSharePercent:
      'dropSharePercent' in user ? (user as { dropSharePercent: number }).dropSharePercent : null,
  }
}

/** Full admin viewing anyone: all tabs + all actions */
export function buildAdminViewingUser(targetUser: MockUser): object {
  // ADMIN viewing non-ADMIN: includes 'contract' tab (A3-2).
  // ADMIN viewing another ADMIN (self or peer): no 'contract' tab (ADMINs have no contracts).
  const contractTab = targetUser.role !== 'ADMIN' ? ['contract'] : []
  // task-resume-base §4: the resume tab exists ONLY on a SENIOR card. Mirrors
  // users-access.service.ts (`targetIsSenior && canSeeResumeTab(...)`), appended
  // last so no existing tab shifts position.
  const resumeTab = targetUser.role === 'SENIOR' ? ['resume'] : []
  // RBAC 2026-06-09: ADMIN can view+edit legend of SENIOR/DROP targets (subject excluded)
  const legendField =
    targetUser.role === 'SENIOR' || targetUser.role === 'DROP' ? { legend: true as const } : {}
  return {
    user: { ...targetUser, ...profileExtras(targetUser) },
    permissions: {
      tabs: [
        'overview',
        'finance',
        'projects',
        'team',
        'requisites',
        'documents',
        ...contractTab,
        ...resumeTab,
      ],
      actions: [
        'edit-profile',
        'change-role',
        'change-salary',
        'change-requisites',
        'set-note',
        'archive',
      ],
      fields: {
        salary: true,
        share: true,
        paymentMethodKpi: true,
        techStack: true,
        registrationDate: true,
        ...legendField,
      },
    },
    data: {},
  }
}

/** HR viewing their own senior: overview + projects + team only, no actions.
 *  RBAC 2026-06-09: HR can view+edit legend of SENIOR/DROP in their team. */
export function buildHrViewingSenior(senior: (typeof USERS)[keyof typeof USERS]): object {
  const isLegendTarget = senior.role === 'SENIOR' || senior.role === 'DROP'
  // task-resume-base §4: HR maintains a senior's resume, so the tab is present
  // for a SENIOR target (mirrors users-access.service.ts).
  const resumeTab = senior.role === 'SENIOR' ? ['resume'] : []
  return {
    user: { ...senior, ...profileExtras(senior) },
    permissions: {
      tabs: ['overview', 'projects', 'team', ...resumeTab],
      actions: [],
      fields: {
        techStack: true,
        registrationDate: true,
        ...(isLegendTarget ? { legend: true as const } : {}),
      },
    },
    data: {},
  }
}

/** JUNIOR viewing their senior: overview only, no actions.
 *  RBAC 2026-06-09: JUNIOR can view+edit legend of their SENIOR/DROP. */
export function buildJuniorViewingSenior(senior: (typeof USERS)[keyof typeof USERS]): object {
  const isLegendTarget = senior.role === 'SENIOR' || senior.role === 'DROP'
  return {
    user: { ...senior, ...profileExtras(senior) },
    permissions: {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: {
        techStack: true,
        registrationDate: true,
        ...(isLegendTarget ? { legend: true as const } : {}),
      },
    },
    data: {},
  }
}

/** Junior viewing another junior: header only, no tabs, no actions */
export function buildJuniorViewingJunior(targetUser: (typeof USERS)[keyof typeof USERS]): object {
  return {
    user: { ...targetUser, ...profileExtras(targetUser) },
    permissions: {
      tabs: [],
      actions: [],
      fields: {},
    },
    data: {},
  }
}

/** Self-view response (used by GET /users/me on profile page) */
export function buildSelfView(user: MockUser): object {
  // Mirrors users-access.service.ts isSelf branch exactly.
  //
  // JUNIOR self-view is an EXPLICIT allow-list (data-privacy, task-junior-ut-round2 §3 +
  // PR #188 fixture-fidelity fix §6a): ONLY overview / requisites.
  // MUST NOT include documents / finance / projects / team — those surface senior
  // identity and project internals. Mirrors users-access.service.ts:84 exactly:
  //   tabs.push('overview', 'requisites')
  //
  // DROP: overview / finance / team / requisites / documents / contract.
  //   Mirrors users-access.service.ts isSelf branch (task-drop-phase3-frontend):
  //     tabs.push('overview', 'finance', 'team', 'requisites', 'documents', 'contract')
  //   NOTE: 'projects' removed — /routing hub is the canonical project surface
  //   for DROP. 'contract' added — DROP has a signed employee_contract and must see
  //   it in their own profile (UT finding 3a, drop-phase3-frontend round 2).
  //   Updated 2026-06-13 (PR #198 drop-phase3-frontend).
  //
  // Everyone else (SENIOR, HR, ACCOUNTANT, ADMIN):
  //   overview / projects / team / requisites / documents
  //   + finance for SENIOR / HR / ACCOUNTANT.
  let tabs: string[]
  if (user.role === 'JUNIOR') {
    // Explicit allow-list — no documents, no finance, no projects, no team.
    tabs = ['overview', 'requisites']
  } else if (user.role === 'DROP') {
    // task-drop-phase3-frontend: 'projects' excluded (routing hub is canonical),
    // 'contract' included (DROP views own signed contract).
    tabs = ['overview', 'finance', 'team', 'requisites', 'documents', 'contract']
  } else {
    tabs = ['overview', 'projects', 'team', 'requisites', 'documents']
    if (user.role === 'SENIOR' || user.role === 'HR' || user.role === 'ACCOUNTANT') {
      tabs.push('finance')
    }
    // task-resume-base §4: a SENIOR maintains their OWN resume, so their
    // self-view carries the tab. Appended last, mirroring users-access.service.
    if (user.role === 'SENIOR') tabs.push('resume')
  }

  const isSalaryRole = user.role === 'JUNIOR' || user.role === 'HR' || user.role === 'ACCOUNTANT'
  const isShareRole = user.role === 'SENIOR' || user.role === 'ADMIN' || user.role === 'DROP'

  return {
    user: { ...user, ...profileExtras(user) },
    permissions: {
      tabs,
      actions: [],
      fields: {
        salary: isSalaryRole,
        share: isShareRole,
        paymentMethodKpi: true,
        registrationDate: true,
        techStack: true,
        requisites: true,
      },
    },
    data: {},
  }
}
