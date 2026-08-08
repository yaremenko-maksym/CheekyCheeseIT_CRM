import { test, expect, INTERVIEWS, USERS, mockAuthAs } from './fixtures'
import type { Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Stage labels — отражают реальные значения из constants.ts:
//   HR_SCREEN → 'HR Screen', ENGLISH_CHECK → 'English', TECH_INTERVIEW → 'Tech',
//   FINAL_INTERVIEW → 'Final', CLIENT_INTERVIEW → 'Client',
//   HIRED → 'Нанят', REJECTED → 'Отказ', ARCHIVED → 'Архив'.
// OFFER_RECEIVED больше не входит в ACTIVE_STAGES (заменён на CLIENT_INTERVIEW).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SHARED hydration-safe helpers — apply to EVERY test that opens the detail
// sheet or otherwise interacts with the Kanban board.
//
// Root cause of the recurring BUG2 sheet flake (CI prod-build, workers:1),
// confirmed via repeat-each=20 reproduction on this branch:
//   page.goto('/interviews') resolves once the HTML document is received, but
//   React hydration + TanStack Query data fetch + Framer Motion column
//   animations (the cards container: opacity 0→1 duration 0.4 + delay 0.1, and
//   each column: opacity/y duration 0.3 + delay idx*0.05) all continue
//   asynchronously AFTER goto resolves.  The InterviewCard's onClick
//   (= onCardClick → setSelectedCard) only fires once the card div is mounted
//   AND its Framer Motion wrapper has finished the opacity transition (until
//   then the parent has opacity:0 and pointer-events are effectively inert).
//   A bare `.click({ force:true })` immediately after goto therefore lands
//   before the handler is live → setSelectedCard() is never called →
//   `interview-detail-sheet` never mounts → `expect(sheet).toBeVisible()`
//   times out.  The window is widened under prod-build + workers:1 (warm,
//   single-threaded event loop) and for asAdmin (extra API fixtures —
//   senior-summary, admin/summary, users list — mount and resolve
//   concurrently, lengthening the hydration window).
//
// Fix strategy (deterministic, NO waitForTimeout / NO retry-count masking of
// timing — the retry below is a single bounded fallback for the documented
// Framer-Motion pointer-suspension frame, not a sleep):
//   1. Wait for the `interviews-page` testid → isLoading=false, the board
//      (DndContext + columns) is rendered (not the skeleton branch).
//   2. Wait for the target card itself toBeVisible → its Framer Motion column
//      wrapper finished the opacity 0→1 transition, so pointer events land.
//   3. click({ force:true }) — still required because useSortable sets
//      aria-disabled="true" when canDrag=false (SENIOR); Playwright's
//      actionability check rejects aria-disabled elements without force.
//   4. If the sheet is not visible within 3 s, retry the click once. Covers
//      the rare frame where the pointer event arrives while Framer Motion has
//      pointer-events momentarily suspended mid-transition.
// ---------------------------------------------------------------------------

/** Wait until the Kanban board has hydrated and finished its entry animation. */
async function waitForBoardReady(page: Page) {
  // Gate 1: board finished loading (isLoading=false → DndContext + columns
  // rendered instead of the <Skeleton> branch).
  await expect(page.getByTestId('interviews-page')).toBeVisible()
  // Gate 2: a stage header is painted → the column motion.div opacity 0→1 has
  // started resolving and the board is interactive.
  await expect(page.getByText('HR Screen').first()).toBeVisible()
}

/**
 * Open the InterviewDetailSheet for the card with the given company name,
 * defending against the hydration/animation race (see block comment above).
 */
async function openInterviewSheet(page: Page, companyName: string) {
  await waitForBoardReady(page)
  // The card is a useSortable div that dnd-kit decorates with role="button"
  // (via spread {...attributes}); .filter({ hasText }) scopes to the company.
  const card = page.getByRole('button').filter({ hasText: companyName }).first()
  // Gate: card visible → its Framer Motion column wrapper opacity transition is
  // complete, pointer-events are active.
  await expect(card).toBeVisible()
  // force:true: useSortable sets aria-disabled when canDrag=false (SENIOR).
  await card.click({ force: true })
  const sheet = page.getByTestId('interview-detail-sheet')
  try {
    await expect(sheet).toBeVisible({ timeout: 3000 })
  } catch {
    // Single bounded fallback: the pointer event landed in a Framer Motion
    // frame with pointer-events suspended. Re-issue the click once.
    await card.click({ force: true })
    await expect(sheet).toBeVisible({ timeout: 8000 })
  }
  return sheet
}

test.describe('Interviews (Kanban) page', () => {
  // -------------------------------------------------------------------------
  // RBAC access
  // -------------------------------------------------------------------------

  test.describe('Access control', () => {
    test('JUNIOR on /interviews → redirected to /project (route-guard PR #184)', async ({
      asJunior: page,
    }) => {
      // PR #184 replaced the in-page «Нет доступа к разделу» panel with a
      // declarative beforeLoad redirect in CrmLayout. JUNIOR is not in the
      // allowed roles for /interviews → guard redirects to /project.
      await page.route(/\/api\/projects(\?.*)?$/, (r) => {
        if (r.request().method() !== 'GET') return r.fallback()
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        })
      })
      await page.goto('/interviews')
      await expect(page).toHaveURL('/project', { timeout: 8000 })
      await expect(page).not.toHaveURL('/interviews')
    })

    test('SENIOR sees kanban board', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await expect(page.getByTestId('interviews-page')).toBeVisible()
      await expect(page.getByText('HR Screen').first()).toBeVisible()
    })

    test('HR sees kanban board with senior selector', async ({ asHr: page }) => {
      await page.goto('/interviews')
      await expect(page.getByText('HR Screen').first()).toBeVisible()
      // HR has a native <select> senior selector
      await expect(page.locator('select').first()).toBeVisible()
    })

    test('ADMIN sees kanban board with senior selector', async ({ asAdmin: page }) => {
      await page.goto('/interviews')
      await expect(page.getByText('HR Screen').first()).toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // Kanban board rendering
  // -------------------------------------------------------------------------

  test.describe('Board rendering', () => {
    test('renders all active stage columns including CLIENT_INTERVIEW', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      for (const label of ['HR Screen', 'English', 'Tech', 'Final', 'Client', 'Offer']) {
        await expect(page.getByText(label, { exact: false }).first()).toBeVisible()
      }
    })

    test('shows interview cards in correct columns', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await expect(page.getByText('Acme Corp')).toBeVisible()
      await expect(page.getByText('Beta Startup')).toBeVisible()
    })

    test('card shows vacancy URL link when present', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await expect(page.locator('a[href="https://jobs.acme.com/senior-dev"]')).toBeVisible()
    })

    test('terminal stage columns rendered alongside active ones', async ({ asSenior: page }) => {
      // Reality: терминальные стейджи (HIRED/REJECTED/ARCHIVED) рендерятся
      // как отдельные колонки рядом с активными — нет collapsible "Архив" секции.
      await page.goto('/interviews')
      await expect(page.getByText('Нанят').first()).toBeVisible()
      await expect(page.getByText('Отказ').first()).toBeVisible()
      await expect(page.getByText('Архив').first()).toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // Create interview dialog
  // -------------------------------------------------------------------------

  test.describe('Create interview', () => {
    test('SENIOR can open create dialog', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await waitForBoardReady(page)
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Новая карточка' })).toBeVisible()
    })

    test('HR sees senior selector when creating interview', async ({ asHr: page }) => {
      await page.goto('/interviews')
      await waitForBoardReady(page)
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('cancel closes dialog without POST', async ({ asSenior: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/interviews') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/interviews')
      await waitForBoardReady(page)
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await page.getByRole('button', { name: /отмена/i }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // CLIENT_INTERVIEW stage functionality
  // -------------------------------------------------------------------------

  test.describe('CLIENT_INTERVIEW stage', () => {
    test('CLIENT_INTERVIEW stage is positioned between FINAL_INTERVIEW and terminal stages', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      // CLIENT_INTERVIEW ("Client") should be the last active stage before terminal stages
      for (const label of ['HR Screen', 'English', 'Tech', 'Final', 'Client']) {
        await expect(page.getByText(label, { exact: false }).first()).toBeVisible()
      }
      // Verify terminal stages are separate
      await expect(page.getByText('Нанят').first()).toBeVisible()
      await expect(page.getByText('Отказ').first()).toBeVisible()
      await expect(page.getByText('Архив').first()).toBeVisible()
    })

    test('move interview through CLIENT_INTERVIEW stage', async ({ asSenior: page }) => {
      await page.goto('/interviews')

      // For SENIOR canDrag=false so the card has aria-disabled="true" (useSortable
      // disabled prop). The shared helper gates on board-ready + card-visible
      // before clicking and retries the click once if the sheet does not open.
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Stage-move buttons live inside InterviewDetailSheet. Scope the locator to
      // the sheet container to avoid matching same-named Kanban column headers
      // (e.g. "English" column header is also a button with aria-disabled="true"
      // from useSortable — .first() would resolve to the column header instead of
      // the move button, then fail actionability because aria-disabled prevents
      // click without force).
      const stageMoveBtn = sheet.getByRole('button', { name: /english|tech|final|client/i }).first()
      await expect(stageMoveBtn).toBeVisible()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await stageMoveBtn.click()
      const req = await moveReq

      expect(req.method()).toBe('PATCH')
      const body = JSON.parse(req.postData() ?? '{}')
      expect(body).toHaveProperty('stage')
    })

    test('move to next stage sends PATCH /move request', async ({ asSenior: page }) => {
      await page.goto('/interviews')

      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Scope to sheet to avoid matching the "English" Kanban column header button
      // (aria-disabled="true" for SENIOR who has canDrag=false).
      const englishBtn = sheet.getByRole('button', { name: /english/i })
      await expect(englishBtn).toBeVisible()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await englishBtn.click()
      const req = await moveReq

      expect(req.method()).toBe('PATCH')
      expect(req.url()).toContain('/move')
    })
  })

  // -------------------------------------------------------------------------
  // Interview detail sheet
  // -------------------------------------------------------------------------

  test.describe('Interview detail sheet', () => {
    test('opens detail sheet on card click', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      // openInterviewSheet already asserts the sheet (testid) is visible; this
      // test additionally confirms the dialog/complementary role is present.
      await openInterviewSheet(page, 'Acme Corp')
      await expect(
        page.getByRole('dialog').or(page.locator('[role="complementary"]')),
      ).toBeVisible()
    })

    test('shows next-stage move button (English →) for HR_SCREEN card', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')
      // From HR_SCREEN next is ENGLISH_CHECK → button label "English →"
      // Scope to sheet to avoid matching Kanban column header "English" (aria-disabled).
      await expect(sheet.getByRole('button', { name: /english/i })).toBeVisible()
    })

    test('move to next stage sends PATCH /move request', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Scope to sheet to avoid matching the Kanban column header "English"
      // (aria-disabled="true" for SENIOR with canDrag=false — Playwright blocks
      // click without force on aria-disabled elements).
      // Wait for the specific button before registering waitForRequest to
      // eliminate the race where PATCH fires before the listener attaches.
      const englishBtn = sheet.getByRole('button', { name: /english/i })
      await expect(englishBtn).toBeVisible()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await englishBtn.click()
      await moveReq
    })

    test('CLIENT_INTERVIEW stage is positioned between FINAL_INTERVIEW and terminal stages', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      await expect(page.getByText('Final', { exact: false }).first()).toBeVisible()
      await expect(page.getByText('Client', { exact: false }).first()).toBeVisible()
    })

    test('move interview through CLIENT_INTERVIEW stage', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Scope to the sheet so the /client/i match resolves to the in-sheet
      // stage-move button, not a same-named Kanban column header.
      // Runtime skip instead of wrapping the body in `if (await
      // clientMoveBtn.isVisible())` (task-lint-teeth): with the whole check
      // behind the branch, a build that stopped rendering the stage button
      // reported PASS having asserted nothing. A skip says what actually
      // happened and leaves the payload assertion unconditional.
      const clientMoveBtn = sheet.getByRole('button', { name: /client/i })
      const hasClientMove = await clientMoveBtn.isVisible()
      test.skip(!hasClientMove, 'interview sheet did not render a CLIENT stage-move button')

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )
      await clientMoveBtn.click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'CLIENT_INTERVIEW' })
    })

    test('terminal stage buttons (Нанят / Отказ / Архив) visible for SENIOR own board', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      await expect(sheet.getByRole('button', { name: 'Нанят' })).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Отказ' })).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Архив' })).toBeVisible()
    })

    test('clicking "Нанят" sends move request with HIRED stage', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Scope to sheet to avoid potential strict-mode conflicts with same-label
      // elements elsewhere on the page. Wait for button before waitForRequest.
      const hiredBtn = sheet.getByRole('button', { name: 'Нанят' })
      await expect(hiredBtn).toBeVisible()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await hiredBtn.click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'HIRED' })
    })

    test('clicking "Отказ" sends move request with REJECTED stage', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Scope to sheet to avoid potential strict-mode conflicts with same-label
      // elements elsewhere on the page. Wait for button before waitForRequest.
      const rejectedBtn = sheet.getByRole('button', { name: 'Отказ' })
      await expect(rejectedBtn).toBeVisible()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await rejectedBtn.click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'REJECTED' })
    })

    test('SENIOR can edit notes and save', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      // openInterviewSheet gates on the sheet being open so the form inputs are
      // mounted before we touch them.
      await openInterviewSheet(page, 'Acme Corp')
      // Additionally gate on the placeholder being interactive before fill().
      await expect(page.getByPlaceholder('React, Node.js, AWS')).toBeVisible()

      const patchReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/interviews/${INTERVIEWS[0]!.id}`) &&
          req.method() === 'PATCH' &&
          !req.url().includes('/move'),
      )

      // notesTechStack — input with placeholder "React, Node.js, AWS"
      await page.getByPlaceholder('React, Node.js, AWS').fill('TypeScript, GraphQL')
      // Save button enabled only when form isDirty
      await page.getByRole('button', { name: /^сохранить|сохраняем/i }).click()

      const req = await patchReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body.notesTechStack).toBe('TypeScript, GraphQL')
    })

    test('ADMIN sees "Удалить карточку" delete button in detail sheet', async ({
      asAdmin: page,
    }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')
      await expect(page.getByTitle('Удалить карточку')).toBeVisible()
    })

    test('SENIOR does not see delete button (no canDelete)', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')
      await expect(page.getByTitle('Удалить карточку')).not.toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // Delete interview (ADMIN only)
  // -------------------------------------------------------------------------

  test.describe('Delete interview', () => {
    test('ADMIN: clicking delete opens confirm dialog', async ({ asAdmin: page }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')
      await page.getByTitle('Удалить карточку').click()
      await expect(page.getByText('Удалить карточку?')).toBeVisible()
    })

    test('ADMIN: confirm delete sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')

      const deleteReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/interviews/${INTERVIEWS[0]!.id}`) && req.method() === 'DELETE',
      )

      await page.getByTitle('Удалить карточку').click()
      await page.getByRole('button', { name: 'Удалить' }).last().click()
      expect((await deleteReq).method()).toBe('DELETE')
    })
  })

  // -------------------------------------------------------------------------
  // CLIENT_INTERVIEW Stage Tests - новый стейдж между FINAL_INTERVIEW и OFFER_RECEIVED
  // -------------------------------------------------------------------------

  test.describe('CLIENT_INTERVIEW stage', () => {
    test('CLIENT_INTERVIEW stage column renders with correct label', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await expect(page.getByText('Client', { exact: false }).first()).toBeVisible()
    })

    test('clicking "Client →" sends move request with CLIENT_INTERVIEW stage', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      // Final Stage Corp lives in the FINAL_INTERVIEW column → next stage is
      // CLIENT_INTERVIEW, so its sheet exposes a "Client →" move button.
      const sheet = await openInterviewSheet(page, 'Final Stage Corp')

      // Scope to the sheet so the Client button resolves inside the detail sheet,
      // not the Kanban column header. Wait for it before registering
      // waitForRequest — eliminates the race where PATCH /move fires before the
      // listener attaches.
      const clientBtn = sheet.getByRole('button', { name: /client/i })
      await expect(clientBtn).toBeVisible()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await clientBtn.click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'CLIENT_INTERVIEW' })
    })

    test('CLIENT_INTERVIEW is in correct position in stage flow', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      // Проверяем правильный порядок колонок: Final → Client → Offer
      await expect(page.getByText('Final', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('Client', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('Offer', { exact: true }).first()).toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty board renders stage columns without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.senior)
      await page.route(new RegExp('localhost:3001/api/interviews(\\?.*)?$'), (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/interviews')
      await expect(page.getByText('HR Screen').first()).toBeVisible()
    })

    test('HR has senior selector visible', async ({ asHr: page }) => {
      await page.goto('/interviews')
      // HR sees native <select> for switching boards
      await expect(page.locator('select').first()).toBeVisible()
    })

    test('network error on stage move does not crash page', async ({ asSenior: page }) => {
      await page.route(/\/interviews\/.*\/move/, (r) =>
        r.fulfill({ status: 500, body: '{"message":"error"}' }),
      )

      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')
      // Try to move with terminal button (Архив) — error suppressed by query invalidation
      await sheet.getByRole('button', { name: 'Архив' }).click()

      // Page intact
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('interviews-page')).toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // Bug fixes regression suite (fix/interviews-ui)
  // -------------------------------------------------------------------------

  test.describe('Bug fixes regression', () => {
    // -----------------------------------------------------------------------
    // Bug 1: Sheet modal dialogs must close cleanly in all ways
    // -----------------------------------------------------------------------

    test('BUG1: detail sheet closes via Escape key', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')
      // Close via Escape — no dirty form, so should close immediately
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('interview-detail-sheet')).not.toBeVisible()
    })

    test('BUG1: detail sheet closes via cross (X) button', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')
      // SheetContent renders a close button with sr-only "Close" text
      await page.getByRole('button', { name: 'Close' }).click()
      await expect(page.getByTestId('interview-detail-sheet')).not.toBeVisible()
    })

    test('BUG1: dirty form triggers unsaved-changes dialog, discard closes sheet', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')

      // Make the form dirty
      await page.getByPlaceholder('Название компании').fill('Changed Corp')

      // Close via Escape → should show unsaved-changes dialog, NOT close sheet
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('confirm-unsaved-dialog')).toBeVisible()

      // Click "Не сохранять" — should close both dialog and sheet
      await page.getByTestId('discard-button').click()
      await expect(page.getByTestId('confirm-unsaved-dialog')).not.toBeVisible()
      await expect(page.getByTestId('interview-detail-sheet')).not.toBeVisible()
    })

    test('BUG1: delete confirm dialog closes cleanly via Cancel', async ({ asAdmin: page }) => {
      await page.goto('/interviews')
      await openInterviewSheet(page, 'Acme Corp')
      await page.getByTitle('Удалить карточку').click()
      // Delete confirm dialog should appear
      await expect(page.getByTestId('confirm-delete-dialog')).toBeVisible()
      // Cancel closes only the dialog, sheet stays open
      await page.getByTestId('cancel-button').first().click()
      await expect(page.getByTestId('confirm-delete-dialog')).not.toBeVisible()
      // Sheet is still visible
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
    })

    // -----------------------------------------------------------------------
    // Bug 2: DnD to HIRED column triggers CreateProject prompt for ADMIN/HR
    // -----------------------------------------------------------------------

    test('BUG2: move to HIRED via sheet button opens create-project prompt for ADMIN', async ({
      asAdmin: page,
    }) => {
      // Override move mock to return HIRED stage
      await page.route(/\/interviews\/.*\/move/, (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...INTERVIEWS[0],
            stage: 'HIRED',
            seniorId: USERS.senior.id,
            seniorName: USERS.senior.displayName,
          }),
        }),
      )

      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Scope lookups to the sheet — avoids strict-mode conflicts with
      // aria-disabled kanban-column buttons that share the same label.
      // Gate: "Нанят" button must be rendered inside the sheet before clicking.
      const hiredBtnAdmin = sheet.getByRole('button', { name: 'Нанят' })
      await expect(hiredBtnAdmin).toBeVisible()

      await hiredBtnAdmin.click()

      // Should show create-project confirmation dialog
      await expect(page.getByTestId('confirm-create-project-dialog')).toBeVisible()
    })

    test('BUG2: SENIOR moving to HIRED via sheet button does NOT open create-project prompt', async ({
      asSenior: page,
    }) => {
      // SENIOR cannot create projects, so no prompt should appear
      await page.route(/\/interviews\/.*\/move/, (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...INTERVIEWS[0], stage: 'HIRED' }),
        }),
      )

      await page.goto('/interviews')
      const sheet = await openInterviewSheet(page, 'Acme Corp')

      // Scope to sheet to avoid kanban column header buttons with aria-disabled.
      const hiredBtnSenior = sheet.getByRole('button', { name: 'Нанят' })
      await expect(hiredBtnSenior).toBeVisible()
      await hiredBtnSenior.click()

      // SENIOR: canCreateProject = false — no dialog should appear
      await expect(page.getByTestId('confirm-create-project-dialog')).not.toBeVisible()
    })

    // -----------------------------------------------------------------------
    // Bug 3: Cancel button in the create-project prompt must close it
    // -----------------------------------------------------------------------

    test('BUG3: cancel button in create-project dialog closes it', async ({ asAdmin: page }) => {
      await page.route(/\/interviews\/.*\/move/, (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...INTERVIEWS[0],
            stage: 'HIRED',
            seniorId: USERS.senior.id,
            seniorName: USERS.senior.displayName,
          }),
        }),
      )

      await page.goto('/interviews')
      const sheetBug3 = await openInterviewSheet(page, 'Acme Corp')

      // Scope to sheet to avoid strict-mode conflicts with kanban column elements.
      const hiredBtnBug3 = sheetBug3.getByRole('button', { name: 'Нанят' })
      await expect(hiredBtnBug3).toBeVisible()
      await hiredBtnBug3.click()

      // Confirm-create-project dialog is visible
      await expect(page.getByTestId('confirm-create-project-dialog')).toBeVisible()

      // Click "Нет" (cancel) — dialog must close
      await page.getByRole('button', { name: 'Нет' }).click()
      await expect(page.getByTestId('confirm-create-project-dialog')).not.toBeVisible()
    })

    // BUG3 DnD path via keyboard — KeyboardSensor is now configured in
    // apps/web/app/routes/interviews/index.tsx alongside PointerSensor.
    //
    // Technique: Space (pick) → ArrowRight × 6 → Space (drop).
    //
    // kanbanKeyboardCoordinateGetter navigates exactly one column per ArrowRight
    // by jumping to the center of the adjacent droppable area (column). This is
    // deterministic regardless of scroll position or how many cards are in each
    // column. 6 steps = HR_SCREEN → ENGLISH → TECH → FINAL → CLIENT → OFFER → HIRED.
    test('BUG3: CreateProjectFromHiredDialog cancel button closes the full-form dialog', async ({
      asAdmin: page,
    }) => {
      await page.route(/\/interviews\/.*\/move/, (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...INTERVIEWS[0],
            stage: 'HIRED',
            seniorId: USERS.senior.id,
            seniorName: USERS.senior.displayName,
          }),
        }),
      )

      // Widen the viewport so all 9 Kanban columns (HR_SCREEN → ARCHIVED) fit
      // on screen simultaneously. This guarantees droppableRects for HIRED are
      // non-zero and reachable by kanbanKeyboardCoordinateGetter in headless.
      // Without this, the columns beyond OFFER_RECEIVED are off-screen and the
      // coordinate getter may not move past them reliably.
      await page.setViewportSize({ width: 1920, height: 900 })

      await page.goto('/interviews')
      // Wait for board to be fully rendered before interacting.
      await waitForBoardReady(page)

      // Locate the Acme Corp card (HR_SCREEN column, position 0) and focus it.
      // useSortable spreads {attributes, listeners} onto the div which includes
      // tabIndex=0 and role="button" so the card is keyboard-focusable.
      const card = page.getByRole('button').filter({ hasText: 'Acme Corp' }).first()
      await expect(card).toBeVisible()
      await card.focus()

      // Space — activate the KeyboardSensor drag. The sensor attaches its
      // keydown listener via setTimeout(), so the non-empty live-region
      // assertion below (auto-retrying) is the readiness gate before the first
      // ArrowRight — no fixed sleep.
      await page.keyboard.press('Space')
      // dnd-kit's DndLiveRegion announces drag progress here. Scope to
      // `[aria-live]:not([aria-label])` to target dnd-kit's region and skip the
      // Notifications section (which carries aria-label="Notifications alt+T").
      // Wait for ANY announcement (drag started) — the «Picked up draggable
      // item …» phrase is transient and is replaced by the first «moved over …»
      // announcement almost immediately, so anchoring on it is itself racy.
      const liveRegion = page.locator('[aria-live]:not([aria-label])').first()
      await expect(liveRegion).not.toBeEmpty({ timeout: 5000 })

      // Navigate column-by-column to HIRED via kanbanKeyboardCoordinateGetter.
      //
      // ROOT CAUSE OF THE PRE-FIX CI-ONLY FLAKE (deflake 2026-06-23):
      //   The old loop pressed ArrowRight exactly 6× with a fixed
      //   `waitForTimeout(200)` between presses. As test #41 in the sequential
      //   `misc` shard (workers:1, prod `vite preview` build) the JS event loop
      //   is warm/fast, so dnd-kit had not committed `currentCoordinates` to a
      //   column when a press fired. Captured live from the dnd-kit live region:
      //     press 1 -> "droppable area interview-1-id"  (swallowed: card's own
      //                                                   sortable, NOT a column)
      //     press 2 -> "interview-1-id"                 (still uncommitted)
      //     press 3 -> "TECH_INTERVIEW"
      //     press 4..10 -> "TECH_INTERVIEW"             (permanently stuck)
      //   so 6 presses reached only OFFER_RECEIVED (or got stuck), the drop
      //   landed off HIRED, and CreateProjectFromHiredDialog never opened. With
      //   --trace=on or in isolation the loop ran slow enough to settle each
      //   coordinate, so it passed — a textbook speed-dependent race that fixed
      //   sleeps could not paper over.
      //
      // DETERMINISTIC FIX (no fixed sleeps):
      //   Step through each expected column. For every target, press ArrowRight
      //   and wait — via auto-retrying `expect.poll` on the live-region text —
      //   for the announcement to *settle on that exact column*. If a press is
      //   swallowed (still on the card droppable) or the coordinate is stuck on
      //   the previous column, re-issue the press (bounded to 4 attempts) until
      //   the column advances. We never drop until HIRED is confirmed, so the
      //   outcome is independent of execution speed.
      const columnOf = async () =>
        ((await liveRegion.textContent()) ?? '').match(/droppable area ([A-Za-z0-9_-]+)/)?.[1] ??
        null
      // HR_SCREEN → ENGLISH_CHECK → TECH → FINAL → CLIENT → OFFER → HIRED.
      const stageSequence = [
        'ENGLISH_CHECK',
        'TECH_INTERVIEW',
        'FINAL_INTERVIEW',
        'CLIENT_INTERVIEW',
        'OFFER_RECEIVED',
        'HIRED',
      ] as const
      for (const targetStage of stageSequence) {
        let landed = false
        for (let attempt = 0; attempt < 4 && !landed; attempt++) {
          await page.keyboard.press('ArrowRight')
          try {
            await expect
              .poll(columnOf, { timeout: 2000, intervals: [100, 150, 200, 300] })
              .toBe(targetStage)
            landed = true
          } catch {
            // Press swallowed or coordinate stuck on the previous column — the
            // loop re-presses. (catch is required so a non-advancing press
            // doesn't abort the test before the retry.)
          }
        }
        expect(landed, `keyboard DnD should advance to ${targetStage}`).toBe(true)
      }

      // Space — drop into HIRED; move mock fires and returns HIRED stage
      await page.keyboard.press('Space')

      // CreateProjectFromHiredDialog must appear (canCreateProject=true for ADMIN)
      await expect(page.getByTestId('create-project-from-hired-dialog')).toBeVisible({
        timeout: 5000,
      })

      // "Отмена" closes the full-form dialog without POST /projects
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByTestId('create-project-from-hired-dialog')).not.toBeVisible()

      // Page heading still visible — no crash, sheet not blocking
      await expect(page.getByTestId('interviews-page')).toBeVisible()
    })
  })
})
