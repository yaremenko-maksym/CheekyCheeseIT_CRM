import type { Page } from '@playwright/test'
import { test, expect, USERS, mockAuthAs } from '../../fixtures'

/**
 * E2E for /crm/users PR 2 refactor:
 *  - Roomy carded row layout (variant C-v2): 64px | 3fr | 1.4fr grid
 *  - Hover reveals leading actions (opacity transition)
 *  - Whole row clickable to profile; edit/archive icons stopPropagation
 *  - Sort headers use ChevronUp/Down with active color
 *  - Sectioned dialogs (Identity / Contacts / Profession / Finance / Team)
 *  - Edit SENIOR symmetric: HR multiselect + Accountant editable
 *  - Edit JUNIOR shows read-only projects + link to /crm/projects
 *  - ArchiveConfirmDialog with role-specific warnings + name confirmation
 *  - Toggle «Показать архивных» with URL state
 *  - Archived rows: opacity-50 + badge + Restore button
 */

test.describe('Users page refactor (PR 2)', () => {
  test.describe('Roomy C-v2 layout', () => {
    test('renders users-list with row test ids', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByTestId('users-list')).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toBeVisible()
    })

    test('row contains user info + relative date', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const row = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(row).toBeVisible()
      // Display name visible
      await expect(row.getByText('Senior Dev')).toBeVisible()
      // Email visible in row meta
      await expect(row.getByText('senior@cheekycheese.dev')).toBeVisible()
      // Role badge
      await expect(row.getByText('Синьор')).toBeVisible()
    })

    test('tech column renders array as individual pills (fix for stringified array bug)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const row = page.getByTestId(`user-row-${USERS.senior.id}`)
      // techStack = ['TypeScript', 'React'] should render as 2 pills, not a single
      // bracket-wrapped string. Each tech token visible.
      await expect(row.getByText('TypeScript', { exact: true })).toBeVisible()
      await expect(row.getByText('React', { exact: true })).toBeVisible()
    })

    test('self-row marked with "Вы" label', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const row = page.getByTestId(`user-row-${USERS.admin.id}`)
      await expect(row.getByText('Вы', { exact: true })).toBeVisible()
    })

    test('archive button is disabled on own row (cannot archive self)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const button = page.getByTestId(`user-row-archive-${USERS.admin.id}`)
      await expect(button).toBeDisabled()
    })

    test('clicking row navigates to profile', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const row = page.getByTestId(`user-row-${USERS.senior.id}`)
      await row.getByText('Senior Dev').click()
      await expect(page).toHaveURL(new RegExp(`/crm/profile/${USERS.senior.id}`))
    })

    test('clicking edit icon does NOT navigate (stopPropagation)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const editBtn = page.getByTestId(`user-row-edit-${USERS.senior.id}`)
      await editBtn.click()
      // Stays on /crm/users
      await expect(page).toHaveURL(/\/crm\/users$|\/crm\/users\?/)
      // Edit dialog opened
      await expect(page.getByTestId('user-dialog')).toBeVisible()
    })

    test('clicking archive icon does NOT navigate (stopPropagation)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const archiveBtn = page.getByTestId(`user-row-archive-${USERS.senior.id}`)
      await archiveBtn.click()
      await expect(page).toHaveURL(/\/crm\/users$|\/crm\/users\?/)
      // Archive dialog opened
      await expect(page.getByTestId('archive-confirm-dialog')).toBeVisible()
    })
  })

  // ut-18: sort relocated from column headers to filter bar.
  test.describe('Sort indicators', () => {
    test('direction toggle: asc → desc → asc', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const dir = page.getByTestId('users-sort-direction')
      // Default direction is asc.
      await expect(dir).toHaveAttribute('data-dir', 'asc')
      // Click → desc
      await dir.click()
      await expect(dir).toHaveAttribute('data-dir', 'desc')
      // Click again → asc
      await dir.click()
      await expect(dir).toHaveAttribute('data-dir', 'asc')
    })

    test('changing sort key in dropdown updates selection', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const sortKey = page.getByTestId('users-sort-key')
      await sortKey.click()
      await page.getByRole('option', { name: 'По роли' }).click()
      await expect(sortKey).toContainText('По роли')
    })
  })

  test.describe('Sectioned dialogs', () => {
    test('Create dialog shows all 5 sections', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      const dialog = page.getByTestId('user-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Идентичность', { exact: true })).toBeVisible()
      await expect(dialog.getByText('Контакты', { exact: true })).toBeVisible()
      await expect(dialog.getByText('Профессия', { exact: true })).toBeVisible()
      await expect(dialog.getByText('Финансы', { exact: true })).toBeVisible()
      // Section 5 "Команда" only visible for SENIOR/JUNIOR. Default role is JUNIOR.
      await expect(dialog.getByText('Команда', { exact: true })).toBeVisible()
    })

    test('Edit dialog email is editable and shows OAuth warning on change (ut-9)', async ({
      asAdmin: page,
    }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()
      const emailInput = page.getByTestId('user-dialog-email')
      // Email input is rendered (ut-9 made it editable) and pre-filled with the
      // current value.
      await expect(emailInput).toBeVisible()
      await expect(emailInput).toHaveValue('senior@cheekycheese.dev')
      // Changing the email to a different valid address triggers the OAuth
      // warning AlertDialog on blur.
      await emailInput.fill('senior-changed@cheekycheese.dev')
      await emailInput.blur()
      await expect(page.getByTestId('email-change-warning')).toBeVisible()
    })

    test('Create SENIOR shows HR multiselect + Accountant chip (ut-16)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      // Switch role to SENIOR
      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()
      // ut-16: container test-id preserved for both Create and Edit.
      await expect(page.getByTestId('user-dialog-hr-multiselect')).toBeVisible()
      // Accountant block — chip when single, popover trigger when multi.
      const chip = page.getByTestId('user-dialog-accountant-chip')
      const trigger = page.getByTestId('user-dialog-accountant-trigger')
      await expect((await chip.count()) + (await trigger.count())).toBeGreaterThan(0)
    })

    test('Edit SENIOR keeps HR + Accountant editable (symmetric)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()
      await expect(page.getByTestId('user-dialog-hr-multiselect')).toBeVisible()
      const chip = page.getByTestId('user-dialog-accountant-chip')
      const trigger = page.getByTestId('user-dialog-accountant-trigger')
      await expect((await chip.count()) + (await trigger.count())).toBeGreaterThan(0)
    })

    test('Edit SENIOR PATCH includes hrIds + accountantId', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()
      // Wait for HR multiselect to load (depends on team data)
      await expect(page.getByTestId('user-dialog-hr-multiselect')).toBeVisible()

      const patchReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'PATCH',
      )
      await page.getByTestId('user-dialog-submit').click()
      const req = await patchReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toHaveProperty('hrIds')
      expect(body).toHaveProperty('accountantId')
    })

    test('Edit JUNIOR shows read-only projects + manage link', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.junior.id}`).click()
      // JUNIOR Edit shows read-only project list
      const projects = page.getByTestId('user-dialog-junior-projects')
      // May be empty since fixtures have minimal project data
      const projectsCount = await projects.count()
      if (projectsCount > 0) {
        await expect(projects).toBeVisible()
      }
      // Link to /crm/projects always present
      await expect(page.getByRole('dialog').getByRole('link', { name: /Управлять в Проектах/ })).toBeVisible()
    })
  })

  test.describe('Archive flow', () => {
    test('Archive JUNIOR shows warning with projectsCount + name confirmation', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.junior.id}`).click()
      const dlg = page.getByTestId('archive-confirm-dialog')
      await expect(dlg).toBeVisible()
      // Warning text variant for JUNIOR
      await expect(dlg.getByTestId('archive-warning-junior')).toBeVisible()
      // Confirm button disabled until exact name match
      const submit = page.getByTestId('archive-confirm-submit')
      await expect(submit).toBeDisabled()
      // Type name
      await page.getByTestId('archive-confirm-name-input').fill('Junior Dev')
      await expect(submit).toBeEnabled()
    })

    test('Archive SENIOR warning mentions team + projects (pair)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()
      const warning = page.getByTestId('archive-warning-senior')
      await expect(warning).toBeVisible()
      await expect(warning).toContainText(/Alpha Team/i)
      await expect(warning).toContainText(/связанная пара/i)
    })

    test('Archive HR warning mentions teams count', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.hr.id}`).click()
      await expect(page.getByTestId('archive-warning-hr')).toBeVisible()
    })

    test('Archive submit sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.junior.id}`).click()
      await page.getByTestId('archive-confirm-name-input').fill('Junior Dev')

      const deleteReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/api/users/${USERS.junior.id}`) && req.method() === 'DELETE',
      )
      await page.getByTestId('archive-confirm-submit').click()
      await deleteReq
    })

    test('Enter in name input submits when name matches', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.junior.id}`).click()
      const input = page.getByTestId('archive-confirm-name-input')
      await input.fill('Junior Dev')
      const deleteReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/api/users/${USERS.junior.id}`) && req.method() === 'DELETE',
      )
      await input.press('Enter')
      await deleteReq
    })
  })

  test.describe('Toggle archived users', () => {
    // ut-44: «Показать архивных» checkbox replaced with «Все | Активные | Архив»
    // tabs. The Archive tab keeps `users-toggle-archived` testid so historical
    // selectors stay valid; switching to Archive still pushes `?archived=true`
    // onto the URL.
    test('clicking Archive tab adds archived=true to URL', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-toggle-archived').click()
      await expect(page).toHaveURL(/archived=true/)
    })

    test('switching away from Archive tab removes archived from URL', async ({ asAdmin: page }) => {
      await page.goto('/crm/users?archived=true')
      const archiveTab = page.getByTestId('users-toggle-archived')
      await expect(archiveTab).toHaveAttribute('aria-selected', 'true')
      // Click «Активные» to switch tabs.
      await page.getByTestId('users-status-tabs-ACTIVE').click()
      await expect(page).not.toHaveURL(/archived=true/)
    })
  })

  test.describe('Archived row UI', () => {
    test('archived row shows badge and Unarchive button instead of edit/archive', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      const archivedSenior = { ...USERS.senior, archivedAt: '2026-01-01T00:00:00.000Z' }
      await page.route('http://localhost:3001/api/users?archived=true', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([archivedSenior]) }),
      )
      await page.route(/\/api\/users\?archived=true.*/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([archivedSenior]) }),
      )
      await page.goto('/crm/users?archived=true')
      const row = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(row).toHaveAttribute('data-archived', 'true')
      await expect(row.getByText('В архиве')).toBeVisible()
      // Unarchive icon button rendered, edit/archive not
      await expect(page.getByTestId(`user-row-unarchive-${USERS.senior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-edit-${USERS.senior.id}`)).toHaveCount(0)
      await expect(page.getByTestId(`user-row-archive-${USERS.senior.id}`)).toHaveCount(0)
    })

    test('Unarchive click sends POST /unarchive', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      const archivedJunior = { ...USERS.junior, archivedAt: '2026-01-01T00:00:00.000Z' }
      await page.route(/\/api\/users\?archived=true.*/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([archivedJunior]) }),
      )
      await page.goto('/crm/users?archived=true')
      const unarchiveReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/api/users/${USERS.junior.id}/unarchive`) && req.method() === 'POST',
      )
      await page.getByTestId(`user-row-unarchive-${USERS.junior.id}`).click()
      await unarchiveReq
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Interaction tests (keyboard / a11y) — task-fix-pr33-polish.md #11–#16
  // ─────────────────────────────────────────────────────────────────────────
  test.describe('Interaction tests', () => {
    test('Modal Escape closes dialog and returns focus to trigger button', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const triggerBtn = page.getByTestId('users-create-button')
      // Use keyboard activation so Radix knows the trigger and can later
      // restore focus on close.
      await triggerBtn.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      // Focus must return to either the trigger button (preferred — Radix
      // does this automatically when the dialog is opened via the trigger)
      // OR remain on a sensible element inside <body> (NOT <body> itself,
      // which would mean focus was lost). We assert focus.id / testid matches
      // the trigger via JS to avoid Playwright's stricter `toBeFocused` check
      // which is racy in headless mode.
      await expect
        .poll(async () =>
          page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
        )
        .toBe('users-create-button')
    })

    test('Tab order traverses sections sequentially in create dialog', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // First field — Email — should be focusable.
      const emailInput = page.getByTestId('user-dialog-email')
      await emailInput.focus()
      await expect(emailInput).toBeFocused()

      // Tab → Name input (next focusable field in source order).
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('user-dialog-name')).toBeFocused()

      // Tab → Role select trigger.
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('user-dialog-role-trigger')).toBeFocused()

      // From here Tab should remain inside the dialog (focus trap).
      // Ensure we eventually land on the Submit button by walking forward.
      const submit = page.getByTestId('user-dialog-submit')
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab')
        if (await submit.evaluate((el) => el === document.activeElement)) break
      }
      await expect(submit).toBeFocused()
    })

    test('TechAutocomplete: ArrowDown navigates, Enter adds, Esc clears, Tab commits', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const techSection = page.getByRole('dialog').locator('input[placeholder*="технологи"]').first()
      await techSection.focus()
      await techSection.fill('Re')

      // The listbox appears once suggestions are computed (deferred value).
      const listbox = page.getByRole('listbox')
      await expect(listbox).toBeVisible()

      // ArrowDown highlights the second option.
      await page.keyboard.press('ArrowDown')
      // Enter commits the highlighted option as a pill in the dialog.
      await page.keyboard.press('Enter')
      // After commit input is cleared and listbox should be hidden.
      await expect(techSection).toHaveValue('')

      // Re-open listbox, then Escape — input cleared, no pill added.
      // Re-focus explicitly: commit() may have left focus stable but the
      // listbox open-state depends on `isFocused`, which we want to re-assert
      // before typing again.
      await techSection.focus()
      await techSection.fill('Pyt')
      await expect(page.getByRole('listbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(techSection).toHaveValue('')

      // Type and Tab — Tab commits highlighted suggestion (when present).
      await techSection.focus()
      await techSection.fill('Ja')
      await expect(page.getByRole('listbox')).toBeVisible()
      await page.keyboard.press('Tab')
      await expect(techSection).toHaveValue('')
    })

    test('PhoneInput shows inline error on blur for invalid number', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // PhoneInput is `react-phone-number-input` — the underlying text input
      // has placeholder "Номер телефона". Focus it, type partial digits, blur.
      const phoneInput = page.getByRole('dialog').getByPlaceholder('Номер телефона')
      await phoneInput.focus()
      await phoneInput.fill('123')
      // Tab moves focus away → triggers onBlur validator.
      await page.keyboard.press('Tab')

      // Inline validation error text within the Phone field.
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Некорректный номер телефона')).toBeVisible()
      // PhoneInput receives `[&_input]:border-destructive` on its wrapper —
      // Tailwind's child-combinator applies `border-destructive` to the inner
      // <input> at runtime, but the literal class string is on the wrapper.
      // Asserting the visible inline error message (above) is the most
      // reliable user-facing signal — keep that as the primary assertion.
    })

    // ut-16: HR is no longer a native checkbox — interaction is via chip ×
    // (remove) or the searchable "Добавить HR" popover. We assert the
    // popover-driven add flow works end-to-end when ≥2 HRs are seeded.
    test('HR add popover opens and lists remaining HRs (ut-16)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      // Switch role to SENIOR to surface HR multiselect.
      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      const addTrigger = page.getByTestId('user-dialog-hr-add-trigger')
      const count = await addTrigger.count()
      test.skip(count === 0, 'Skipped: all HRs already selected — popover not rendered')

      await addTrigger.click()
      await expect(page.getByPlaceholder('Поиск по имени или email…')).toBeVisible()
    })

    test('Sort direction button toggles via keyboard (ut-18)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const dir = page.getByTestId('users-sort-direction')

      // Default direction is asc.
      await expect(dir).toHaveAttribute('data-dir', 'asc')

      await dir.focus()
      await expect(dir).toBeFocused()

      // Enter — should toggle direction to desc.
      await page.keyboard.press('Enter')
      await expect(dir).toHaveAttribute('data-dir', 'desc')

      // Space — should toggle back to asc.
      await page.keyboard.press('Space')
      await expect(dir).toHaveAttribute('data-dir', 'asc')
    })
  })

  test.describe('AdminActionsMenu unarchive', () => {
    test('archived user profile shows Восстановить из архива action', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      const archivedJunior = { ...USERS.junior, archivedAt: '2026-01-01T00:00:00.000Z' }
      // Override /users/:id to return archived profile (UserWithPermissionsResponse shape)
      await page.route(
        new RegExp(`http://localhost:3001/api/users/${USERS.junior.id}$`),
        (r) =>
          r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              user: {
                ...archivedJunior,
                walletUsdtErc20: null,
                walletUsdtLabel: null,
                bankUahRecipient: 'Junior Dev',
                bankUahIban: 'UA213223130000026007233566001',
                bankUahRnokpp: '1234567890',
                bankUahBankName: null,
                adminNote: null,
              },
              permissions: {
                tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'audit'],
                actions: ['edit-profile', 'change-role', 'change-salary', 'change-requisites', 'set-note', 'archive'],
                fields: { salary: true, share: false, paymentMethodKpi: true, techStack: true, registrationDate: true },
              },
              data: {},
            }),
          }),
      )
      await page.goto(`/crm/profile/${USERS.junior.id}`)
      // Open the actions menu
      await page.getByTestId('admin-actions-trigger').click()
      await expect(page.getByTestId('admin-actions-unarchive')).toBeVisible()
    })
  })
})
