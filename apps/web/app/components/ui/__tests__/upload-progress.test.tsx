/**
 * upload-progress.tsx — unit tests (task-upload-freeze-and-progress.md AC3/AC4).
 *
 * Pins:
 * 1. idle -> renders nothing.
 * 2. preparing/processing -> indeterminate progressbar (no aria-valuenow,
 *    has aria-valuetext) + correct label.
 * 3. uploading -> determinate progressbar with aria-valuenow=percent + "NN%"
 *    text.
 * 4. success -> distinct label, no progressbar role (the bar itself is
 *    hidden once done).
 * 5. error -> role="alert" + message; Retry button renders ONLY when
 *    `onRetry` is passed, and is a real, keyboard-operable <button> (Tab +
 *    Enter fires the callback — AC4 "проверка с клавиатуры").
 * 6. size="sm" renders the compact inline variant (icon + text, no bar).
 *
 * task-i18n-stage3a (Task 1): labels now go through the active catalog
 * (`DEFAULT_LABEL_MESSAGES`, `useLingui()`) — every render needs an
 * `I18nProvider` ancestor (SPEC-H-1). `state.error` stays a raw pass-through
 * string (server-provided message, not a catalog label), so those fixtures
 * are untouched.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UploadProgress, type UploadProgressState } from '../upload-progress'

beforeEach(async () => {
  await loadCatalog('uk')
})

function renderProgress(props: Parameters<typeof UploadProgress>[0]) {
  return render(<UploadProgress {...props} />, { wrapper: I18nTestProvider })
}

describe('UploadProgress', () => {
  it('renders nothing when idle', () => {
    const state: UploadProgressState = { phase: 'idle' }
    const { container } = renderProgress({ state })
    expect(container).toBeEmptyDOMElement()
  })

  it('preparing: indeterminate progressbar with the catalog label, no aria-valuenow', () => {
    renderProgress({ state: { phase: 'preparing' }, testId: 'up' })
    const bar = within(screen.getByTestId('up')).queryByRole('progressbar')
    expect(bar).not.toBeNull()
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('aria-valuetext', 'Підготовка файлу…')
    expect(screen.getByText('Підготовка файлу…')).toBeInTheDocument()
  })

  it('uploading: determinate progressbar with aria-valuenow=percent and NN% text', () => {
    renderProgress({ state: { phase: 'uploading', percent: 42 }, testId: 'up' })
    const bar = within(screen.getByTestId('up')).queryByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('processing: indeterminate, distinct label from preparing/uploading', () => {
    renderProgress({ state: { phase: 'processing' }, testId: 'up' })
    expect(screen.getByText('Обробка…')).toBeInTheDocument()
  })

  it('success: distinct "Готово" label, no progressbar (nothing left to measure)', () => {
    renderProgress({ state: { phase: 'success' }, testId: 'up' })
    expect(screen.getByText('Готово')).toBeInTheDocument()
    expect(within(screen.getByTestId('up')).queryByRole('progressbar')).toBeNull()
  })

  it('error: role=alert with the message, no Retry button when onRetry is absent', () => {
    renderProgress({ state: { phase: 'error', error: 'Сеть недоступна' }, testId: 'up' })
    expect(screen.getByRole('alert')).toHaveTextContent('Сеть недоступна')
    expect(screen.queryByRole('button', { name: /Повторити/ })).not.toBeInTheDocument()
  })

  it('error + onRetry: a focusable Retry button that fires on click and on Enter', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    renderProgress({
      state: { phase: 'error', error: 'Сеть недоступна' },
      onRetry,
      testId: 'up',
    })
    const retry = screen.getByTestId('up-retry')
    expect(retry.tagName).toBe('BUTTON')

    await user.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)

    retry.focus()
    expect(retry).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('size="sm" renders the compact inline variant with the percent baked into one line', () => {
    renderProgress({ state: { phase: 'uploading', percent: 7 }, size: 'sm', testId: 'up' })
    const el = screen.getByTestId('up')
    expect(el.tagName).toBe('SPAN')
    expect(el).toHaveTextContent('Завантаження… 7%')
  })

  // MUT-1 (fix-round 2): `phaseLabel()`'s OWN error branch (`if (state.phase
  // === 'error') return override ?? state.error ?? i18n._(...)`) is
  // computed for EVERY size (feeds `aria-valuetext`), but its return value
  // is only actually RENDERED as visible text in the `size="sm"` variant —
  // the `size="default"` error block (tested above) reads `state.error`
  // directly, bypassing `phaseLabel()` entirely. No existing test rendered
  // size="sm" with phase="error" at all.
  it('size="sm" error phase shows the explicit error message', () => {
    renderProgress({
      state: { phase: 'error', error: 'Сеть недоступна' },
      size: 'sm',
      testId: 'up',
    })
    expect(screen.getByTestId('up')).toHaveTextContent('Сеть недоступна')
  })

  // MUT-1: the DEFAULT error message (`DEFAULT_LABEL_MESSAGES.error`) was
  // never exercised by ANY test — every error-phase fixture above supplies
  // its own explicit `state.error`.
  it('size="sm" error phase falls back to the default catalog message when state.error is absent', () => {
    renderProgress({ state: { phase: 'error' }, size: 'sm', testId: 'up' })
    expect(screen.getByTestId('up')).toHaveTextContent('Не вдалося завантажити файл')
  })

  // MUT-1: an `override` (the `label` prop) during error phase must win
  // over BOTH `state.error` and the default message — the `??` chain's
  // FIRST link, never exercised by any test.
  it('size="sm" error phase prefers the label override over state.error', () => {
    renderProgress({
      state: { phase: 'error', error: 'Сеть недоступна' },
      label: 'Custom override',
      size: 'sm',
      testId: 'up',
    })
    expect(screen.getByTestId('up')).toHaveTextContent('Custom override')
    expect(screen.getByTestId('up')).not.toHaveTextContent('Сеть недоступна')
  })

  // MUT-1: `label ?? i18n._(DEFAULT_LABEL_MESSAGES.uploading)` (the
  // size="default" uploading label — a SEPARATE ternary from `phaseLabel()`)
  // — no existing test ever passed a `label` override during 'uploading'.
  it('size="default" uploading phase prefers the label override over the default "Завантаження…"', () => {
    renderProgress({
      state: { phase: 'uploading', percent: 50 },
      label: 'Custom uploading label',
      testId: 'up',
    })
    expect(screen.getByText('Custom uploading label')).toBeInTheDocument()
    expect(screen.queryByText('Завантаження…')).not.toBeInTheDocument()
  })
})
