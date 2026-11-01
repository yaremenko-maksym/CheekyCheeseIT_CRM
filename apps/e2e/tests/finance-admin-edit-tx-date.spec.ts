import { test, expect, USERS, API_RE } from './fixtures'
import type { Page } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

/**
 * PR #1213 (SPEC-M-2 / AC6) — ADMIN edits a transaction's business date.
 *
 * Mocked API (no backend): the PATCH handler below plays the server's date policy
 * exactly as docs/business + the PR define it — a changed day older than 31 days
 * needs `backdateReason` (FINANCE_TX_DATE_EDIT_REASON_REQUIRED), and a row with a
 * claimed tx_hash is locked (FINANCE_TX_DATE_LOCKED_ROW). The real policy is covered
 * by admin-edit-tx-date.integration.spec.ts; this spec pins what the OPERATOR sees.
 */

const WINDOW_DAYS = 31
const DAY_MS = 86_400_000

/** Local calendar day `n` days ago as `YYYY-MM-DD` (the picker works in local time). */
function dayAgo(n: number): string {
  const d = new Date(Date.now() - n * DAY_MS)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}
function daysSince(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const today = new Date()
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((todayUtc - Date.UTC(y, m - 1, d)) / DAY_MS)
}

// The envelope `message` the API sends (the English fallback of the code); the dialog's
// error banner shows the backend message verbatim.
const LOCKED_MESSAGE =
  "This transaction's date can't be changed: its payment is confirmed on-chain, comes from the company account, or already has settlements"
const REASON_REQUIRED_MESSAGE =
  'This date is too far back — enter a reason in the “Reason for changing the date” field'

const STORED_DAY = dayAgo(10)
const IN_WINDOW_DAY = dayAgo(15)
const OUT_OF_WINDOW_DAY = dayAgo(60)

function expenseRow(id: string, extra: object = {}): Record<string, unknown> {
  return {
    id,
    type: 'EXPENSE',
    status: 'PAID',
    amount: '200.00',
    currency: 'USD',
    senderId: USERS.admin.id,
    senderName: USERS.admin.displayName,
    senderLabel: null,
    receiverId: null,
    receiverName: null,
    receiverLabel: 'Прочее',
    projectId: null,
    projectName: null,
    receiptUrl: null,
    notes: 'AWS monthly',
    salaryMonth: null,
    txHash: null,
    rejectionReason: null,
    payoutRequestId: null,
    validatedBy: null,
    validatedAt: null,
    txDate: `${STORED_DAY}T12:00:00.000Z`,
    createdAt: `${dayAgo(11)}T08:00:00.000Z`,
    updatedAt: `${dayAgo(11)}T08:00:00.000Z`,
    ...extra,
  }
}

interface EditPatch {
  txDate?: string
  backdateReason?: string
}

/** Mocks the list + the admin-edit PATCH with the server's date rules; returns the PATCH bodies seen. */
async function mockEdit(page: Page, row: Record<string, unknown>): Promise<EditPatch[]> {
  const patches: EditPatch[] = []
  const json = (status: number, body: unknown) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
    r.fulfill(json(200, [row])),
  )
  await page.route(new RegExp(`${API_RE}/transactions/${row['id'] as string}$`), (r) =>
    r.fulfill(json(200, row)),
  )
  await page.route(new RegExp(`${API_RE}/transactions/${row['id'] as string}/admin-edit$`), (r) => {
    const body = r.request().postDataJSON() as EditPatch
    patches.push(body)
    if (body.txDate && body.txDate !== (row['txDate'] as string).slice(0, 10)) {
      if (row['txHash']) {
        return r.fulfill(
          json(400, {
            statusCode: 400,
            code: 'FINANCE_TX_DATE_LOCKED_ROW',
            message: LOCKED_MESSAGE,
            params: {},
          }),
        )
      }
      if (daysSince(body.txDate) > WINDOW_DAYS && !body.backdateReason) {
        return r.fulfill(
          json(400, {
            statusCode: 400,
            code: 'FINANCE_TX_DATE_EDIT_REASON_REQUIRED',
            message: REASON_REQUIRED_MESSAGE,
            params: {},
          }),
        )
      }
      row['txDate'] = `${body.txDate}T12:00:00.000Z`
    }
    return r.fulfill(json(200, row))
  })
  return patches
}

