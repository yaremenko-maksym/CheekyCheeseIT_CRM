/**
 * `ResumeStatusPanel` — extraction-progress and failure copy (task-resume-base
 * §3, AC3/AC5). No test file existed for this component before this round:
 * `ResumeTab.test.tsx` never drives `status` past `READY`, so every string in
 * `RUNNING_COPY` and `FAILURE_HINTS`, plus the `formatResetTime` early return
 * and the QUOTA_EXCEEDED-with-a-time branch condition, had zero coverage.
 *
 * Each render assertion pins the EXACT text (not a substring/regex), which is
 * what distinguishes a `StringLiteral` mutant (→ `` `` ``) from a passing
 * test — a loose `toHaveTextContent(/розпізна/i)` would survive most of the
 * mutants below just as easily as it survived them the first time.
 */
import { render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ComponentProps, ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeStatusPanel, formatResetTime } from '../ResumeStatusPanel'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(() => loadCatalog('uk'))

function renderPanel(overrides: Partial<ComponentProps<typeof ResumeStatusPanel>> = {}) {
  const onRetry = vi.fn()
  render(
    <ResumeStatusPanel
      status="READY"
      errorCode={null}
      errorMessage={null}
      quotaResetsAt={null}
      canEdit={true}
      onRetry={onRetry}
      {...overrides}
    />,
  )
  return { onRetry }
}

describe('formatResetTime — the null-on-unparseable-date guard', () => {
  it('formats a valid ISO instant', () => {
    expect(formatResetTime('2026-09-24T14:05:00.000Z', 'uk')).not.toBeNull()
  })

  it('returns null, not "Invalid Date", for an unparseable string', () => {
    // The mutant here flips the `if` to never fire, which would let
    // `formatDate` run on an Invalid Date and return the literal string
    // "Invalid Date" instead of null.
    expect(formatResetTime('not-a-date', 'uk')).toBeNull()
  })
})

describe('QUEUED / RUNNING — named progress, not a bare spinner', () => {
  it('QUEUED: exact title and hint', () => {
    renderPanel({ status: 'QUEUED' })
    const panel = screen.getByTestId('resume-progress')
    expect(panel).toHaveTextContent('Резюме в черзі на розпізнавання')
    expect(panel).toHaveTextContent(
      'Вкладку можна закрити — розпізнавання триває на сервері, результат з’явиться тут.',
    )
  })

  it("RUNNING: exact title and hint — different from QUEUED's", () => {
    renderPanel({ status: 'RUNNING' })
    const panel = screen.getByTestId('resume-progress')
    expect(panel).toHaveTextContent('Розпізнаємо резюме')
    expect(panel).toHaveTextContent('Зазвичай займає кілька секунд. Сторінка оновиться сама.')
    // Not the QUEUED copy — proves the two states are not accidentally
    // sharing one MessageDescriptor.
    expect(panel).not.toHaveTextContent('Резюме в черзі')
  })
})

describe('FAILED — each failure code has its own, actionable hint', () => {
  it.each([
    ['UNREADABLE_FILE', 'Файл не вдалося прочитати. Завантажте інший PDF/DOCX або вставте текст.'],
    [
      'MODEL_INVALID_JSON',
      'Не вдалося автоматично розібрати це резюме. Заповніть розділи вручну — форма нижче повністю робоча.',
    ],
    [
      'STALLED',
      'Розпізнавання перервалося на боці сервера. Завантажте файл ще раз або заповніть резюме вручну.',
    ],
    // MODEL_ERROR has no dedicated case — it falls through to
    // DEFAULT_FAILURE_HINT, same string this suite asserts below for
    // QUOTA_EXCEEDED-without-a-time. Pinned here on its own failure code so a
    // mutant on DEFAULT_FAILURE_HINT is caught regardless of which caller
    // reaches it first.
    ['MODEL_ERROR', 'Заповніть розділи вручну або спробуйте завантажити файл ще раз.'],
  ] as const)('%s renders its own hint, exactly', (errorCode, expectedHint) => {
    renderPanel({ status: 'FAILED', errorCode })
    expect(screen.getByTestId('resume-failed')).toHaveTextContent(expectedHint)
  })

  /**
   * The QUOTA_EXCEEDED branch is gated on BOTH `errorCode === 'QUOTA_EXCEEDED'`
   * AND `when` (a successfully formatted reset time) — `&&`, not `||`. These
   * two cases each flip exactly one side of that condition; together they
   * distinguish `&&` from `||` and rule out a mutant that collapses the
   * left-hand equality check to `true`.
   */
  it('QUOTA_EXCEEDED with a resolvable reset time: names the reset time', () => {
    renderPanel({
      status: 'FAILED',
      errorCode: 'QUOTA_EXCEEDED',
      quotaResetsAt: '2026-09-24T14:05:00.000Z',
    })
    const panel = screen.getByTestId('resume-failed')
    expect(panel).toHaveTextContent('Ліміт оновиться')
    // Not the plain fallback hint — the time-aware sentence replaces it.
    expect(panel).not.toHaveTextContent(
      'Добовий ліміт автоматичного розпізнавання вичерпано. Заповніть резюме вручну — форма нижче працює.',
    )
  })

  it('QUOTA_EXCEEDED with an unparseable reset time: falls back to the plain hint, not "Ліміт оновиться"', () => {
    renderPanel({
      status: 'FAILED',
      errorCode: 'QUOTA_EXCEEDED',
      quotaResetsAt: 'not-a-date',
    })
    const panel = screen.getByTestId('resume-failed')
    expect(panel).toHaveTextContent(
      'Добовий ліміт автоматичного розпізнавання вичерпано. Заповніть резюме вручну — форма нижче працює.',
    )
    expect(panel).not.toHaveTextContent('Ліміт оновиться')
  })

  it('a resolvable reset time with a DIFFERENT failure code does not borrow the quota copy', () => {
    // If `&&` mutated to `||`, this case alone would flip to the
    // "Ліміт оновиться" branch even though the failure is UNREADABLE_FILE.
    renderPanel({
      status: 'FAILED',
      errorCode: 'UNREADABLE_FILE',
      quotaResetsAt: '2026-09-24T14:05:00.000Z',
    })
    const panel = screen.getByTestId('resume-failed')
    expect(panel).toHaveTextContent(
      'Файл не вдалося прочитати. Завантажте інший PDF/DOCX або вставте текст.',
    )
    expect(panel).not.toHaveTextContent('Ліміт оновиться')
  })
})
