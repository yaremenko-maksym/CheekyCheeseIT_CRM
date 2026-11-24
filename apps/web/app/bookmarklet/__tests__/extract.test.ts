import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractVacancy } from '../extract'
import { DESCRIPTION_MAX } from '../limits'

const fixture = (name: string): Document =>
  new DOMParser().parseFromString(
    readFileSync(resolve(__dirname, '../__fixtures__', name), 'utf8'),
    'text/html',
  )

const DOU_URL = 'https://jobs.dou.ua/companies/epam-systems/vacancies/380639/'
const GH_URL = 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002'

describe('extractVacancy', () => {
  it('reads a DOU vacancy through its site profile', () => {
    const p = extractVacancy(fixture('dou-vacancy.html'), DOU_URL, '')
    expect(p.recognition).toBe('recognized')
    expect(p.title).toBe('Senior Python AI Engineer')
    expect(p.company).toBe('EPAM')
    expect(p.description).toContain('5+ years of backend development in Python')
    // Block structure survives as lines, list items as bullets.
    expect(p.description).toContain('\n- Upper-Intermediate English')
    expect(p.description).not.toContain('Всі вакансії компанії')
    expect(p.url).toBe(DOU_URL)
    expect(p.status).toEqual({
      url: 'found',
      title: 'found',
      company: 'found',
      description: 'found',
    })
    expect(p.pageText).toBeUndefined()
  })

  it('reads a JSON-LD JobPosting from @graph, past a broken script, as inert text', () => {
    const doc = fixture('jsonld-job.html')
    const p = extractVacancy(doc, 'https://careers.example.com/jobs/7', '')
    expect(p.recognition).toBe('recognized')
    expect(p.title).toBe('Staff ML Engineer & Researcher')
    expect(p.company).toBe('Example Labs')
    expect(p.description).toContain('Build ranking models.')
    expect(p.description).toContain('- PyTorch')
    expect(p.description).not.toContain('<')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    expect(p.url).toBe('https://careers.example.com/jobs/7')
    expect(p.status.description).toBe('found')
  })

  it('reads a Greenhouse job and skips a canonical link that is not https', () => {
    const p = extractVacancy(fixture('greenhouse-job.html'), GH_URL, '')
    expect(p.recognition).toBe('recognized')
    expect(p.title).toBe('AI Transformation Owner, CRO')
    expect(p.company).toBe('GitLab')
    expect(p.description).toContain('Lead the AI adoption program')
    expect(p.url).toBe(GH_URL)
  })

  it('reads a public LinkedIn job page by its own selectors, not its page title or host', () => {
    const LI_URL =
      'https://ua.linkedin.com/jobs/view/senior-frontend-engineer-at-clickup-4407908715'
    const p = extractVacancy(fixture('linkedin-job.html'), LI_URL, '')
    expect(p.recognition).toBe('recognized')
    expect(p.title).toBe('Senior Frontend Engineer')
    expect(p.company).toBe('ClickUp')
    expect(p.description).toMatch(/^At ClickUp, we're building/)
    expect(p.description).toContain('- Build features in Angular 2+')
    expect(p.url).toBe(LI_URL)
  })

  it('reports a page that is not a vacancy as not recognized, with only the page text and link', () => {
    const p = extractVacancy(fixture('news-page.html'), 'https://news.example.com/chips', '')
    expect(p.recognition).toBe('none')
    expect(p.title).toBeUndefined()
    expect(p.company).toBeUndefined()
    expect(p.description).toBeUndefined()
    expect(p.status).toEqual({
      url: 'guessed',
      title: 'missing',
      company: 'missing',
      description: 'missing',
    })
    expect(p.pageText).toContain('Demand for data-centre accelerators')
    expect(p.pageText).not.toContain('Most read')
    expect(p.pageText).not.toContain('Markets')
  })

  it('takes a selection of 200+ characters as the description, guessing nothing else', () => {
    const selection = 'Ми шукаємо інженера. '.repeat(12)
    const p = extractVacancy(fixture('news-page.html'), 'https://news.example.com/chips', selection)
    expect(p.recognition).toBe('partial')
    expect(p.description).toBe(selection.trim())
    expect(p.status.description).toBe('found')
    expect(p.status.title).toBe('missing')
    expect(p.status.company).toBe('missing')
    expect(p.title).toBeUndefined()
    expect(p.company).toBeUndefined()
    expect(p.pageText).toContain('Demand for data-centre accelerators')
  })

  it('ignores a selection shorter than 200 characters', () => {
    const p = extractVacancy(fixture('news-page.html'), 'https://news.example.com/chips', 'short')
    expect(p.recognition).toBe('none')
  })

  it('recognizes a generic page whose main text carries vacancy cues, prefilling nothing', () => {
    const doc = new DOMParser().parseFromString(
      `<html><head><title>Backend Developer</title></head><body>
        <main><h1>Backend Developer</h1><p>Вимоги: досвід з Node.js від 3 років.</p></main>
      </body></html>`,
      'text/html',
    )
    const p = extractVacancy(doc, 'https://jobs.acme.io/42', '')
    expect(p.recognition).toBe('partial')
    expect(p.title).toBeUndefined()
    expect(p.company).toBeUndefined()
    expect(p.description).toBeUndefined()
    expect(p.status).toEqual({
      url: 'found',
      title: 'missing',
      company: 'missing',
      description: 'missing',
    })
    expect(p.pageText).toContain('Вимоги: досвід з Node.js від 3 років.')
  })

  it('partly recognizes a signed-in LinkedIn page as generic without prefilling description or host company', () => {
    const doc = new DOMParser().parseFromString(
      `<html>
        <head>
          <title>Front End Developer | Playtech | LinkedIn</title>
        </head>
        <body>
          <main>
            <div>Jobs</div>
            <div>Date posted</div>
            <div>Easy Apply</div>
            <div>
              <h2>About the job</h2>
              <p>Requirements: 5+ years of experience with TypeScript and React.</p>
            </div>
          </main>
        </body>
      </html>`,
      'text/html',
    )
    const p = extractVacancy(doc, 'https://www.linkedin.com/jobs/view/1234567890', '')
    expect(p.recognition).toBe('partial')
    expect(p.pageText).toBeDefined()
    expect(p.pageText).toContain('Requirements')
    expect(p.description).toBeUndefined()
    expect(p.company).toBeUndefined()
    expect(p.status.company).toBe('missing')
    expect(p.status.description).toBe('missing')
    expect(p.title).toBeUndefined()
    expect(p.status.title).toBe('missing')
  })

  it('marks a profile page without a description as partly recognized and sends the page text', () => {
    const doc = fixture('dou-vacancy.html')
    doc.querySelector('.b-typo.vacancy-section')?.remove()
    const p = extractVacancy(doc, DOU_URL, '')
    expect(p.recognition).toBe('partial')
    expect(p.status.description).toBe('missing')
    expect(p.pageText).toContain('Senior Python AI Engineer')
  })

  it('drops a page link that is not https', () => {
    const p = extractVacancy(fixture('news-page.html'), 'http://news.example.com/chips', '')
    expect(p.url).toBeUndefined()
    expect(p.status.url).toBe('missing')
  })

  it('caps the description at the CRM limit', () => {
    const p = extractVacancy(fixture('news-page.html'), 'https://n.example.com/', 'x'.repeat(60000))
    expect(p.description).toHaveLength(DESCRIPTION_MAX)
  })
})
