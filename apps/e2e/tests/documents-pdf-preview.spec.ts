/**
 * documents-pdf-preview.spec.ts
 *
 * E2E тесты для inline PDF-превью в диалоге документов (task: documents-pdf-preview).
 *
 * AC Coverage:
 *   AC1. Открыть диалог загруженного PDF → превью-iframe виден
 *        ([data-testid="document-pdf-preview"] присутствует).
 *   AC2. КЛЮЧЕВОЙ: «Скачать» для PDF НЕ делает новых запросов к S3 / /download —
 *        скачивание из blob (0 повторных запросов).
 *   AC3. Виртуальный контракт (source='employee_contract') → превью рендерится
 *        ([data-testid="document-pdf-preview"] виден).
 *
 * Паттерн: page.route() мокает API — не требует живого бэка для UI-логики.
 * Сетевой перехват (AC2) использует page.route() для S3 endpoint + page.on('request').
 */

import { test, expect, USERS, mockAuthAs, API_GLOB } from './fixtures'

// ---------------------------------------------------------------------------
// Тестовые данные
// ---------------------------------------------------------------------------

const PDF_DOC_ID = 'pdf-doc-e2e-test-1'
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
    id: `contract-${CONTRACT_USER_ID}`,
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
// Фиктивный PDF blob (минимальный валидный PDF)
// ---------------------------------------------------------------------------

// 1-байт минимальный PDF-like контент (достаточно для Blob API)
const FAKE_PDF_CONTENT = '%PDF-1.4\n1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj\n%%EOF'

// ---------------------------------------------------------------------------
// Хелпер: мокает auth + список документов + presigned URL
// ---------------------------------------------------------------------------

async function setupDocumentsMocks(
  page: import('@playwright/test').Page,
  documents: unknown[],
  presignedUrlSuffix = 'blob:http://minio:9000/crm-documents/fake-pdf',
) {
  // Auth
  await mockAuthAs(page, USERS.admin)

  // Documents list
  await page.route(`${API_GLOB}/documents*`, (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(documents),
    })
  })

  // Presigned download URL для PDF документа
  await page.route(`${API_GLOB}/documents/${PDF_DOC_ID}/download`, (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        url: presignedUrlSuffix,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    })
  })

  // Thumbnail URL — для PDF возвращаем null (нет тумбнейла)
  await page.route(`${API_GLOB}/documents/${PDF_DOC_ID}/thumbnail`, (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
  })
}

// ---------------------------------------------------------------------------
// AC1: Открыть диалог PDF → iframe присутствует
// ---------------------------------------------------------------------------

