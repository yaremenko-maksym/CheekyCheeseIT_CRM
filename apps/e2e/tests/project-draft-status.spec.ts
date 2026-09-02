/**
 * project-draft-status.spec.ts — task-project-draft-status.
 *
 * Direct-API regression for the confirmation gate itself: a fresh project
 * starts DRAFT and refuses ANY income (400 PROJECT_NOT_ACTIVE_MESSAGE) until
 * every invited approver (the senior, and the drop when the project has one
 * — design spec §3 decision 4, "Проект подтверждают оба") confirms it via
 * POST /api/projects/:id/approve. A REJECTED project refuses the same way.
 *
 * Why this file exists: every OTHER real-API spec that creates a project via
 * `createDropProjectViaAPI` / `createSeniorProjectViaAPI` needs the project
 * immediately usable for income, so those two fixtures now auto-confirm by
 * default (see fixtures.ts) — which means none of them exercises the DRAFT
 * state itself. This spec passes `skipApproval: true` specifically to
 * observe the mechanism task-project-draft-status introduces, not routed
 * around it.
 *
 * Proof this spec is not vacuous: with `assertProjectActive`'s status check
 * commented out locally, every `rejects.toThrow(...)` assertion below fails
 * (the calls that should 400 instead succeed) — verified by hand while
 * writing this file, not asserted here (an E2E spec cannot toggle server
 * code under test).
 */

import { test, expect, REAL_API_BASE, SEED_ADMIN_EMAIL, SEED_EMAILS } from './fixtures'
import {
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  onboardDropViaAPI,
  createDropProjectViaAPI,
  createSeniorProjectViaAPI,
  createDropIncomeViaAPI,
  createSeniorIncomeViaAPI,
  approveProjectViaAPI,
  rejectProjectViaAPI,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Project draft-status — confirmation gate (task-project-draft-status)', () => {
  test('drop-project: DRAFT refuses drop-income, partial (senior-only) approval still refuses, both-approved → ACTIVE → income succeeds', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `draft-gate-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Draft Gate ${suffix}`,
    })

    try {
      await onboardDropViaAPI(page, { dropId, dropEmail })

      // skipApproval: true — leave the project DRAFT. Every other spec in
      // this suite wants the auto-confirmed default; this one exists
      // specifically to NOT take it.
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
        skipApproval: true,
      })

      // 1. DRAFT — the routed DROP cannot declare income yet. Server-side
      // refusal, not a UI-only restriction (no dialog exists to even try).
      await loginViaApi(page, dropEmail)
      // Message assertion (not just "some 400") proves it's THIS gate
      // that fired, not an unrelated validation error.
      await expect(createDropIncomeViaAPI(page, { projectId, amount: 1000 })).rejects.toThrow(
        'Проект ещё не подтверждён',
      )

      // 2. Partial approval — senior confirms, drop has not. Still DRAFT:
      // the gate requires EVERY invited approver, not the first one.
      const afterSenior = await approveProjectViaAPI(page, projectId, SEED_EMAILS.seniorA)
      expect(afterSenior.status).toBe('DRAFT')

      await loginViaApi(page, dropEmail)
      // One of two invited approvers confirming must not be enough.
      await expect(createDropIncomeViaAPI(page, { projectId, amount: 1000 })).rejects.toThrow(
        'Проект ещё не подтверждён',
      )

      // 3. Drop confirms too — every invited approver has now agreed → ACTIVE.
      const afterDrop = await approveProjectViaAPI(page, projectId, dropEmail)
      expect(afterDrop.status).toBe('ACTIVE')

      // 4. Income creation now succeeds through the SAME endpoint that
      // refused it in steps 1 and 2 — proves the gate is status-driven, not
      // a permanently broken endpoint.
      await loginViaApi(page, dropEmail)
      const { status } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })
      expect(status).toBe('PENDING')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('senior-only project: REJECTED refuses senior-income the same way DRAFT does', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      name: `Draft Reject Project ${suffix}`,
      skipApproval: true,
    })

    try {
      const rejected = await rejectProjectViaAPI(
        page,
        projectId,
        SEED_EMAILS.seniorA,
        'Не согласен с условиями',
      )
      expect(rejected.status).toBe('REJECTED')

      await loginViaApi(page, SEED_EMAILS.seniorA)
      // A REJECTED project must refuse income exactly like DRAFT.
      await expect(createSeniorIncomeViaAPI(page, { projectId, amount: 500 })).rejects.toThrow(
        'Проект ещё не подтверждён',
      )
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
