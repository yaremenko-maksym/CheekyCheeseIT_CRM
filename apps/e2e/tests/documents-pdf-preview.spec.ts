/**
 * documents-pdf-preview.spec.ts
 *
 * E2E тесты для inline PDF-превью в диалоге документов (task: documents-pdf-preview).
 *
 * AC Coverage:
 *   AC1. Открыть диалог загруженного PDF → превью-контейнер виден
 *        ([data-testid="document-pdf-preview"] присутствует).
 *   AC2. КЛЮЧЕВОЙ: «Скачать» для PDF НЕ делает новых запросов к S3 / /download —
 *        скачивание из blob (0 повторных запросов).
 *   AC3. Виртуальный контракт (source='employee_contract') → превью рендерится
 *        ([data-testid="document-pdf-preview"] виден).
 *
 * Паттерн: page.route() мокает API — не требует живого бэка для UI-логики.
 * Сетевой перехват (AC2) использует page.route() для S3 endpoint + счётчики.
 *
 * FIX (fix-round):
 *   1. PDF_DOC_ID / CONTRACT_DOC_ID — валидные UUID (validateSearch проверяет
 *      openDocId через z.string().uuid(); невалидный ID → navigate зависает → click timeout).
 *   2. Для открытия диалога используем ?openDocId= deep-link вместо click по карточке —
 *      это гарантирует открытие диалога без зависимости от view mode / click target перекрытия.
 *   3. Мок списка документов через regex (LIFO — после mockAuthAs → побеждает).
 */

import { test, expect, USERS, mockAuthAs } from './fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Тестовые данные
// ---------------------------------------------------------------------------

// ВАЖНО: ID должны быть валидными UUID — DocumentsPage.openDetail() вызывает
// navigate({ search: { openDocId: doc.id } }), validateSearch ожидает z.string().uuid().
const PDF_DOC_ID = 'e2e00001-0000-4000-8000-000000000001'
const CONTRACT_DOC_ID = 'e2e00001-0000-4000-8000-000000000002'
const CONTRACT_USER_ID = USERS.senior.id

/** Создаёт Document DTO для загруженного PDF. */
function makePdfDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: PDF_DOC_ID,
    ownerId: USERS.admin.id,
    projectId: null,
    category: 'RESUME',
    name: 'resume-test.pdf',
    originalName: 'резюме-тест.pdf',
    s3Key: 'docs/resume-test.pdf',
    thumbnailS3Key: null,
    sizeBytes: 102400,
    mimeType: 'application/pdf',
    uploadedBy: USERS.admin.id,
    uploadedByDisplayName: USERS.admin.displayName,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date().toISOString(),
    invoiceTransactionId: null,
    invoicePendingSignature: false,
    statusBadge: null,
    source: 'file',
    ...overrides,
  }
}

/** Создаёт Document DTO для виртуального контракта. */
function makeContractDocument() {
  return {
    id: CONTRACT_DOC_ID,
    ownerId: CONTRACT_USER_ID,
    projectId: null,
    category: 'CONTRACT',
    name: `contract-${CONTRACT_USER_ID}.pdf`,
    originalName: 'Трудовой договор.pdf',
    s3Key: `contracts/${CONTRACT_USER_ID}.pdf`,
    thumbnailS3Key: null,
    sizeBytes: 51200,
    mimeType: 'application/pdf',
    uploadedBy: USERS.admin.id,
    uploadedByDisplayName: USERS.admin.displayName,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date().toISOString(),
    invoiceTransactionId: null,
    invoicePendingSignature: false,
    statusBadge: null,
    source: 'employee_contract',
  }
}

// ---------------------------------------------------------------------------
// Фиктивный PDF blob (минимальный валидный PDF-like контент)
// ---------------------------------------------------------------------------

const FAKE_PDF_CONTENT = '%PDF-1.4\n1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj\n%%EOF'

// ---------------------------------------------------------------------------
// Хелпер: мокает auth + список документов + presigned URL
// ---------------------------------------------------------------------------

