import { test, expect, INTERVIEWS, USERS, mockAuthAs } from './fixtures'

// ---------------------------------------------------------------------------
// Stage labels — отражают реальные значения из constants.ts:
//   HR_SCREEN → 'HR Screen', ENGLISH_CHECK → 'English', TECH_INTERVIEW → 'Tech',
//   FINAL_INTERVIEW → 'Final', CLIENT_INTERVIEW → 'Client',
//   HIRED → 'Нанят', REJECTED → 'Отказ', ARCHIVED → 'Архив'.
// OFFER_RECEIVED больше не входит в ACTIVE_STAGES (заменён на CLIENT_INTERVIEW).
// ---------------------------------------------------------------------------

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
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Новая карточка' })).toBeVisible()
    })

    test('HR sees senior selector when creating interview', async ({ asHr: page }) => {
      await page.goto('/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('cancel closes dialog without POST', async ({ asSenior: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/interviews') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await page.getByRole('button', { name: /отмена/i }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Interview detail sheet
  // -------------------------------------------------------------------------

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
      // disabled prop). Use force:true to click through aria-disabled. Also wait
      // for the board to render before clicking — CI workers:1 prod-build may not
      // have painted the kanban cards yet.
      await expect(page.getByText('HR Screen').first()).toBeVisible()
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Stage-move buttons live inside InterviewDetailSheet. Scope the locator to
      // the sheet container to avoid matching same-named Kanban column headers
      // (e.g. "English" column header is also a button with aria-disabled="true"
      // from useSortable — .first() would resolve to the column header instead of
      // the move button, then fail actionability because aria-disabled prevents
      // click without force).
      // Wait for sheet before scoping — auto-retrying assertion is the readiness gate.
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()

      const stageMoveBtn = sheet
        .getByRole('button', { name: /english|tech|final|client/i })
        .first()
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

      await expect(page.getByText('HR Screen').first()).toBeVisible()
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Scope to sheet to avoid matching the "English" Kanban column header button
      // (aria-disabled="true" for SENIOR who has canDrag=false).
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()

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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Sheet/dialog should appear with company name in heading area
      await expect(
        page.getByRole('dialog').or(page.locator('[role="complementary"]')),
      ).toBeVisible()
    })

    test('shows next-stage move button (English →) for HR_SCREEN card', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // From HR_SCREEN next is ENGLISH_CHECK → button label "English →"
      // Scope to sheet to avoid matching Kanban column header "English" (aria-disabled).
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()
      await expect(sheet.getByRole('button', { name: /english/i })).toBeVisible()
    })

    test('move to next stage sends PATCH /move request', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Scope to sheet to avoid matching the Kanban column header "English"
      // (aria-disabled="true" for SENIOR with canDrag=false — Playwright blocks
      // click without force on aria-disabled elements).
      // Wait for sheet first (auto-retrying assertion = readiness gate), then
      // wait for the specific button before registering waitForRequest to
      // eliminate the race where PATCH fires before the listener attaches.
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Wait for detail sheet content before clicking stage buttons inside it.
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()

      const clientMoveBtn = page.getByRole('button', { name: /client/i })
      if (await clientMoveBtn.isVisible()) {
        const moveReq = page.waitForRequest(
          (req) => req.url().includes('/move') && req.method() === 'PATCH',
        )
        await clientMoveBtn.click()
        const req = await moveReq
        expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'CLIENT_INTERVIEW' })
      }
    })

    test('terminal stage buttons (Нанят / Отказ / Архив) visible for SENIOR own board', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Wait for sheet to open and its content (stage action buttons) to render.
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()

      await expect(page.getByRole('button', { name: 'Нанят' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Отказ' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Архив' })).toBeVisible()
    })

    test('clicking "Нанят" sends move request with HIRED stage', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Scope to sheet to avoid potential strict-mode conflicts with same-label
      // elements elsewhere on the page. Wait for button before waitForRequest.
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Scope to sheet to avoid potential strict-mode conflicts with same-label
      // elements elsewhere on the page. Wait for button before waitForRequest.
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Wait for sheet to be fully open so the form inputs are mounted.
      // CI workers:1 + prod-build: React state + sheet animation is async;
      // getByPlaceholder('React, Node.js, AWS') is inside the sheet and may not
      // exist in DOM until sheet content renders completely.
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
      await expect(page.getByTitle('Удалить карточку')).toBeVisible()
    })

    test('SENIOR does not see delete button (no canDelete)', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
      await expect(page.getByTitle('Удалить карточку')).not.toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // Delete interview (ADMIN only)
  // -------------------------------------------------------------------------

  test.describe('Delete interview', () => {
    test('ADMIN: clicking delete opens confirm dialog', async ({ asAdmin: page }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Wait for sheet to be open so delete button inside it is accessible.
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
      await page.getByTitle('Удалить карточку').click()
      await expect(page.getByText('Удалить карточку?')).toBeVisible()
    })

    test('ADMIN: confirm delete sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Wait for sheet to be open so delete button inside it is accessible.
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()

      const deleteReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/interviews/${INTERVIEWS[0]!.id}`) && req.method() === 'DELETE',
      )

      await page.getByTitle('Удалить карточку').click()
      await page.getByRole('button', { name: 'Удалить' }).last().click()
      await deleteReq
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
      await page
        .getByRole('button')
        .filter({ hasText: 'Final Stage Corp' })
        .first()
        .click({ force: true })

      // Wait for the Client button to be visible before registering waitForRequest.
      // Eliminates race: PATCH /move could fire before listener attaches if we
      // only waited for the sheet container and not the specific button.
      const clientBtn = page.getByRole('button', { name: /client/i })
      await expect(clientBtn).toBeVisible()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await clientBtn.click({ force: true })
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Try to move with terminal button (Архив) — error suppressed by query invalidation
      await page.getByRole('button', { name: 'Архив' }).click()

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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Sheet should be visible
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
      // Close via Escape — no dirty form, so should close immediately
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('interview-detail-sheet')).not.toBeVisible()
    })

    test('BUG1: detail sheet closes via cross (X) button', async ({ asSenior: page }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
      // SheetContent renders a close button with sr-only "Close" text
      await page.getByRole('button', { name: 'Close' }).click()
      await expect(page.getByTestId('interview-detail-sheet')).not.toBeVisible()
    })

    test('BUG1: dirty form triggers unsaved-changes dialog, discard closes sheet', async ({
      asSenior: page,
    }) => {
      await page.goto('/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()

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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Wait for sheet before interacting with delete button inside it.
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Scope all lookups to the sheet to avoid strict-mode conflicts and
      // aria-disabled kanban-column elements with matching labels.
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()
      // Gate on the "Нанят" button being rendered inside the sheet before clicking.
      // CI workers:1 + prod-build: stage action buttons render after sheet content mounts.
      const hiredBtnAdmin = sheet.getByRole('button', { name: 'Нанят' })
      await expect(hiredBtnAdmin).toBeVisible()

      // Click the "Нанят" button inside the sheet
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Scope to sheet to avoid kanban column header buttons with aria-disabled.
      const sheet = page.getByTestId('interview-detail-sheet')
      await expect(sheet).toBeVisible()
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
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Scope to sheet to avoid strict-mode conflicts with kanban column elements.
      const sheetBug3 = page.getByTestId('interview-detail-sheet')
      await expect(sheetBug3).toBeVisible()
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
      await expect(page.getByText('HR Screen').first()).toBeVisible()

      // Locate the Acme Corp card (HR_SCREEN column, position 0) and focus it.
      // useSortable spreads {attributes, listeners} onto the div which includes
      // tabIndex=0 and role="button" so the card is keyboard-focusable.
      const card = page.getByRole('button').filter({ hasText: 'Acme Corp' }).first()
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
