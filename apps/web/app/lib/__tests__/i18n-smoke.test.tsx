import { render, screen } from '@testing-library/react'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { describe, expect, it } from 'vitest'

describe('lingui macros are transformed in vitest', () => {
  it('renders the source-locale text when uk is active', () => {
    i18n.load('uk', {})
    i18n.activate('uk')
    render(
      <I18nProvider i18n={i18n}>
        <p data-testid="smoke">
          <Trans>Зберегти</Trans>
        </p>
      </I18nProvider>,
    )
    expect(screen.getByTestId('smoke')).toHaveTextContent('Зберегти')
  })
})
