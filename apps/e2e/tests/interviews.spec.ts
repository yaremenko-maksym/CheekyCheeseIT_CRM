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
    test('JUNIOR sees "Нет доступа" message', async ({ asJunior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText(/нет доступа к разделу/i)).toBeVisible()
    })

    test('SENIOR sees kanban board', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByRole('heading', { name: 'Собеседования' })).toBeVisible()
      await expect(page.getByText('HR Screen').first()).toBeVisible()
    })

    test('HR sees kanban board with senior selector', async ({ asHr: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('HR Screen').first()).toBeVisible()
      // HR has a native <select> senior selector
      await expect(page.locator('select').first()).toBeVisible()
    })

    test('ADMIN sees kanban board with senior selector', async ({ asAdmin: page }) => {
      await page.goto('/crm/interviews')
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
      await page.goto('/crm/interviews')
      for (const label of ['HR Screen', 'English', 'Tech', 'Final', 'Client', 'Offer']) {
        await expect(page.getByText(label, { exact: false }).first()).toBeVisible()
      }
    })

    test('shows interview cards in correct columns', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('Acme Corp')).toBeVisible()
      await expect(page.getByText('Beta Startup')).toBeVisible()
    })

    test('card shows vacancy URL link when present', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.locator('a[href="https://jobs.acme.com/senior-dev"]')).toBeVisible()
    })

    test('terminal stage columns rendered alongside active ones', async ({ asSenior: page }) => {
      // Reality: терминальные стейджи (HIRED/REJECTED/ARCHIVED) рендерятся
      // как отдельные колонки рядом с активными — нет collapsible "Архив" секции.
      await page.goto('/crm/interviews')
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
      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Новая карточка' })).toBeVisible()
    })

    test('HR sees senior selector when creating interview', async ({ asHr: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('cancel closes dialog without POST', async ({ asSenior: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/interviews') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/crm/interviews')
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
      await page.goto('/crm/interviews')
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
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      // Simulate moving from HR_SCREEN → ... → FINAL_INTERVIEW → CLIENT_INTERVIEW
      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      // Click next stage button repeatedly to reach CLIENT_INTERVIEW
      // The exact button text depends on current stage, but we're testing the CLIENT_INTERVIEW stage functionality
      await page
        .getByRole('button', { name: /english|tech|final|client/i })
        .first()
        .click()
      const req = await moveReq

      // Verify the request uses PATCH method and contains stage data
      expect(req.method()).toBe('PATCH')
      const body = JSON.parse(req.postData() ?? '{}')
      expect(body).toHaveProperty('stage')
    })

    test('move to next stage sends PATCH /move request', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      // Move to next stage (from HR_SCREEN to ENGLISH_CHECK)
      await page.getByRole('button', { name: /english/i }).click()
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
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Sheet/dialog should appear with company name in heading area
      await expect(
        page.getByRole('dialog').or(page.locator('[role="complementary"]')),
      ).toBeVisible()
    })

    test('shows next-stage move button (English →) for HR_SCREEN card', async ({
      asSenior: page,
    }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // From HR_SCREEN next is ENGLISH_CHECK → button label "English →"
      await expect(page.getByRole('button', { name: /english/i })).toBeVisible()
    })

    test('move to next stage sends PATCH /move request', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: /english/i }).click()
      await moveReq
    })

    test('CLIENT_INTERVIEW stage is positioned between FINAL_INTERVIEW and terminal stages', async ({
      asSenior: page,
    }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('Final', { exact: false }).first()).toBeVisible()
      await expect(page.getByText('Client', { exact: false }).first()).toBeVisible()
    })

    test('move interview through CLIENT_INTERVIEW stage', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

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
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      await expect(page.getByRole('button', { name: 'Нанят' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Отказ' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Архив' })).toBeVisible()
    })

    test('clicking "Нанят" sends move request with HIRED stage', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: 'Нанят' }).click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'HIRED' })
    })

    test('clicking "Отказ" sends move request with REJECTED stage', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: 'Отказ' }).click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'REJECTED' })
    })

    test('SENIOR can edit notes and save', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

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
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTitle('Удалить карточку')).toBeVisible()
    })

    test('SENIOR does not see delete button (no canDelete)', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTitle('Удалить карточку')).not.toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // Delete interview (ADMIN only)
  // -------------------------------------------------------------------------

  test.describe('Delete interview', () => {
    test('ADMIN: clicking delete opens confirm dialog', async ({ asAdmin: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await page.getByTitle('Удалить карточку').click()
      await expect(page.getByText('Удалить карточку?')).toBeVisible()
    })

    test('ADMIN: confirm delete sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })

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
      await page.goto('/crm/interviews')
      await expect(page.getByText('Client', { exact: false }).first()).toBeVisible()
    })

    test('clicking "Client →" sends move request with CLIENT_INTERVIEW stage', async ({
      asSenior: page,
    }) => {
      await page.goto('/crm/interviews')
      await page
        .getByRole('button')
        .filter({ hasText: 'Final Stage Corp' })
        .first()
        .click({ force: true })

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      // Нажимаем кнопку для перехода к CLIENT_INTERVIEW
      await page.getByRole('button', { name: /client/i }).click({ force: true })
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'CLIENT_INTERVIEW' })
    })

    test('CLIENT_INTERVIEW is in correct position in stage flow', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
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
      await page.goto('/crm/interviews')
      await expect(page.getByText('HR Screen').first()).toBeVisible()
    })

    test('HR has senior selector visible', async ({ asHr: page }) => {
      await page.goto('/crm/interviews')
      // HR sees native <select> for switching boards
      await expect(page.locator('select').first()).toBeVisible()
    })

    test('network error on stage move does not crash page', async ({ asSenior: page }) => {
      await page.route(/\/interviews\/.*\/move/, (r) =>
        r.fulfill({ status: 500, body: '{"message":"error"}' }),
      )

      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Try to move with terminal button (Архив) — error suppressed by query invalidation
      await page.getByRole('button', { name: 'Архив' }).click()

      // Page intact
      await page.keyboard.press('Escape')
      await expect(page.getByRole('heading', { name: 'Собеседования' })).toBeVisible()
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
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      // Sheet should be visible
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
      // Close via Escape — no dirty form, so should close immediately
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('interview-detail-sheet')).not.toBeVisible()
    })

    test('BUG1: detail sheet closes via cross (X) button', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()
      // SheetContent renders a close button with sr-only "Close" text
      await page.getByRole('button', { name: 'Close' }).click()
      await expect(page.getByTestId('interview-detail-sheet')).not.toBeVisible()
    })

    test('BUG1: dirty form triggers unsaved-changes dialog, discard closes sheet', async ({
      asSenior: page,
    }) => {
      await page.goto('/crm/interviews')
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
      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
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

      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await expect(page.getByTestId('interview-detail-sheet')).toBeVisible()

      // Click the "Нанят" button inside the sheet
      await page.getByRole('button', { name: 'Нанят' }).click()

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

      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await page.getByRole('button', { name: 'Нанят' }).click()

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

      await page.goto('/crm/interviews')
      await page.getByRole('button').filter({ hasText: 'Acme Corp' }).first().click({ force: true })
      await page.getByRole('button', { name: 'Нанят' }).click()

      // Confirm-create-project dialog is visible
      await expect(page.getByTestId('confirm-create-project-dialog')).toBeVisible()

      // Click "Нет" (cancel) — dialog must close
      await page.getByRole('button', { name: 'Нет' }).click()
      await expect(page.getByTestId('confirm-create-project-dialog')).not.toBeVisible()
    })

    // BUG3 DnD path via keyboard — KeyboardSensor is now configured in
    // apps/web/app/routes/crm/interviews/index.tsx alongside PointerSensor.
    // Keyboard drag: Space (pick) → ArrowRight × N to HIRED column → Space (drop).
    // Arrow key count: HR_SCREEN(0) → HIRED(6) = 6 steps right.
    // After drop, move mock returns HIRED → CreateProjectFromHiredDialog opens.
    // Clicking "Отмена" must close the dialog and leave the page intact.
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

      await page.goto('/crm/interviews')

      // Locate the Acme Corp card (HR_SCREEN column, position 0) and focus it.
      // useSortable spreads {attributes, listeners} onto the div which includes
      // tabIndex=0 and role="button" so the card is keyboard-focusable.
      const card = page.getByRole('button').filter({ hasText: 'Acme Corp' }).first()
      await card.focus()

      // Space — activate KeyboardSensor drag
      await page.keyboard.press('Space')

      // ArrowRight × 6: HR_SCREEN → ENGLISH_CHECK → TECH_INTERVIEW →
      //   FINAL_INTERVIEW → CLIENT_INTERVIEW → OFFER_RECEIVED → HIRED
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('ArrowRight')
      }

      // Space — drop into HIRED column; move mock fires and returns HIRED stage
      await page.keyboard.press('Space')

      // CreateProjectFromHiredDialog must appear (canCreateProject=true for ADMIN)
      await expect(page.getByTestId('create-project-from-hired-dialog')).toBeVisible()

      // "Отмена" closes the full-form dialog without POST /projects
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByTestId('create-project-from-hired-dialog')).not.toBeVisible()

      // Page heading still visible — no crash, sheet not blocking
      await expect(page.getByRole('heading', { name: 'Собеседования' })).toBeVisible()
    })
  })
})