async function setupDocumentsMocks(
  page: import('@playwright/test').Page,
  documents: unknown[],
  presignedUrl = 'http://minio-test:9000/crm-documents/fake.pdf?X-Amz-Signature=fakesig',
) {
  // Auth + все базовые endpoints (включая пустой мок /documents)
  await mockAuthAs(page, USERS.admin)

  // Переопределяем мок документов из mockAuthAs — этот зарегистрирован ПОЗЖЕ → LIFO → побеждает.
  // Regex вместо glob для надёжности.
  await page.route(new RegExp(`${API}/documents(\\?.*)?$`), (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(documents),
    })
  })

  // Presigned download URL для нашего тестового PDF-документа
  await page.route(`${API}/documents/${PDF_DOC_ID}/download`, (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        url: presignedUrl,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    })
  })

  // Thumbnail — null для PDF
  await page.route(`${API}/documents/${PDF_DOC_ID}/thumbnail`, (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
  })
}

// ---------------------------------------------------------------------------
// Хелпер: открывает диалог через deep-link ?openDocId=
// Надёжнее клика по карточке — не зависит от view mode / scroll позиции.
// ---------------------------------------------------------------------------

async function openDocumentDialog(
  page: import('@playwright/test').Page,
  docId: string,
) {
  // Deep-link: DocumentsPageContent.useEffect смотрит openDocId → вызывает openDetail()
  // Используем ?view=list для стабильного list-view (localStorage может хранить другой)
  await page.addInitScript(() => {
    localStorage.removeItem('crm.documents.view')
  })
  await page.goto(`/crm/documents?view=list&openDocId=${docId}`)
  await page.waitForLoadState('networkidle')
}

// ---------------------------------------------------------------------------
// AC1: Открыть диалог PDF → document-pdf-preview присутствует
// ---------------------------------------------------------------------------

test.describe('AC1: PDF inline preview в диалоге документов', () => {
  test('открытие диалога PDF показывает document-pdf-preview testid', async ({ page }) => {
    const pdfDoc = makePdfDocument()
    const S3_PDF_URL =
      'http://minio-test:9000/crm-documents/resume-test.pdf?X-Amz-Signature=fake-ac1'

    await setupDocumentsMocks(page, [pdfDoc], S3_PDF_URL)

    // Мокаем S3 presigned URL → возвращаем PDF blob
    await page.route(S3_PDF_URL, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from(FAKE_PDF_CONTENT),
      })
    })

    // Открываем через deep-link — диалог должен открыться автоматически
    await openDocumentDialog(page, PDF_DOC_ID)

    // Диалог должен открыться
    const dialogTitle = page.getByTestId('document-detail-title')
    await expect(dialogTitle).toBeVisible({ timeout: 5000 })

    // Превью-контейнер должен присутствовать
    const previewContainer = page.getByTestId('document-detail-preview')
    await expect(previewContainer).toBeVisible()

    // PdfPreview div присутствует в DOM — контейнер рендерится при открытии диалога
    // (data-testid всегда виден — в состояниях loading/fallback/error/ready)
    const pdfPreview = page.getByTestId('document-pdf-preview')
    await expect(pdfPreview).toBeVisible({ timeout: 8000 })
  })
})

// ---------------------------------------------------------------------------
// AC2: «Скачать» не делает нового запроса к S3 / /download
// ---------------------------------------------------------------------------

