/**
 * vacancies.spec.ts — task-e2e-vacancies. Canonical CRM E2E for the full
 * vacancies flow: backend (#390), CRM screens (#396) — both merged to main.
 *
 * REAL BACKEND — no `page.route()` mocks. Dev-login via `/api/auth/dev-login`
 * (same `loginViaApi` / `REAL_API_BASE` convention as `drop-backend-rbac-api.spec.ts`
 * / `drop-role-end-to-end.spec.ts`). Mocked E2E cannot prove real RolesGuard
 * behaviour or exercise the real Turnstile/S3/CompressionService apply
 * pipeline (feedback_mocked_e2e_guards lesson — recurred 3×) — this spec
 * intentionally drives the real stack end-to-end, the same way those specs do.
 *
 * `E2E_REAL_API_BASE` / `PLAYWRIGHT_BASE_URL` override the API/web origin —
 * point them at a scratch stack when :3000/:3001 are occupied by someone
 * else's live dev session (see task file "Процесс").
 *
 * ── Design: `describe.serial` (deliberate) ─────────────────────────────────
 * This is a "full-flow" spec by explicit task design (task-e2e-vacancies.md
 * §Скоуп: one numbered journey 1→6 through ONE vacancy — п.6 literally reads
 * "отдаёт опубликованную в п.1"). Steps below share the SAME vacancy/
 * application via `test.describe.serial` + `let` state at the describe scope
 * — this is an intentional, acknowledged user-journey test, not accidental
 * test-order coupling (the RBAC-smoke and DRAFT-delete tests below stay
 * fully independent, per the usual "no order-dependence" convention).
 *
 * ── Data isolation / cleanup ────────────────────────────────────────────────
 * Every vacancy/application here uses a `Date.now()`-suffixed title/slug/
 * email — no collision with concurrent runs against the same DB. The
 * candidate PII (email/resume) created in the apply step is REMOVED by the
 * HR-review step itself (deleting the application is part of AC3's own
 * assertions) — no PII residue survives the run.
 *
 * The VACANCY row from the main flow, however, can NEVER be deleted once
 * published — `vacancies.service.ts` `VALID_TRANSITIONS` has no path back to
 * DRAFT, and `remove()` 409s on any non-DRAFT vacancy. This is a deliberate
 * product design (a published hiring vacancy is a permanent audit record —
 * same class of "immutable by design" residue as `signed_contracts` rows,
 * see task-integration-spec-cleanup.progress.md). The dedicated DRAFT-only
 * vacancy created in the "удалить DRAFT-вакансию" test below (which never
 * publishes) IS fully removable and leaves zero residue — verified by a
 * post-delete re-fetch assertion.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { loginViaApi, SEED_ADMIN_EMAIL, SEED_EMAILS } from './fixtures'

const REAL_API_BASE = process.env['E2E_REAL_API_BASE'] ?? 'http://localhost:3001'

/** Seed DROP user (apps/api/src/database/seed.ts) — used by the RBAC smoke. */
const DROP_EMAIL = 'viktor.drop@cheekycheese.dev'

// ---------------------------------------------------------------------------
// Minimal, syntactically valid single-page PDF — no external dependency.
//
// The real backend pipeline (ApplicationsService.apply → CompressionService
// → pdf-lib `PDFDocument.load()`) requires an ACTUALLY well-formed PDF
// (correct xref byte-offsets + trailer), not just a "%PDF" magic-byte stub
// (the mock-based specs elsewhere in this repo use `Buffer.from('%PDF-1.4')`
// — that is NOT enough here since this spec exercises the real pipeline,
// verified live against a scratch stack before writing this spec: a
// magic-byte-only buffer would 415; this hand-rolled xref table round-trips
// through the real `pdf-lib` load→save cleanly).
// ---------------------------------------------------------------------------
function buildMinimalPdf(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>\nendobj\n',
  ]
  const header = '%PDF-1.4\n'
  let body = header
  const offsets: number[] = []
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const xrefStart = Buffer.byteLength(body, 'latin1')
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${off.toString().padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(body + xref + trailer, 'latin1')
}

