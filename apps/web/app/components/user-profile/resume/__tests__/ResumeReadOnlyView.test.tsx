/**
 * `ResumeReadOnlyView` — what a viewer without write access sees: each section
 * shows its items or "Не заповнено", optional parts appear only when present,
 * and a link is clickable only when its URL is safe (AC7).
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ResumeReadOnlyView } from '../ResumeReadOnlyView'

beforeEach(() => loadCatalog('uk'))

const view = (content: Partial<ResumeContent>) =>
  render(<ResumeReadOnlyView content={{ ...EMPTY_RESUME_CONTENT, ...content }} />, {
    wrapper: I18nTestProvider,
  })

const section = (id: string) => within(screen.getByTestId(`resume-section-${id}`))
const SECTIONS = [
  ['summary', 'Про себе'],
  ['skills', 'Навички'],
  ['experience', 'Досвід роботи'],
  ['education', 'Освіта'],
  ['languages', 'Мови'],
  ['links', 'Посилання'],
] as const

describe('an empty resume', () => {
  it('shows every section under its title with "Не заповнено" and no list', () => {
    view({ summary: '   \n ' })
    for (const [id, title] of SECTIONS) {
      expect(section(id).getByText(title)).toBeInTheDocument()
      expect(section(id).getByText('Не заповнено')).toBeInTheDocument()
    }
    for (const id of ['summary', 'skills', 'experience', 'education', 'languages', 'links']) {
      expect(screen.queryByTestId(`resume-${id}-view`)).toBeNull()
    }
  })
})

describe('a filled resume', () => {
  it('shows the summary text as written, without the placeholder', () => {
    view({ summary: 'Line one\nLine two' })
    expect(screen.getByTestId('resume-summary-view').textContent).toBe('Line one\nLine two')
    expect(section('summary').queryByText('Не заповнено')).toBeNull()
  })

  it('lists one skill as one chip', () => {
    view({ skills: ['TypeScript'] })
    expect(within(screen.getByTestId('resume-skills-view')).getAllByRole('listitem')).toHaveLength(
      1,
    )
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
    expect(section('skills').queryByText('Не заповнено')).toBeNull()
  })

  it('shows company, period and only the non-blank bullets of an experience row', () => {
    view({
      experience: [
        { role: 'Lead', company: 'Acme', period: '2020 — 2024', bullets: ['Built X', '   '] },
        { role: 'Dev', company: '', period: '', bullets: [] },
      ],
    })
    const first = within(screen.getByTestId('resume-experience-row-0'))
    expect(first.getByText('Lead')).toBeInTheDocument()
    expect(first.getByText('— Acme')).toBeInTheDocument()
    expect(first.getByText('2020 — 2024').tagName).toBe('P')
    expect(within(first.getByRole('list')).getAllByRole('listitem')).toHaveLength(1)
    expect(first.getByText('Built X')).toBeInTheDocument()

    const second = screen.getByTestId('resume-experience-row-1')
    expect(second.textContent).toBe('Dev')
    expect(within(second).queryByRole('list')).toBeNull()
    expect(section('experience').queryByText('Не заповнено')).toBeNull()
  })

  it('shows an education item with and without its optional parts', () => {
    view({
      education: [
        { degree: 'MSc', institution: 'KPI', period: '2015' },
        { degree: 'BSc', institution: '', period: '' },
      ],
    })
    const items = within(screen.getByTestId('resume-education-view')).getAllByRole('listitem')
    expect(items[0]?.textContent).toBe('MSc · KPI2015')
    expect(screen.getByText('2015').tagName).toBe('DIV')
    expect(items[1]?.textContent).toBe('BSc')
    expect(section('education').queryByText('Не заповнено')).toBeNull()
  })

  it('shows a language with and without its level', () => {
    view({
      languages: [
        { name: 'English', level: 'C1' },
        { name: 'Polish', level: '' },
      ],
    })
    const items = within(screen.getByTestId('resume-languages-view')).getAllByRole('listitem')
    expect(items[0]?.textContent).toBe('English — C1')
    expect(items[1]?.textContent).toBe('Polish')
    expect(section('languages').queryByText('Не заповнено')).toBeNull()
  })
})

describe('links (AC7)', () => {
  it('a safe link is clickable, labelled, and opens isolated', () => {
    view({ links: [{ label: 'GitHub', url: 'https://github.com/x' }] })
    const link = screen.getByRole('link', { name: 'GitHub' })
    expect(link).toHaveAttribute('href', 'https://github.com/x')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    expect(section('links').queryByText('Не заповнено')).toBeNull()
  })

  it('a safe link without a label shows its URL as the text', () => {
    view({ links: [{ label: '', url: 'https://example.com' }] })
    expect(screen.getByRole('link', { name: 'https://example.com' })).toBeInTheDocument()
  })

  it('an unsafe link is plain text, never a link', () => {
    view({
      links: [
        { label: 'Bad', url: 'javascript:alert(1)' },
        { label: '', url: 'ftp://x.example' },
      ],
    })
    expect(screen.queryByRole('link')).toBeNull()
    const items = within(screen.getByTestId('resume-links-view')).getAllByRole('listitem')
    expect(items[0]?.textContent).toBe('Bad')
    expect(items[1]?.textContent).toBe('ftp://x.example')
  })
})
