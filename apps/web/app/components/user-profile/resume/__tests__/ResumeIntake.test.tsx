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
  it('"empty" variant (also the default, no prop passed): "Завантажити файл", not "Замінити файл"', () => {
    renderIntake()
    expect(screen.getByTestId('resume-upload-button')).toHaveTextContent('Завантажити файл')
    expect(screen.getByTestId('resume-upload-button')).not.toHaveTextContent('Замінити файл')
  })

  it('"compact" variant (replacing an existing source): "Замінити файл", not "Завантажити файл"', () => {
    renderIntake({ variant: 'compact' })
    expect(screen.getByTestId('resume-upload-button')).toHaveTextContent('Замінити файл')
    expect(screen.getByTestId('resume-upload-button')).not.toHaveTextContent('Завантажити файл')
  })
})

describe('accessible names on the hidden file input and the paste textarea', () => {
  it('the file input carries the exact aria-label', () => {
    renderIntake()
    expect(screen.getByTestId('resume-file-input')).toHaveAttribute('aria-label', 'Файл резюме')
  })

  it('opening the paste box shows the exact placeholder and aria-label', () => {
    renderIntake()
    fireEvent.click(screen.getByTestId('resume-paste-toggle'))
    const textarea = screen.getByTestId('resume-text-input')
    expect(textarea).toHaveAttribute('placeholder', 'Вставте сюди текст резюме цілком')
    expect(textarea).toHaveAttribute('aria-label', 'Текст резюме')
  })
})
