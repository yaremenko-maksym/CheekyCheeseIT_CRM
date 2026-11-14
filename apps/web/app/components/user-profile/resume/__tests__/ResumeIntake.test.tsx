/**
 * `ResumeIntake` — the upload/paste entry point, in both its `'empty'` and
 * `'compact'` (replace-source) renderings. No test file existed for this
 * component before this round.
 */
import { fireEvent, render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ComponentProps, ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeIntake } from '../ResumeIntake'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(() => loadCatalog('uk'))

function renderIntake(overrides: Partial<ComponentProps<typeof ResumeIntake>> = {}) {
  const onUploadFile = vi.fn()
  const onSubmitText = vi.fn()
  render(
    <ResumeIntake
      onUploadFile={onUploadFile}
      onSubmitText={onSubmitText}
      isBusy={false}
      {...overrides}
    />,
  )
  return { onUploadFile, onSubmitText }
}

describe('the upload button reads the state it is actually in', () => {
  it('"empty" variant (also the default, no prop passed): upload only prefills, not "Замінити файл"', () => {
    renderIntake()
    expect(screen.getByTestId('resume-upload-button')).toHaveTextContent(
      'Завантажити, щоб заповнити',
    )
    expect(screen.getByTestId('resume-upload-button')).not.toHaveTextContent('Замінити файл')
  })

  it('"compact" variant (replacing an existing source): "Замінити файл", not "Завантажити файл"', () => {
    renderIntake({ variant: 'compact' })
    expect(screen.getByTestId('resume-upload-button')).toHaveTextContent('Замінити файл')
    expect(screen.getByTestId('resume-upload-button')).not.toHaveTextContent('Завантажити файл')
  })
})

describe('the empty state offers two choices (design §5.2)', () => {
  it('"Заповнити вручну" opens the empty facts form; the note says upload only prefills', () => {
    const onFillManually = vi.fn()
    renderIntake({ onFillManually })
    fireEvent.click(screen.getByRole('button', { name: 'Заповнити вручну' }))
    expect(onFillManually).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText(
        'Завантаження лише заповнює поля. Статус «Перевірено» резюме отримає після перевірки й підтвердження HR.',
      ),
    ).toBeInTheDocument()
  })

  it('F-10: empty variant renders solid card, tiles with bold titles; the upload label wraps inside its tile', () => {
    renderIntake({ onFillManually: vi.fn() })
    const intake = screen.getByTestId('resume-intake')
    expect(intake).not.toHaveClass('border-dashed')
    expect(screen.getAllByText('Заповнити вручну')).toHaveLength(2)
    expect(screen.getAllByText('Завантажити, щоб заповнити')).toHaveLength(2)
    // FF2-1: the long upload label wraps at 768 / 320 instead of painting past the tile; 44 px min target.
    expect(screen.getByTestId('resume-upload-button')).toHaveClass('whitespace-normal', 'min-h-11')
    expect(screen.getByTestId('resume-upload-button')).not.toHaveClass('whitespace-nowrap')
    expect(screen.getByTestId('resume-fill-manually')).toHaveClass('whitespace-nowrap')
  })

  it('the compact variant has no "fill by hand" tile', () => {
    renderIntake({ variant: 'compact', onFillManually: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Заповнити вручну' })).toBeNull()
  })
})

describe('accessible names on the hidden file input and the paste textarea', () => {
  it('the file input carries the exact aria-label and tabIndex={-1}', () => {
    renderIntake()
    const input = screen.getByTestId('resume-file-input')
    expect(input).toHaveAttribute('aria-label', 'Файл резюме')
    expect(input).toHaveAttribute('tabIndex', '-1')
  })

  it('opening the paste box shows the exact placeholder and aria-label', () => {
    renderIntake()
    fireEvent.click(screen.getByTestId('resume-paste-toggle'))
    const textarea = screen.getByTestId('resume-text-input')
    expect(textarea).toHaveAttribute('placeholder', 'Вставте сюди текст резюме цілком')
    expect(textarea).toHaveAttribute('aria-label', 'Текст резюме')
  })
})