/**
 * Fills the 3 free-text fields shared by the create Sheet (spec §4.2).
 * `scope` is the Sheet's own Locator — every field carries a stable
 * `data-testid` (VacancyFormFields.tsx) except the Markdown body, which is a
 * CodeMirror `.cm-content` contenteditable (`.fill()` verified live against
 * this exact pipeline — it correctly reaches TanStack Form's `onChange`,
 * unlike a raw `pressSequentially` which would be slower for no benefit).
 * Domain/seniority/employment-type are left at their form defaults
 * (AI / Senior / Полная занятость) — not part of any AC here.
 */
async function fillVacancyForm(
  scope: Locator,
  fields: { title: string; location: string; descriptionMd: string },
) {
  await scope.getByTestId('vacancy-form-title').fill(fields.title)
  await scope.getByTestId('vacancy-form-location').fill(fields.location)
  await scope.locator('.cm-content').fill(fields.descriptionMd)
}

async function submitPublicApply(
  page: Page,
  opts: { slug: string; fullName: string; email: string },
): Promise<{ status: number }> {
  const res = await page.request.post(`${REAL_API_BASE}/api/public/vacancies/${opts.slug}/apply`, {
    multipart: {
      fullName: opts.fullName,
      email: opts.email,
      turnstileToken: 'e2e-dummy-secret-accepts-any-token',
      resume: {
        name: 'resume.pdf',
        mimeType: 'application/pdf',
        buffer: buildMinimalPdf(),
      },
    },
  })
  return { status: res.status() }
}

// ===========================================================================
// Main journey — АС1-4, АС6 (see file header re: describe.serial)
// ===========================================================================

