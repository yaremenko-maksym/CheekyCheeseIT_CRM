import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { decodePrefill } from '@/lib/external-prefill'

import { extractVacancy } from '../extract'
import { crmTarget } from '../target'

const DOU_URL = 'https://jobs.dou.ua/companies/epam-systems/vacancies/380639/'

describe('crmTarget', () => {
  it('opens the queue with a hash the CRM decodes back to the extracted vacancy', () => {
    const html = readFileSync(resolve(__dirname, '../__fixtures__/dou-vacancy.html'), 'utf8')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const target = new URL(crmTarget('https://app.example.com', doc, DOU_URL, ''))
    expect(target.origin + target.pathname).toBe('https://app.example.com/job-queue')
    expect(decodePrefill(target.hash)).toEqual(extractVacancy(doc, DOU_URL, ''))
  })
})