/** Opens the date popover and picks `day`, paging back from the stored day's month. */
async function pickDate(page: Page, fromDay: string, day: string) {
  await page.getByTestId('admin-edit-tx-date').click()
  const calendar = page.getByRole('grid')
  await expect(calendar).toBeVisible()
  const [fy, fm] = fromDay.split('-').map(Number) as [number, number]
  const [ty, tm, td] = day.split('-').map(Number) as [number, number, number]
  const back = (fy - ty) * 12 + (fm - tm)
  for (let i = 0; i < back; i++) {
    await page
      .locator('[data-radix-popper-content-wrapper] button:has(svg.lucide-chevron-left)')
      .click()
  }
  await calendar
    .locator('[role="gridcell"]:not([data-outside="true"]) button')
    .filter({ hasText: new RegExp(`^${td}$`) })
    .click()
  await expect(calendar).toBeHidden()
}

async function openEdit(page: Page) {
  const uk = await loadMessages('uk')
  await page.goto('/finance')
  await page.getByTitle(assertInCatalog(uk, 'Редагувати')).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('Finance — admin edit of the transaction date (ADMIN)', () => {
  test('a day inside the window saves without a reason; the dialog closes and the new day is stored', async ({
    asAdmin,
  }) => {
    const patches = await mockEdit(asAdmin, expenseRow('tx-date-ok'))
    const dialog = await openEdit(asAdmin)
    await expect(dialog.getByTestId('admin-edit-tx-date-reason')).toHaveCount(0)

    await pickDate(asAdmin, STORED_DAY, IN_WINDOW_DAY)
    // The reason field opens as soon as the day differs from the stored one.
    await expect(dialog.getByTestId('admin-edit-tx-date-reason-input')).toBeVisible()

    await dialog.getByTestId('admin-edit-save').click()
    await expect(dialog).toBeHidden()
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ txDate: IN_WINDOW_DAY })
    expect(patches[0]).not.toHaveProperty('backdateReason')

    // Re-open: the picker now shows the stored new day.
    const reopened = await openEdit(asAdmin)
    await expect(reopened.getByTestId('admin-edit-tx-date')).toContainText(
      String(Number(IN_WINDOW_DAY.slice(8))).padStart(2, '0'),
    )
  })

  test('a day older than 31 days without a reason shows the reason-required error and keeps the dialog open', async ({
    asAdmin,
  }) => {
    const patches = await mockEdit(asAdmin, expenseRow('tx-date-noreason'))
    const dialog = await openEdit(asAdmin)

    await pickDate(asAdmin, STORED_DAY, OUT_OF_WINDOW_DAY)
    await dialog.getByTestId('admin-edit-save').click()

    await expect(dialog.getByText(REASON_REQUIRED_MESSAGE)).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ txDate: OUT_OF_WINDOW_DAY })
    expect(patches[0]).not.toHaveProperty('backdateReason')
  })

  test('the same older day WITH a reason saves and sends the trimmed reason', async ({
    asAdmin,
  }) => {
    const patches = await mockEdit(asAdmin, expenseRow('tx-date-reason'))
    const dialog = await openEdit(asAdmin)

    await pickDate(asAdmin, STORED_DAY, OUT_OF_WINDOW_DAY)
    await dialog
      .getByTestId('admin-edit-tx-date-reason-input')
      .fill('  late receipt from the vendor  ')
    await dialog.getByTestId('admin-edit-save').click()

    await expect(dialog).toBeHidden()
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      txDate: OUT_OF_WINDOW_DAY,
      backdateReason: 'late receipt from the vendor',
    })
  })

  test('a locked row (claimed tx_hash) shows the lock error and the dialog stays open', async ({
    asAdmin,
  }) => {
    const patches = await mockEdit(
      asAdmin,
      expenseRow('tx-date-locked', { txHash: `0x${'ab'.repeat(32)}` }),
    )
    const dialog = await openEdit(asAdmin)

    await pickDate(asAdmin, STORED_DAY, IN_WINDOW_DAY)
    await dialog.getByTestId('admin-edit-save').click()

    await expect(dialog.getByText(LOCKED_MESSAGE)).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(patches).toHaveLength(1)
  })

  test('a notes-only save does not send txDate at all', async ({ asAdmin }) => {
    const patches = await mockEdit(asAdmin, expenseRow('tx-date-untouched'))
    const dialog = await openEdit(asAdmin)

    await dialog.getByTestId('admin-edit-save').click()
    await expect(dialog).toBeHidden()
    expect(patches).toHaveLength(1)
    expect(patches[0]).not.toHaveProperty('txDate')
    expect(patches[0]).not.toHaveProperty('backdateReason')
  })
})
