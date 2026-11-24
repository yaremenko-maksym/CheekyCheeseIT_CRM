import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { collectFeedPages } from '../rss.provider'
import { parsePythonTitle, pythonOrgProvider, pythonOrgSpec } from './pythonorg.provider'

/**
 * Python.org Jobs, through the base's public collect path on a trimmed capture of 2026-11-24
 * (`__fixtures__/pythonorg/jobs.trimmed.xml`, provenance beside it). Expected values are written by hand
 * from that fixture; the title cases are real titles from the capture and the synthetic ones say so.
 */

const FIXTURE = join(__dirname, '__fixtures__', 'pythonorg', 'jobs.trimmed.xml')
const NOW = new Date('2026-11-24T20:00:00Z')

const config = () => pythonOrgProvider.parseConfig({ namespace: 'pythonorg', configVersion: 1 })

async function collect(bodyText: string) {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  return collectFeedPages(pythonOrgSpec, config(), f.ctx)
}

describe('parsePythonTitle - "Position, Company"', () => {
  it.each([
    [
      'a real title with a company after the last comma',
      'Senior Python Developer, Eliassen Group',
      { title: 'Senior Python Developer', companyName: 'Eliassen Group' },
    ],
    [
      'a real title whose position itself contains a comma',
      'Research Engineer, Multilingual Semantic Search, TGScope',
      { title: 'Research Engineer, Multilingual Semantic Search', companyName: 'TGScope' },
    ],
    [
      'a synthetic legal suffix rejoined with the company',
      'Senior Python Developer, Acme, Inc.',
      { title: 'Senior Python Developer', companyName: 'Acme, Inc.' },
    ],
    [
      'a synthetic title with no comma names no employer',
      'Platform Engineer',
      { title: 'Platform Engineer', companyName: null },
    ],
  ])('%s', (_label, raw, expected) => {
    expect(parsePythonTitle(raw)).toEqual(expected)
  })
})

describe('PYTHONORG_RSS collect on the trimmed capture', () => {
  it('maps title, employer and URL of each posting, in feed order', async () => {
    const batch = await collect(readFileSync(FIXTURE, 'utf8'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(
      batch.observations.map((o) => [
        o.identity.nativeId,
        o.normalized.title,
        o.normalized.companyName,
      ]),
    ).toEqual([
      [
        'https://www.python.org/jobs/8219/',
        'Senior Image Analysis Software Engineer',
        'Nick Gilbert Neurofibromatosis Research Institute',
      ],
      [
        'https://www.python.org/jobs/8212/',
        'Research Scientist, Coordinated Networks & Information Integrity',
        'TGScope',
      ],
      ['https://www.python.org/jobs/8206/', 'Senior Python Developer', 'Eliassen Group'],
    ])
  })

  it('keeps the posting URL as the link of the entry', () => {
    const [entry] = [
      pythonOrgSpec.mapEntry(
        {
          guid: 'https://www.python.org/jobs/8206/',
          link: 'https://www.python.org/jobs/8206/',
          title: 'Senior Python Developer, Eliassen Group',
          summary: null,
          content: null,
          authors: [],
          categories: [],
          dates: [],
        },
        config(),
      ),
    ]
    expect(entry?.url).toBe('https://www.python.org/jobs/8206/')
  })
})
