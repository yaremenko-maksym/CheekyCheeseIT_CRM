// Barrel: every spec imports from './fixtures'. The implementation lives in
// ./fixtures/* (mock data, route mocks, real-API helpers) — split to keep each
// file <= 800 lines. Export surface is identical to the former single file.
import type { Page, Route } from '@playwright/test'

// Re-exported so specs can take their Playwright types from the same barrel
// they already import `test` / `expect` / fixtures from. persist-query.spec.ts
// has imported `type Page` from here since it was written; the import was
// simply never valid (`Module './fixtures' declares 'Page' locally, but it is
// not exported`) and nothing ran `tsc` over this package to say so.
// (task-lint-teeth)
export type { Page, Route }

export {
  USERS,
  ALL_USERS,
  TEAMS,
  DROP_TEAM,
  DROP_TEAM_VACANT,
  ALL_TEAMS,
  PROJECTS,
  INTERVIEWS,
} from './fixtures/mock-data'

export {
  buildAdminViewingUser,
  buildHrViewingSenior,
  buildJuniorViewingSenior,
  buildJuniorViewingJunior,
  buildSelfView,
} from './fixtures/view-builders'

export { API_GLOB, API_RE } from './fixtures/route-helpers'

export { mockAuthAs, test, expect, waitForPageReady, dismissDialog } from './fixtures/mock-auth'

export {
  REAL_API_BASE,
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  VALID_USDT_WALLET,
  MAKSYM_ID,
  KOSTYA_ID,
} from './fixtures/api-helpers/common'

export { loginViaApi, findUserByEmailViaApi } from './fixtures/api-helpers/auth'

export {
  createDropViaAPI,
  addSeniorToDropTeamViaAPI,
  archiveDropTeamViaAPI,
  getTeamViaAPI,
  getTeamAuditLogViaAPI,
  getUserViaAPI,
  getDropProjectsViaAPI,
  cleanupDropViaAPI,
} from './fixtures/api-helpers/drop'

export {
  approveProjectViaAPI,
  rejectProjectViaAPI,
  createDropProjectViaAPI,
  createSeniorProjectViaAPI,
} from './fixtures/api-helpers/project'

export {
  createDropIncomeViaAPI,
  createSeniorIncomeViaAPI,
  validateTransactionViaAPI,
} from './fixtures/api-helpers/transaction'

export {
  createPayoutRequestViaAPI,
  payPayoutRequestViaAPI,
  listPayoutRequestTransactionsViaAPI,
  listTransactionsByProjectViaAPI,
  patchUserSharePercentViaAPI,
  approveUserSeniorShareViaAPI,
  approveProjectSeniorShareViaAPI,
  getTransactionViaAPI,
  confirmPayoutViaAPI,
  confirmPayoutRawViaAPI,
  findPendingPayoutsForProjectViaAPI,
} from './fixtures/api-helpers/payout'

export {
  onboardDropViaAPI,
  signContractAndAcceptTosViaAPI,
  declareUsdtIncomeViaAPI,
} from './fixtures/api-helpers/contract'

export {
  ensureCompanyWalletViaAPI,
  settleObligationBySourceTransactionViaAPI,
  getCompanyAccountBalanceViaAPI,
  getDropSelfSummaryViaAPI,
} from './fixtures/api-helpers/company-account'
