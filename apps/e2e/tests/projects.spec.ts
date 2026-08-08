import { test, expect, PROJECTS, USERS, mockAuthAs } from './fixtures'

test.describe('Projects page', () => {
  // ---------------------------------------------------------------------------
  // Page load & basic rendering
  // ---------------------------------------------------------------------------

  test.describe('Rendering', () => {
    test('shows project cards with name, company, rate', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      await expect(page.getByText('TechCorp AI')).toBeVisible()
      // Round 5: EdTech Portal is now an archived fixture — hidden from the
      // default view. Archive-tab visibility is covered by the Filters suite.
      // Rate rendered via toLocaleString() — match formatted number pattern
      await expect(page.getByText(/5[,.\u00a0 ]?000[ ]*USDT/)).toBeVisible()
      await expect(page.getByText('EdTech Portal')).not.toBeVisible()
    })

    test('SENIOR sees projects page (read-only)', async ({ asSenior: page }) => {
      await page.goto('/projects')
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      // No create button
      await expect(page.getByRole('button', { name: /новый проект/i })).not.toBeVisible()
    })

    test('HR sees create button', async ({ asHr: page }) => {
      await page.goto('/projects')
      await expect(page.getByRole('button', { name: /новый проект/i })).toBeVisible()
    })

    test('ADMIN sees create and archive buttons', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      await expect(page.getByRole('button', { name: /новый проект/i })).toBeVisible()
      // ut-27 (PR 34 round 1) removed the inline trash/archive icon button from cards.
      // The archive action lives on the project detail header now. The list page only
      // exposes the «Архив» tab — guarded behind ADMIN role.
      await expect(page.getByTestId('toggle-archived-projects')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Filter tabs
  // ---------------------------------------------------------------------------

  test.describe('Filters', () => {
    // Round 5: tabs are «Все | Активные | Архив». The legacy CLOSED business
    // contract state is gone — archived projects are hidden by default and
    // only surface under the «Архив» tab (ADMIN-only).
    test('"Активные" tab shows only non-archived projects', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      await page.getByRole('tab', { name: 'Активные' }).click()
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      // Archived fixture project is excluded by the API (?archived=false).
      await expect(page.getByText('EdTech Portal')).not.toBeVisible()
    })

    test('"Все" tab shows non-archived projects', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      // Move away and back to «Все» to verify the toggle re-fetches.
      await page.getByRole('tab', { name: 'Активные' }).click()
      await page.getByRole('tab', { name: 'Все' }).click()
      await expect(page.getByText('AI Platform v2')).toBeVisible()
    })

    test('"Архив" tab shows only archived projects', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      await page.getByTestId('toggle-archived-projects').click()
      // Card itself is the most reliable target — the inner <p> may briefly be
      // hidden during the AnimatePresence exit/enter animation, but the card
      // (with data-archived='true') becomes visible as soon as the query
      // resolves.
      await expect(page.getByTestId('project-card-project-2-id')).toBeVisible()
      await expect(page.getByText('AI Platform v2')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Create project dialog
  // ---------------------------------------------------------------------------

  test.describe('Create project', () => {
    test('opens dialog with correct title', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Новый проект' })).toBeVisible()
    })

    test('submits POST with all required fields filled', async ({ asAdmin: page }) => {
      const postReq = page.waitForRequest(
        (req) => req.url().includes('/projects') && req.method() === 'POST',
      )

      await page.goto('/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      const nameInput = dialog.getByPlaceholder('AI Platform v2')
      await nameInput.fill('My New Project')
      await nameInput.blur()

      const companyInput = dialog.getByPlaceholder('TechCorp AI')
      await companyInput.fill('ClientCorp')
      await companyInput.blur()

      // Domain is a native <select> — scope to dialog to avoid page-level selects
      await dialog.locator('select').first().selectOption('EdTech')

      // Senior — second <select> in dialog
      await dialog.locator('select').nth(1).selectOption({ label: 'Senior Dev' })

      const rateInput = dialog.getByPlaceholder('5000')
      await rateInput.fill('4000')
      await rateInput.blur()

      await page.getByRole('button', { name: 'Создать' }).click()

      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({ name: 'My New Project', companyName: 'ClientCorp' })
    })

    test('validation: empty required fields show errors on blur', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()

      const nameInput = page.getByPlaceholder('AI Platform v2')
      await nameInput.clear()
      await nameInput.blur()
      // Zod v4 message for min(1) — match either custom or default
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('cancel closes dialog without POST', async ({ asAdmin: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/projects') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Project archive / unarchive — see tests/projects/projects-archive.spec.ts
  //
  // Round 5 (drop status enum) removed the close/reopen flow: project
  // lifecycle is now binary (ACTIVE ↔ ARCHIVED) with archive/unarchive
  // exclusively driving the transition. The dedicated archive spec covers
  // all related UI assertions.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Project members — on detail page
  // ---------------------------------------------------------------------------

  test.describe('Project members', () => {
    test('detail page shows team section with senior', async ({ asAdmin: page }) => {
      await page.goto(`/projects/${PROJECTS[0]!.id}`)
      // Team section with senior name
      await expect(page.getByText('Senior Dev')).toBeVisible()
    })

    test('ADMIN sees "Добавить" button on active project detail', async ({ asAdmin: page }) => {
      await page.goto(`/projects/${PROJECTS[0]!.id}`)
      // PR #178 added a second «Добавить» button in the credentials section
      // (data-testid="credentials-add-btn" sits ON the button — .filter({hasNot})
      // checks descendants only, so intersect with :not() instead).
      const membersAddBtn = page
        .getByRole('button', { name: /добавить/i })
        .and(page.locator(':not([data-testid="credentials-add-btn"])'))
      await expect(membersAddBtn).toBeVisible()
    })

    test('"Добавить" opens edit dialog', async ({ asAdmin: page }) => {
      await page.goto(`/projects/${PROJECTS[0]!.id}`)
      const membersAddBtn = page
        .getByRole('button', { name: /добавить/i })
        .and(page.locator(':not([data-testid="credentials-add-btn"])'))
      await membersAddBtn.click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('cancel closes dialog', async ({ asAdmin: page }) => {
      await page.goto(`/projects/${PROJECTS[0]!.id}`)
      const membersAddBtn = page
        .getByRole('button', { name: /добавить/i })
        .and(page.locator(':not([data-testid="credentials-add-btn"])'))
      await membersAddBtn.click()
      // Dialog has Отмена or close via Escape
      const cancelBtn = page.getByRole('button', { name: 'Отмена' })
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await expect(page.getByRole('dialog')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // New project metadata fields (PR #8: BA audit findings)
  // ---------------------------------------------------------------------------

  test.describe('Project metadata fields', () => {
    test('create dialog shows new metadata fields', async ({ asAdmin: page }) => {
      await page.goto('/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      // Check for metadata field labels in create dialog
      await expect(dialog.getByText('Стек технологий')).toBeVisible()
      await expect(dialog.getByText('Состав команды')).toBeVisible()
      await expect(dialog.getByText('Бенефиты')).toBeVisible()
    })

    test('create project with all metadata fields filled', async ({ asAdmin: page }) => {
      const postReq = page.waitForRequest(
        (req) => req.url().includes('/projects') && req.method() === 'POST',
      )

      await page.goto('/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      // Fill required fields first
      await dialog.getByPlaceholder('AI Platform v2').fill('Test Project')
      await dialog.getByPlaceholder('TechCorp AI').fill('Test Company')
      await dialog.locator('select').first().selectOption('EdTech')
      await dialog.locator('select').nth(1).selectOption({ label: 'Senior Dev' })
      await dialog.getByPlaceholder('5000').fill('3000')

      // Fill new metadata fields
      // Each optional field is filled only when the dialog actually renders it,
      // and whether it WAS filled is remembered so the assertions further down
      // can be unconditional. Previously both halves were hedged — fill-if-
      // visible, then `if (body.techStack) expect(...)` — so a build that
      // stopped sending these fields entirely satisfied the test by asserting
      // nothing. Pinning the expected value to `filledX` also makes the absent
      // case an assertion instead of a silent skip. (task-lint-teeth)
      const techStackField = dialog
        .getByPlaceholder(/стек технологий/i)
        .or(dialog.locator('input[name*="tech"]').or(dialog.locator('textarea[name*="tech"]')))
      const filledTechStack = await techStackField.isVisible()
      if (filledTechStack) {
        await techStackField.fill('React, TypeScript, Node.js')
      }

      const teamSizeField = dialog
        .getByPlaceholder(/размер команды/i)
        .or(dialog.locator('input[name*="team"]'))
      const filledTeamSize = await teamSizeField.isVisible()
      if (filledTeamSize) {
        await teamSizeField.fill('5-7 developers')
      }

      const benefitsField = dialog
        .getByPlaceholder(/benefi|льгот/i)
        .or(dialog.locator('textarea[name*="benefit"]'))
      const filledBenefits = await benefitsField.isVisible()
      if (filledBenefits) {
        await benefitsField.fill('Medical insurance, flexible schedule')
      }

      // task-drop-share-e2e (Flow 0): paymentType moved from a free-text
      // Input to a 3-value enum Select (ADR 2026-07-13-payment-type-income-
      // routing D1) — pick an option via the Select instead of `.fill()`.
      // The trigger is always present (unlike the other optional metadata
      // inputs above), so no `isVisible()` guard is needed.
      await dialog.getByTestId('project-payment-type-trigger').click()
      await page.getByRole('option', { name: 'USDT', exact: true }).click()

      const salaryReviewField = dialog
        .getByPlaceholder(/пересмотр зп/i)
        .or(dialog.locator('input[name*="salary"]'))
      const filledSalaryReview = await salaryReviewField.isVisible()
      if (filledSalaryReview) {
        await salaryReviewField.fill('Every 6 months')
      }

      await page.getByRole('button', { name: 'Создать' }).click()

      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({ name: 'Test Project', companyName: 'Test Company' })

      // Metadata fields: each must carry exactly what was typed into it, or be
      // absent if the dialog never offered the field. Unconditional, so a
      // regression that drops a filled field from the payload now fails.
      expect(body.techStack).toBe(filledTechStack ? 'React, TypeScript, Node.js' : undefined)
      expect(body.teamSize).toBe(filledTeamSize ? '5-7 developers' : undefined)
      expect(body.benefits).toBe(
        filledBenefits ? 'Medical insurance, flexible schedule' : undefined,
      )
      // paymentType is always sent now (defaults to 'FOP', explicitly set to
      // 'USDT' above) — no longer an optional free-text field.
      expect(body.paymentType).toBe('USDT')
      expect(body.salaryReview).toBe(filledSalaryReview ? 'Every 6 months' : undefined)
    })

    test('edit project dialog shows and updates metadata fields', async ({ asAdmin: page }) => {
      // Mock project with metadata fields
      const projectWithMetadata = {
        ...PROJECTS[0],
        techStack: 'Vue.js, Python',
        teamSize: '3-4 developers',
        benefits: 'Remote work',
        paymentType: 'Hourly',
        salaryReview: 'Quarterly',
        corpTech: 'Agile/Scrum',
        notesGeneral: 'Great project with modern stack',
      }

      await page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(projectWithMetadata),
          })
        }
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...projectWithMetadata,
            ...(JSON.parse(r.request().postData() ?? '{}') as object),
          }),
        })
      })

      await page.goto(`/projects/${PROJECTS[0]!.id}`)

      // Look for edit button (could be "Редактировать" or an edit icon).
      //
      // `test.skip(condition, reason)` instead of wrapping the whole body in
      // `if (await editButton.isVisible())` (task-lint-teeth): with the body
      // behind an `if`, a build that stopped rendering the edit button — or any
      // of the fields below — ran zero assertions and still reported PASS. The
      // runtime skip reports the same situation as SKIPPED, which is what it
      // actually is, and lets every assertion below be unconditional.
      const editButton = page
        .getByRole('button', { name: /редактир/i })
        .or(page.getByTitle(/редактир/i))
      const hasEditButton = await editButton.isVisible()
      test.skip(!hasEditButton, 'project detail did not render an edit button in this build')

      await editButton.click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      // Verify metadata fields are pre-filled
      const techStackField = dialog
        .getByPlaceholder(/стек технологий/i)
        .or(dialog.locator('input[name*="tech"]').or(dialog.locator('textarea[name*="tech"]')))
      const teamSizeField = dialog
        .getByPlaceholder(/размер команды/i)
        .or(dialog.locator('input[name*="team"]'))
      const hasMetadataFields =
        (await techStackField.isVisible()) && (await teamSizeField.isVisible())
      test.skip(!hasMetadataFields, 'edit dialog did not render the metadata fields in this build')

      await expect(techStackField).toHaveValue('Vue.js, Python')
      await expect(teamSizeField).toHaveValue('3-4 developers')
    })

    test('metadata fields respect character limits (varchar constraints)', async ({
      asAdmin: page,
    }) => {
      await page.goto('/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      // Test character limits based on schema: tech_stack varchar(500), notes_general varchar(1000).
      // Runtime skip rather than `if (isVisible)` around the assertions — see
      // the note on the edit-dialog test above. A dialog missing both fields
      // used to make this test pass while checking no limit at all.
      // (task-lint-teeth)
      const techStackField = dialog
        .getByPlaceholder(/стек технологий/i)
        .or(dialog.locator('input[name*="tech"]').or(dialog.locator('textarea[name*="tech"]')))
      const notesField = dialog
        .getByPlaceholder(/заметк|notes/i)
        .or(dialog.locator('textarea[name*="notes"]'))
      const hasLimitFields = (await techStackField.isVisible()) && (await notesField.isVisible())
      test.skip(
        !hasLimitFields,
        'create dialog did not render the tech-stack / notes fields in this build',
      )

      const longText = 'A'.repeat(600) // Exceeds 500 char limit
      await techStackField.fill(longText)
      await techStackField.blur()
      // Should show validation error or truncate
      expect((await techStackField.inputValue()).length).toBeLessThanOrEqual(500)

      const veryLongText = 'A'.repeat(1100) // Exceeds 1000 char limit
      await notesField.fill(veryLongText)
      await notesField.blur()
      // Should show validation error or truncate
      expect((await notesField.inputValue()).length).toBeLessThanOrEqual(1000)
    })

    test('metadata fields are displayed in project detail view', async ({ asAdmin: page }) => {
      // Mock project with filled metadata. paymentType is now a 3-value enum
      // (task-drop-share-e2e Flow 0, ADR 2026-07-13-payment-type-income-
      // routing D1) — use a real enum member ('GIG_CONTRACT') instead of the
      // stale free-text value; the page renders its RU label
      // (PAYMENT_TYPE_LABELS), not the raw enum string.
      const projectWithMetadata = {
        ...PROJECTS[0],
        techStack: 'React, Node.js, PostgreSQL',
        teamSize: '5-8 developers',
        benefits: 'Health insurance, vacation days',
        paymentType: 'GIG_CONTRACT',
        salaryReview: 'Annual',
        corpTech: 'Microservices, Docker',
        notesGeneral: 'Long-term strategic project',
      }

      await page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(projectWithMetadata),
          })
        }
        return r.continue()
      })

      await page.goto(`/projects/${PROJECTS[0]!.id}`)

      // Check if metadata is displayed somewhere on the page
      await expect(page.getByText('React, Node.js, PostgreSQL')).toBeVisible()
      await expect(page.getByText('5-8 developers')).toBeVisible()
      await expect(page.getByText('Health insurance, vacation days')).toBeVisible()
      // enum 'GIG_CONTRACT' renders as its RU label, not the raw value.
      await expect(page.getByText('гіг-контракт')).toBeVisible()
      await expect(page.getByText('Annual')).toBeVisible()
      await expect(page.getByText('Microservices, Docker')).toBeVisible()
      await expect(page.getByText('Long-term strategic project')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty projects list renders without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route('http://localhost:3001/api/projects', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/projects')
      await expect(page.getByTestId('projects-search-input')).toBeVisible()
    })

    test('archive tab shows empty state when no archived projects', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      // Override the parametrised mock to always return an empty list,
      // simulating the "Архив пуст" empty state.
      await page.route(/\/api\/projects(\?.*)?$/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/projects')
      await page.getByTestId('toggle-archived-projects').click()
      await expect(page.getByText('AI Platform v2')).not.toBeVisible()
      await expect(page.getByText('Архив пуст')).toBeVisible()
    })

    test('JUNIOR on /projects → redirected to /project (route-guard PR #184)', async ({
      asJunior: page,
    }) => {
      // PR #184 introduced a declarative route-guard in CrmLayout: JUNIOR is
      // not in the allowed roles for /projects, so the guard fires a
      // beforeLoad redirect to the JUNIOR role-home (/project) before
      // the projects page ever renders. The old behaviour (JUNIOR saw the
      // list with management controls hidden) is replaced by a hard redirect.
      await page.route(/\/api\/projects(\?.*)?$/, (r) => {
        if (r.request().method() !== 'GET') return r.fallback()
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        })
      })
      await page.goto('/projects')
      await expect(page).toHaveURL('/project', { timeout: 8000 })
      await expect(page).not.toHaveURL('/projects')
    })
  })
})