test.describe.serial('Vacancies — полный флоу (ADMIN → отклик → HR → жизненный цикл)', () => {
  const suffix = `${Date.now()}`
  const title = `E2E Vacancy Flow ${suffix}`
  const slug = `e2e-vacancy-flow-${suffix}`
  const candidateEmail = `e2e-candidate-${suffix}@example.com`
  let vacancyId: string
  let applicationId: string | undefined

  test('1. (AC1) ADMIN создаёт вакансию через Sheet-форму (авто-slug) и публикует', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/vacancies')
    await expect(page.getByTestId('vacancies-page')).toBeVisible()

    await page.getByTestId('vacancy-create-button').click()
    const sheet = page.getByTestId('vacancy-sheet')
    await expect(sheet).toBeVisible()

    await fillVacancyForm(sheet, {
      title,
      location: 'Remote',
      descriptionMd: 'E2E full-flow spec description for the vacancy under test.',
    })
    // Auto-slug: slugifyTitle(title) — verifies §4.2's auto-link behaviour.
    await expect(sheet.getByTestId('vacancy-form-slug')).toHaveValue(slug)

    await sheet.getByTestId('vacancy-sheet-submit').click()
    await expect(sheet).not.toBeVisible()

    const list = page.getByTestId('vacancies-list')
    const card = list.locator('[data-testid^="vacancy-card-"]').filter({ hasText: title })
    await expect(card).toBeVisible()
    const cardTestId = await card.getAttribute('data-testid')
    vacancyId = cardTestId!.replace('vacancy-card-', '')

    await expect(card.getByTestId(`vacancy-status-badge-${vacancyId}`)).toHaveText('Черновик')

    // Publish — exact testid (NOT a prefix match: a `-mobile-` sibling button
    // shares the `vacancy-publish-` prefix, see playwright-patterns skill).
    await card.getByTestId(`vacancy-publish-${vacancyId}`).click()
    await expect(card.getByTestId(`vacancy-status-badge-${vacancyId}`)).toHaveText('Опубликовано')
  })

  test('2. (AC6) Публичный список вакансий отдаёт опубликованную из п.1', async ({ page }) => {
    const res = await page.request.get(`${REAL_API_BASE}/api/public/vacancies`)
    expect(res.status()).toBe(200)
    const list = (await res.json()) as Array<{ slug: string; title: string }>
    expect(list.map((v) => v.slug)).toContain(slug)

    const detailRes = await page.request.get(`${REAL_API_BASE}/api/public/vacancies/${slug}`)
    expect(detailRes.status()).toBe(200)
    const detail = (await detailRes.json()) as { title: string }
    expect(detail.title).toBe(title)
  })

  test('3. (AC2) Публичный отклик — POST /apply напрямую → 201', async ({ page }) => {
    const { status } = await submitPublicApply(page, {
      slug,
      fullName: 'Ivan E2E Candidate',
      email: candidateEmail,
    })
    expect(status).toBe(201)
  })

  test('4. (AC3) HR: вкладка «Отклики» — NEW-бейдж, статусы, удаление отклика', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_EMAILS.hrA)

    // Resolve the application id via the admin API (apply() only returns
    // `{ ok: true }` — no id in the response body).
    const listRes = await page.request.get(
      `${REAL_API_BASE}/api/vacancies/${vacancyId}/applications`,
    )
    expect(listRes.status()).toBe(200)
    const applications = (await listRes.json()) as Array<{ id: string; email: string }>
    const application = applications.find((a) => a.email === candidateEmail)
    expect(application, 'candidate application must exist').toBeTruthy()
    applicationId = application!.id

    await page.goto(`/vacancies/${vacancyId}?tab=applications`)
    const candidateCard = page.getByTestId(`candidate-card-${applicationId}`)
    await expect(candidateCard).toBeVisible()
    await expect(candidateCard.getByTestId(`candidate-new-badge-${applicationId}`)).toBeVisible()
    await expect(candidateCard.getByTestId(`candidate-download-${applicationId}`)).toBeVisible()

    const statusToggle = candidateCard.getByTestId(`candidate-status-${applicationId}`)
    await expect(statusToggle.getByRole('radio', { name: 'Новый' })).toBeChecked()

    // Новый → Просмотрено
    await statusToggle.getByRole('radio', { name: 'Просмотрено' }).click()
    await expect(statusToggle.getByRole('radio', { name: 'Просмотрено' })).toBeChecked()
    await expect(
      candidateCard.getByTestId(`candidate-new-badge-${applicationId}`),
    ).not.toBeAttached()

    // Просмотрено → Отклонено
    await statusToggle.getByRole('radio', { name: 'Отклонено' }).click()
    await expect(statusToggle.getByRole('radio', { name: 'Отклонено' })).toBeChecked()

    // Delete — confirm dialog must warn about the resume file (task AC).
    await candidateCard.getByTestId(`candidate-delete-${applicationId}`).click()
    const confirmDialog = page.getByRole('alertdialog', { name: 'Удалить отклик?' })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText('файл резюме')
    await confirmDialog.getByTestId(`candidate-delete-confirm-${applicationId}`).click()

    await expect(page.getByTestId('applications-empty-state')).toBeVisible()
    applicationId = undefined // cleaned — afterAll below has nothing left to do
  })

  test('5. (AC4) Вакансия: close → re-open → close; delete-гард (не DRAFT); отклики очищены', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto(`/vacancies/${vacancyId}`)
    await expect(page.getByTestId('vacancy-detail-status-badge')).toHaveText('Опубликовано')

    // close
    await page.getByTestId('vacancy-detail-close').click()
    await expect(page.getByTestId('vacancy-detail-status-badge')).toHaveText('Закрыто')

    // re-open
    await page.getByTestId('vacancy-detail-reopen').click()
    await expect(page.getByTestId('vacancy-detail-status-badge')).toHaveText('Опубликовано')

    // close again — end state for this vacancy
    await page.getByTestId('vacancy-detail-close').click()
    await expect(page.getByTestId('vacancy-detail-status-badge')).toHaveText('Закрыто')

    // delete-guard: not DRAFT → disabled + tooltip (Опасная зона card, full variant).
    const deleteBtn = page.getByTestId(`vacancy-delete-disabled-${vacancyId}`)
    await expect(deleteBtn).toBeVisible()
    await expect(deleteBtn).toBeDisabled()
    // Radix wraps a disabled TooltipTrigger in a `<span>` (disabled buttons
    // don't reliably fire pointer events) — that span visually sits ON TOP
    // of the button and fails Playwright's own actionability "receives
    // pointer events" pre-check on the button itself. `force: true` skips
    // that pre-check and dispatches the hover at the button's coordinates —
    // the browser's real elementFromPoint then correctly routes it to the
    // intercepting span, which is what the Tooltip is actually listening on
    // (verified: without `force`, the hover times out — confirmed live).
    await deleteBtn.hover({ force: true })
    await expect(page.getByText('Удалить можно только вакансию в статусе DRAFT')).toBeVisible()

    // Regression guard for the deleted application (previous step) — no
    // residue in the vacancy's own applications list.
    const appsRes = await page.request.get(
      `${REAL_API_BASE}/api/vacancies/${vacancyId}/applications`,
    )
    expect((await appsRes.json()) as unknown[]).toHaveLength(0)
  })

  test.afterAll(async ({ request }) => {
    // Best-effort safety net — the main flow above already deletes the
    // application itself (step 4, part of the AC), so this is normally a
    // no-op. Only matters if step 4 failed mid-way and left the row behind.
    if (!applicationId || !vacancyId) return
    await request.post(`${REAL_API_BASE}/api/auth/dev-login`, { data: { email: SEED_ADMIN_EMAIL } })
    await request
      .delete(`${REAL_API_BASE}/api/vacancies/${vacancyId}/applications/${applicationId}`)
      .catch(() => undefined)
  })
})