test.describe('AC1: PDF inline preview в диалоге документов', () => {
  test('открытие диалога PDF показывает document-pdf-preview testid', async ({ page }) => {
    const pdfDoc = makePdfDocument()
    const S3_PDF_URL = 'http://minio-test:9000/crm-documents/resume-test.pdf?X-Amz-Signature=fake'

    await setupDocumentsMocks(page, [pdfDoc], S3_PDF_URL)

    // Мокаем fetch к presigned S3 URL → возвращаем PDF blob
    await page.route(S3_PDF_URL, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from(FAKE_PDF_CONTENT),
      })
    })

    await page.goto('/documents')
    await page.waitForLoadState('networkidle')

    // Открываем карточку документа — кликаем по preview area или имени
    const docCard = page.getByText('резюме-тест.pdf').first()
    await expect(docCard).toBeVisible({ timeout: 5000 })
    await docCard.click()

    // Диалог должен открыться
    const dialogTitle = page.getByTestId('document-detail-title')
    await expect(dialogTitle).toBeVisible({ timeout: 5000 })

    // Превью-контейнер должен присутствовать
    const previewContainer = page.getByTestId('document-detail-preview')
    await expect(previewContainer).toBeVisible()

    // PdfPreview должен присутствовать в DOM (data-testid="document-pdf-preview")
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
    const S3_PDF_URL = 'http://minio-test:9000/crm-documents/resume-test.pdf?X-Amz-Signature=fake2'

    await setupDocumentsMocks(page, [pdfDoc], S3_PDF_URL)

    let s3FetchCount = 0
    let downloadApiCallCount = 0

    // Мокаем S3 — считаем кол-во обращений
    await page.route(S3_PDF_URL, (route) => {
      s3FetchCount++
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from(FAKE_PDF_CONTENT),
      })
    })

    // Считаем вызовы /download endpoint
    await page.route(`${API_GLOB}/documents/${PDF_DOC_ID}/download`, (route) => {
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

    await page.goto('/documents')
    await page.waitForLoadState('networkidle')

    // Открываем диалог
    const docCard = page.getByText('резюме-тест.pdf').first()
    await expect(docCard).toBeVisible({ timeout: 5000 })
    await docCard.click()

    const dialogTitle = page.getByTestId('document-detail-title')
    await expect(dialogTitle).toBeVisible({ timeout: 5000 })

    // Ждём загрузки превью (iframe появляется)
    const pdfPreview = page.getByTestId('document-pdf-preview')
    await expect(pdfPreview).toBeVisible({ timeout: 8000 })

    // Запоминаем кол-во обращений к S3 ПОСЛЕ загрузки превью
    const s3CountBeforeDownload = s3FetchCount
    const downloadApiCountBeforeDownload = downloadApiCallCount

    // Перехватываем создание <a download> через window.URL.createObjectURL
    // и подмену click — чтобы не открывалось реальное скачивание в браузере
    await page.evaluate(() => {
      // Перехватываем click на созданных anchor элементах
      const origCreateElement = document.createElement.bind(document)
      document.createElement = (tag: string) => {
        const el = origCreateElement(tag)
        if (tag === 'a') {
          el.click = () => {
            // Помечаем в localStorage факт вызова download
            window.localStorage.setItem(
              '__download_clicked__',
              el.getAttribute('href') ?? 'no-href',
            )
          }
        }
        return el
      }
    })

    // Кликаем «Скачать»
    const downloadBtn = page.getByTestId('document-detail-download')
    await expect(downloadBtn).toBeVisible()
    // Кнопка должна быть активна (blob загружен)
    await expect(downloadBtn).toBeEnabled({ timeout: 6000 })
    await downloadBtn.click()

    // Проверяем: НЕТ новых обращений к S3 или /download endpoint
    // Небольшая пауза чтобы возможные async запросы завершились
    await page.waitForTimeout(500)

    expect(s3FetchCount).toBe(s3CountBeforeDownload)
    expect(downloadApiCallCount).toBe(downloadApiCountBeforeDownload)

    // Проверяем что download был вызван (через наш перехватчик)
    const downloadedHref = await page.evaluate(() =>
      window.localStorage.getItem('__download_clicked__'),
    )
    // Должен быть blob: URL (не http:// presigned URL)
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

    // Список документов — только контракт
    await page.route(`${API_GLOB}/documents*`, (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([contractDoc]),
      })
    })

    // Mock contract PDF endpoint (same-origin — используется fetchContractPdfBlob)
    await page.route(`${API_GLOB}/users/${CONTRACT_USER_ID}/contract/pdf`, (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from(FAKE_PDF_CONTENT),
        // no-store — не кешируется в SW
        headers: { 'Cache-Control': 'no-store' },
      })
    })

    // Thumbnail — null для контракта
    await page.route(`${API_GLOB}/documents/${contractDoc.id}/thumbnail`, (route) => {
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
    })

    await page.goto('/documents')
    await page.waitForLoadState('networkidle')

    // Кликаем по карточке контракта
    const docCard = page.getByText('Трудовой договор.pdf').first()
    await expect(docCard).toBeVisible({ timeout: 5000 })
    await docCard.click()

    // Диалог открылся
    const dialogTitle = page.getByTestId('document-detail-title')
    await expect(dialogTitle).toBeVisible({ timeout: 5000 })

    // PdfPreview контейнер присутствует
    const pdfPreview = page.getByTestId('document-pdf-preview')
    await expect(pdfPreview).toBeVisible({ timeout: 8000 })

    // Для контракта нет кнопки скачать через S3 — это виртуальная запись
    // Проверяем что превью рендерится без ошибки
    const errorState = page.getByTestId('document-pdf-preview-error')
    await expect(errorState).toHaveCount(0)
  })
})
