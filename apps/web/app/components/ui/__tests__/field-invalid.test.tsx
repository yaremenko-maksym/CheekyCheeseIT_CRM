/**
 * F-2 (verified base resume design §7): a field the form marks `aria-invalid` draws a destructive
 * border. jsdom has no CSS, so the check is the variant class the shared fields carry.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from '../input'
import { Select, SelectTrigger, SelectValue } from '../select'
import { Textarea } from '../textarea'

describe('shared fields: aria-invalid draws a destructive border', () => {
  it('Input, Textarea and SelectTrigger carry the aria-invalid border variant', () => {
    render(
      <>
        <Input aria-label="input" aria-invalid />
        <Textarea aria-label="textarea" aria-invalid />
        <Select>
          <SelectTrigger aria-label="select" aria-invalid>
            <SelectValue />
          </SelectTrigger>
        </Select>
      </>,
    )
    for (const name of ['input', 'textarea', 'select']) {
      const field = screen.getByLabelText(name)
      expect(field).toHaveAttribute('aria-invalid', 'true')
      expect(field).toHaveClass('aria-invalid:border-destructive')
    }
  })
})