test.describe('AC2: кнопка «Скачать» использует blob — 0 повторных запросов к S3', () => {
  test('после загрузки превью клик «Скачать» не делает запрос к presigned URL или /download', async ({
    page,
  }) => {
    const pdfDoc = makePdfDocument()
    const S3_PDF_URL =
      'http://minio-test:9000/crm-documents/resume-test.pdf?X-Amz-Signature=fake-ac2'

    let s3FetchCount = 0
    let downloadApiCallCount = 0

    await setupDocumentsMocks(page, [pdfDoc], S3_PDF_URL)

    // Мокаем S3 — считаем кол-во обращений (зарегистрирован ПОСЛЕ setupDocumentsMocks → побеждает)
    await page.route(S3_PDF_URL, (route) => {
      s3FetchCount++
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from(FAKE_PDF_CONTENT),
      })
    })

    // Счётчик вызовов /download endpoint (LIFO — перекрывает setupDocumentsMocks)
    await page.route(`${API}/documents/${PDF_DOC_ID}/download`, (route) => {
      downloadApiCallCount++
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          url: S3_PDF_URL,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      })
    })

    // Открываем через deep-link
    await openDocumentDialog(page, PDF_DOC_ID)

    // Диалог должен открыться
    const dialogTitle = page.getByTestId('document-detail-title')
    await expect(dialogTitle).toBeVisible({ timeout: 5000 })

    // Ждём загрузки PDF preview — контейнер виден
    const pdfPreview = page.getByTestId('document-pdf-preview')
    await expect(pdfPreview).toBeVisible({ timeout: 8000 })

    // Ждём пока кнопка «Скачать» станет активной (blob загружен)
    const downloadBtn = page.getByTestId('document-detail-download')
    await expect(downloadBtn).toBeVisible()
    await expect(downloadBtn).toBeEnabled({ timeout: 8000 })

    // Запоминаем счётчики ПОСЛЕ загрузки превью, ДО клика «Скачать»
    const s3CountBeforeDownload = s3FetchCount
    const downloadApiCountBeforeDownload = downloadApiCallCount

    // Перехватываем программный click на <a download> — предотвращаем реальное скачивание
    await page.evaluate(() => {
      const origCreateElement = document.createElement.bind(document)
      document.createElement = (tag: string) => {
        const el = origCreateElement(tag)
        if (tag === 'a') {
          el.click = () => {
            window.localStorage.setItem(
              '__download_clicked__',
              el.getAttribute('href') ?? 'no-href',
            )
          }
        }
        return el
      }
    })

    await downloadBtn.click()

    // Небольшая пауза чтобы возможные async запросы завершились
    await page.waitForTimeout(500)

    // Проверяем: НЕТ новых обращений к S3 или /download endpoint
    expect(s3FetchCount).toBe(s3CountBeforeDownload)
    expect(downloadApiCallCount).toBe(downloadApiCountBeforeDownload)

    // Проверяем что download был вызван и использовал blob: URL (не http:// presigned URL)
    const downloadedHref = await page.evaluate(() =>
      window.localStorage.getItem('__download_clicked__'),
    )
    expect(downloadedHref).toMatch(/^blob:/)
  })
})

// ---------------------------------------------------------------------------
// AC3: Виртуальный контракт → превью рендерится
// ---------------------------------------------------------------------------

test.describe('AC3: виртуальный контракт — PDF превью', () => {
  test('employee_contract документ показывает document-pdf-preview', async ({ page }) => {
    const contractDoc = makeContractDocument()

    await mockAuthAs(page, USERS.admin)

    // Список документов — только контракт (LIFO → перекрывает пустой мок из mockAuthAs)
    await page.route(new RegExp(`${API}/documents(\\?.*)?$`), (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([contractDoc]),
      })
    })

    // Mock contract PDF endpoint (same-origin — fetchContractPdfBlob использует /api/users/:id/contract/pdf)
    await page.route(`${API}/users/${CONTRACT_USER_ID}/contract/pdf`, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from(FAKE_PDF_CONTENT),
        headers: { 'Cache-Control': 'no-store' },
      })
    })

    // Thumbnail — null для контракта
    await page.route(`${API}/documents/${CONTRACT_DOC_ID}/thumbnail`, (route) => {
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
    })

    // Открываем через deep-link CONTRACT_DOC_ID
    await page.addInitScript(() => {
      localStorage.removeItem('crm.documents.view')
    })
    await page.goto(`/crm/documents?view=list&openDocId=${CONTRACT_DOC_ID}`)
    await page.waitForLoadState('networkidle')

    // Диалог открылся
    const dialogTitle = page.getByTestId('document-detail-title')
    await expect(dialogTitle).toBeVisible({ timeout: 5000 })

    // PdfPreview контейнер присутствует
    const pdfPreview = page.getByTestId('document-pdf-preview')
    await expect(pdfPreview).toBeVisible({ timeout: 8000 })

    // Для контракта нет кнопки скачать через S3 — виртуальная запись.
    // Превью рендерится без ошибки (error state НЕ присутствует).
    const errorState = page.getByTestId('document-pdf-preview-error')
    await expect(errorState).toHaveCount(0)
  })
})
