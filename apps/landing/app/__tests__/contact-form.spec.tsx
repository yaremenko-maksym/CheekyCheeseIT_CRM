/**
 * ContactForm — task-landing-contact-and-hiring-strip.md AC (форма: валид/
 * невалид/успех/ошибка). `submitContact` (network) and `useTurnstile`
 * (loads a real external script, see index.html) are mocked — the
 * component's own validation/state-machine logic is what's under test here.
 * Mirrors `vacancy-apply-form.spec.tsx`'s structure/conventions exactly.
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
import { ContactForm } from '@/components/marketing/contact-form'
import * as api from '@/lib/api'
import { getDictionary } from '@/i18n/dictionaries'

vi.mock('@/lib/use-turnstile', () => ({
  useTurnstile: () => ({
    containerRef: { current: null },
    token: 'test-turnstile-token',
    reset: vi.fn(),
  }),
}))

/** Same async-mount rationale as vacancy-apply-form.spec.tsx's `renderForm`. */
async function renderForm(locale?: 'ru') {
  const rootRoute = createRootRoute({
    component: () => <ContactForm dict={getDictionary(locale ?? 'en')} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const result = render(<RouterProvider router={router} />)
  await screen.findByRole('button', {
    name: locale === 'ru' ? 'Отправить сообщение' : 'Send message',
  })
  return result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ContactForm', () => {
  it('невалид — submit без данных показывает ошибки полей, НЕ вызывает submitContact', async () => {
    const submitSpy = vi.spyOn(api, 'submitContact')
    const user = userEvent.setup()
    await renderForm()

    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText('Please enter your name.')).toBeTruthy()
    expect(screen.getByText('Enter a valid email.')).toBeTruthy()
    expect(screen.getByText('Tell us a bit more (at least 10 characters).')).toBeTruthy()
    expect(submitSpy).not.toHaveBeenCalled()
  })

  // design round 1 LOW-1 — a failed client-side validation must move real
  // DOM focus to the first invalid field (name → email → message order),
  // not leave it on the submit button — aria-invalid/aria-describedby alone
  // only announces once the user tabs there THEMSELVES.
  it('design round 1 LOW-1 — невалидный submit переводит фокус на ПЕРВОЕ невалидное поле (Name)', async () => {
    const user = userEvent.setup()
    await renderForm()

    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await screen.findByText('Please enter your name.')
    expect(document.activeElement).toBe(screen.getByLabelText(/^Name/))
  })

  it('design round 1 LOW-1 — Name валиден, Email/Message невалидны → фокус на Email (следующее по порядку)', async () => {
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await screen.findByText('Enter a valid email.')
    expect(document.activeElement).toBe(screen.getByLabelText(/^Email/))
  })

  it('design round 1 LOW-1 — только Message невалиден → фокус на Message', async () => {
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await screen.findByText('Tell us a bit more (at least 10 characters).')
    expect(document.activeElement).toBe(screen.getByLabelText(/What are you building\?/))
  })

  it('валид (happy path) — успешный submit переводит форму в success-состояние', async () => {
    vi.spyOn(api, 'submitContact').mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.type(
      screen.getByLabelText(/What are you building\?/),
      'We need a senior team for a new AI product.',
    )

    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Message received')
    expect(
      screen.getByText("Thanks — we've got it and will reply within one business day."),
    ).toBeTruthy()
  })

  it('happy path передаёт trim()-нутые поля + honeypot + turnstile token в submitContact', async () => {
    const submitSpy = vi.spyOn(api, 'submitContact').mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), '  Ada Lovelace  ')
    await user.type(screen.getByLabelText('Company'), '  Acme Inc  ')
    await user.type(screen.getByLabelText(/^Email/), '  ada@example.com  ')
    await user.type(screen.getByLabelText(/What are you building\?/), '  We need a senior team.  ')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      company: 'Acme Inc',
      email: 'ada@example.com',
      message: 'We need a senior team.',
      turnstileToken: 'test-turnstile-token',
      website: '',
    })
  })

  it('company не передаётся вовсе, если поле пустое (не company: undefined)', async () => {
    const submitSpy = vi.spyOn(api, 'submitContact').mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.type(screen.getByLabelText(/What are you building\?/), 'We need a senior team.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    const payload = submitSpy.mock.calls[0]![0]
    expect('company' in payload).toBe(false)
  })

  it('ошибка сервера (rate-limited) — показывает error-баннер + постоянную ссылку на hr@', async () => {
    vi.spyOn(api, 'submitContact').mockResolvedValue({ ok: false, errorKind: 'rate-limited' })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.type(screen.getByLabelText(/What are you building\?/), 'We need a senior team.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(
      "You've sent a few messages recently — please try again in a bit, or email us directly.",
    )
    // The fallback mailto link is ALWAYS visible, not just on error (task:
    // "Под кнопкой мелким шрифтом... mailto-ссылка остаётся ТОЛЬКО здесь").
    const fallbackLink = screen.getByRole('link', { name: /hr@cheekycheese\.tech/ })
    expect(fallbackLink.getAttribute('href')).toBe('mailto:hr@cheekycheese.tech')
    // Form data is preserved, NOT cleared, on error.
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Ada Lovelace')
  })

  it('ошибка сервера (unavailable, 503/502) — показывает соответствующий баннер', async () => {
    vi.spyOn(api, 'submitContact').mockResolvedValue({ ok: false, errorKind: 'unavailable' })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.type(screen.getByLabelText(/What are you building\?/), 'We need a senior team.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(
      'The contact form is temporarily unavailable — please email us directly.',
    )
  })

  // review round 1 MED-2 — a Turnstile (422) failure must NOT show the
  // generic "check your details" validation copy: the fields are fine.
  it('ошибка сервера (turnstile, 1й раз) — отдельный текст "попробуйте ещё раз", БЕЗ встроенной ссылки на hr@ в баннере', async () => {
    vi.spyOn(api, 'submitContact').mockResolvedValue({ ok: false, errorKind: 'turnstile' })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.type(screen.getByLabelText(/What are you building\?/), 'We need a senior team.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(
      'The "I\'m not a robot" check didn\'t go through — please try again.',
    )
    // Distinct from the generic validation copy.
    expect(banner.textContent).not.toContain('check your details')
    // Only the ONE persistent link under the button — no inline link inside
    // the banner yet (that only appears from the 2nd consecutive failure).
    expect(screen.getAllByRole('link', { name: /hr@cheekycheese\.tech/ })).toHaveLength(1)
  })

  it('ошибка сервера (turnstile, 2й раз подряд) — эскалирует до текста с встроенной ссылкой на hr@ ПРЯМО в баннере', async () => {
    vi.spyOn(api, 'submitContact').mockResolvedValue({ ok: false, errorKind: 'turnstile' })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.type(screen.getByLabelText(/What are you building\?/), 'We need a senior team.')

    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(
      'The "I\'m not a robot" check failed again. Please try once more, or email us directly at',
    )
    // NOW two links: the persistent one under the button + the new inline
    // one inside the error banner itself.
    const links = screen.getAllByRole('link', { name: /hr@cheekycheese\.tech/ })
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('mailto:hr@cheekycheese.tech')
    }
  })

  it('turnstile-стрик сбрасывается другой ошибкой — 3й submit (validation) НЕ показывает turnstile-repeat текст', async () => {
    const submitSpy = vi.spyOn(api, 'submitContact')
    submitSpy.mockResolvedValueOnce({ ok: false, errorKind: 'turnstile' })
    submitSpy.mockResolvedValueOnce({ ok: false, errorKind: 'turnstile' })
    submitSpy.mockResolvedValueOnce({ ok: false, errorKind: 'validation' })
    const user = userEvent.setup()
    await renderForm()

    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace')
    await user.type(screen.getByLabelText(/^Email/), 'ada@example.com')
    await user.type(screen.getByLabelText(/What are you building\?/), 'We need a senior team.')

    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(
      'Something went wrong sending your message. Please check your details and try again.',
    )
    // Streak reset — back to a SINGLE (persistent-only) hr@ link.
    expect(screen.getAllByRole('link', { name: /hr@cheekycheese\.tech/ })).toHaveLength(1)
  })

  it('task-landing-i18n.md — locale="ru" рендерит переведённые поля и ошибки валидации', async () => {
    const user = userEvent.setup()
    await renderForm('ru')

    expect(screen.getByText('Имя')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }))
    expect(await screen.findByText('Пожалуйста, введите имя.')).toBeTruthy()
  })
})
