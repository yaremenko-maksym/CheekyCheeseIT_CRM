/**
 * VacancyApplyForm — task-landing-redesign.md AC5 "форма (валид/невалид/
 * успех/ошибка)". `submitApplication` (network) and `useTurnstile` (loads a
 * real external script, see index.html) are mocked — the component's own
 * validation/state-machine logic is what's under test here, not the
 * network/widget itself (those are covered by manual verification + the
 * backend's own integration specs).
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { VacancyApplyForm } from '@/components/marketing/vacancy-apply-form'
import * as api from '@/lib/api'
import { getDictionary } from '@/i18n/dictionaries'

vi.mock('@/lib/use-turnstile', () => ({
  useTurnstile: () => ({
    containerRef: { current: null },
    token: 'test-turnstile-token',
    reset: vi.fn(),
  }),
}))

/**
 * TanStack Router's initial mount is async (Suspense-gated route
 * transition) — RTL's `render()` returns before the tree commits, so every
 * test must await something findBy* before the first synchronous
 * `getBy*`/click, or it sees an empty `<body><div /></body>`.
 */
async function renderForm(locale?: 'ru') {
  const rootRoute = createRootRoute({
    component: () => (
      <VacancyApplyForm
        slug="senior-ml-engineer"
        vacancyTitle="Senior ML Engineer"
        {...(locale ? { locale } : {})}
        dict={getDictionary(locale ?? 'en')}
      />
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const result = render(<RouterProvider router={router} />)
  await screen.findByRole('heading', {
    name: locale === 'ru' ? 'Откликнуться на вакансию' : 'Apply for this role',
  })
  return result
}

function makePdfFile(name = 'resume.pdf') {
  return new File(['%PDF-1.4 fake'], name, { type: 'application/pdf' })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VacancyApplyForm', () => {
  it('невалид — submit без данных показывает ошибки полей, НЕ вызывает submitApplication', async () => {
    const submitSpy = vi.spyOn(api, 'submitApplication')
    const user = userEvent.setup()
    await renderForm()

    await user.click(screen.getByRole('button', { name: 'Submit application' }))

    expect(await screen.findByText('Please enter your name.')).toBeTruthy()
    expect(screen.getByText('Enter a valid email.')).toBeTruthy()
    expect(screen.getByText('Please attach your CV (PDF).')).toBeTruthy()
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('валид (happy path) — успешный submit переводит форму в success-состояние', async () => {
    vi.spyOn(api, 'submitApplication').mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/Full name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/Email/), 'ada@example.com')
    const fileInput = screen.getByLabelText(/CV/)
    await user.upload(fileInput, makePdfFile())

    await user.click(screen.getByRole('button', { name: 'Submit application' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Application received')
    expect(screen.getByText(/Thanks, Ada/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Browse more roles' })).toBeTruthy()
  })

  it('ошибка сервера — submit провал показывает error-баннер, данные формы сохраняются', async () => {
    vi.spyOn(api, 'submitApplication').mockResolvedValue({
      ok: false,
      errorKind: 'duplicate',
      message: "You've already applied to this role recently.",
    })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/Full name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/Email/), 'ada@example.com')
    const fileInput = screen.getByLabelText(/CV/)
    await user.upload(fileInput, makePdfFile())

    await user.click(screen.getByRole('button', { name: 'Submit application' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent("You've already applied to this role recently.")
    // Form data is preserved, NOT cleared, on error.
    expect(screen.getByLabelText(/Full name/)).toHaveValue('Ada Lovelace')
    expect(screen.getByLabelText(/Email/)).toHaveValue('ada@example.com')
  })

  it('review round 1 MED-1 — locale="ru" + server-error resolves the LOCALIZED banner from errorKind, not the English api.ts message', async () => {
    vi.spyOn(api, 'submitApplication').mockResolvedValue({
      ok: false,
      errorKind: 'duplicate',
      // Deliberately English (mirrors what `lib/api.ts`'s ERROR_COPY always
      // sets) — the component must NOT surface this string; it must resolve
      // the RU dictionary's `apiErrorDuplicate` from `errorKind` instead.
      message: "You've already applied to this role recently.",
    })
    const user = userEvent.setup()
    await renderForm('ru')

    await user.type(screen.getByLabelText(/Имя и фамилия/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/Email/), 'ada@example.com')
    const fileInput = screen.getByLabelText(/CV/)
    await user.upload(fileInput, makePdfFile())

    await user.click(screen.getByRole('button', { name: 'Отправить отклик' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('Вы уже откликались на эту вакансию недавно.')
    expect(banner.textContent).not.toContain("You've already applied")
  })

  it('невалидный LinkedIn URL — блокирует submit с понятной ошибкой', async () => {
    const submitSpy = vi.spyOn(api, 'submitApplication')
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/Full name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/Email/), 'ada@example.com')
    await user.type(screen.getByLabelText('LinkedIn URL'), 'not-a-url')

    await user.click(screen.getByRole('button', { name: 'Submit application' }))

    expect(await screen.findByText(/Enter a valid LinkedIn URL/)).toBeTruthy()
    await waitFor(() => expect(submitSpy).not.toHaveBeenCalled())
  })

  it('task-landing-i18n.md — locale="ru" рендерит переведённые поля и ошибки валидации', async () => {
    const user = userEvent.setup()
    await renderForm('ru')

    expect(screen.getByText('Имя и фамилия')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Отправить отклик' }))
    expect(await screen.findByText('Пожалуйста, введите имя.')).toBeTruthy()
  })
})