// ===========================================================================
// DRAFT vacancy delete — AC4's last clause, fully self-cleaning
// ===========================================================================

test('DRAFT-вакансия: удаление через список полностью убирает её (без остаточных данных)', async ({
  page,
}) => {
  await loginViaApi(page, SEED_ADMIN_EMAIL)

  const suffix = `${Date.now()}`
  const title = `E2E Draft Delete ${suffix}`
  const slug = `e2e-draft-delete-${suffix}`

  const createRes = await page.request.post(`${REAL_API_BASE}/api/vacancies`, {
    data: {
      title,
      slug,
      descriptionMd: 'Throwaway DRAFT vacancy — created only to exercise delete.',
      domain: 'AI',
      seniority: 'SENIOR',
      employmentType: 'FULL_TIME',
      location: 'Remote',
    },
  })
  expect(createRes.status()).toBe(201)
  const created = (await createRes.json()) as { id: string; status: string }
  expect(created.status).toBe('DRAFT')

  await page.goto('/vacancies')
  const list = page.getByTestId('vacancies-list')
  const card = list.getByTestId(`vacancy-card-${created.id}`)
  await expect(card).toBeVisible()

  // List-page delete is the ICON variant (no `-disabled-` suffix — 0
  // applications on a fresh DRAFT vacancy means the guard allows it).
  await card.getByTestId(`vacancy-delete-${created.id}`).click()
  const confirmDialog = page.getByRole('alertdialog', { name: 'Удалить вакансию?' })
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByTestId(`vacancy-delete-confirm-${created.id}`).click()

  await expect(card).not.toBeAttached()

  // No residue: a fresh admin list fetch no longer contains this vacancy id.
  const afterRes = await page.request.get(`${REAL_API_BASE}/api/vacancies`)
  const afterList = (await afterRes.json()) as Array<{ id: string }>
  expect(afterList.map((v) => v.id)).not.toContain(created.id)
})

// ===========================================================================
// RBAC smoke — AC5
// ===========================================================================

test.describe('Vacancies — RBAC-смоук (AC5)', () => {
  for (const [roleLabel, email] of [
    ['SENIOR', SEED_EMAILS.seniorA],
    ['DROP', DROP_EMAIL],
  ] as const) {
    test(`${roleLabel}: нет пункта «Вакансии» в сайдбаре, /vacancies редиректит, API 403`, async ({
      page,
    }) => {
      await loginViaApi(page, email)
      await page.goto('/')

      const nav = page.getByRole('navigation', { name: 'Основная навигация' })
      // Not rendered at all by RBAC (not just hidden) — assert not.toBeAttached(),
      // per the 2026-07-12 stale-expectation lesson (memory/autotest/lessons.md).
      await expect(nav.getByRole('link', { name: 'Вакансии' })).not.toBeAttached()

      await page.goto('/vacancies')
      await expect(page).toHaveURL(`${new URL(page.url()).origin}/`)
      await expect(page.getByTestId('vacancies-page')).not.toBeAttached()

      const apiRes = await page.request.get(`${REAL_API_BASE}/api/vacancies`)
      expect(apiRes.status()).toBe(403)
    })
  }
})
