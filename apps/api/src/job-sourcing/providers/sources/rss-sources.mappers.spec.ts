import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import type { FeedEntry } from '../../feed/read-feed'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { collectFeedPages, type RssSourceSpec } from '../rss.provider'
import {
  BERLIN_IT_CATEGORY,
  berlinStartupJobsProvider,
  berlinStartupJobsSpec,
  parseBerlinTitle,
} from './berlinstartupjobs.provider'
import {
  helloworldProvider,
  helloworldSpec,
  isItTitle,
  parseHelloworldCompany,
} from './helloworld.provider'
import { larajobsProvider, larajobsSpec } from './larajobs.provider'
import { parsePythonTitle, pythonOrgProvider, pythonOrgSpec } from './pythonorg.provider'
import { parseSolidCompany, solidJobsProvider, solidJobsSpec } from './solidjobs.provider'

/**
 * Behaviour of each RSS source's mapping, through the public `mapEntry` and the exported parsers. The reader
 * trims every text field, so padded input reaches a mapper only through a direct call: these tests make it.
 * The window and config tests run the real collect path with an empty channel.
 */

const NOW = new Date('2026-11-24T20:00:00Z')
const EMPTY_RSS = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>x</title></channel></rss>`
const DATE = {
  raw: 'Tue, 24 Nov 2026 18:00:00 +0100',
  contract: 'RFC_2822',
  semantics: 'PUBLISHED',
} as const

function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    guid: 'g-1',
    link: 'https://example.test/job/1',
    title: null,
    summary: null,
    content: null,
    authors: [],
    categories: [],
    dates: [],
    extensions: {},
    ...over,
  }
}

async function windowOf<C>(spec: RssSourceSpec<C>, config: C): Promise<unknown> {
  const f = fakeCollectionContext({ responses: [{ bodyText: EMPTY_RSS }], now: NOW })
  return (await collectFeedPages(spec, config, f.ctx)).scope.window
}

describe('parseBerlinTitle - the company after " // "', () => {
  it.each([
    ['a plain title', 'Senior Engineer // Acme', 'Senior Engineer', 'Acme'],
    ['padded whole and both sides', '  Senior Engineer  //  Acme  ', 'Senior Engineer', 'Acme'],
    ['no separator: whole title, no employer', 'Senior Engineer', 'Senior Engineer', null],
    ['padded with no separator', '   Senior Engineer   ', 'Senior Engineer', null],
    ['empty input', '', '', null],
  ] as const)('%s', (_label, raw, title, companyName) => {
    expect(parseBerlinTitle(raw)).toEqual({ title, companyName })
  })
})

describe('berlinstartupjobs mapEntry', () => {
  const config = () =>
    berlinStartupJobsProvider.parseConfig({ namespace: 'berlinstartupjobs', configVersion: 1 })

  it('maps a padded title and its company, and names the namespace from config', () => {
    const mapped = berlinStartupJobsSpec.mapEntry(entry({ title: '  Dev // Acme  ' }), config())
    expect(mapped).toMatchObject({
      namespace: 'berlinstartupjobs',
      url: 'https://example.test/job/1',
      title: 'Dev',
      companyName: 'Acme',
    })
  })

  it('maps an absent title to an empty title and no employer', () => {
    const mapped = berlinStartupJobsSpec.mapEntry(entry({ title: null }), config())
    expect(mapped.title).toBe('')
    expect(mapped.companyName).toBeNull()
  })

  it('prefers the full content over the summary for the description', () => {
    const mapped = berlinStartupJobsSpec.mapEntry(
      entry({ content: '<p>Full</p>', summary: 'Short' }),
      config(),
    )
    expect(mapped.description).toBe('<p>Full</p>')
  })

  it('falls back to the summary when there is no content', () => {
    const mapped = berlinStartupJobsSpec.mapEntry(entry({ summary: 'Short' }), config())
    expect(mapped.description).toBe('Short')
  })

  it('has no description when there is neither content nor summary', () => {
    const mapped = berlinStartupJobsSpec.mapEntry(entry(), config())
    expect(mapped.description).toBeNull()
  })

  it('declares the description as HTML', () => {
    expect(berlinStartupJobsSpec.mapEntry(entry(), config()).descriptionKind).toBe('html')
  })

  it('drops the IT label from the tags and keeps the rest', () => {
    const mapped = berlinStartupJobsSpec.mapEntry(
      entry({ categories: [BERLIN_IT_CATEGORY, 'Remote', 'Berlin'] }),
      config(),
    )
    expect(mapped.tags).toEqual(['Remote', 'Berlin'])
  })

  it('carries the dates through unchanged', () => {
    const mapped = berlinStartupJobsSpec.mapEntry(entry({ dates: [DATE] }), config())
    expect(mapped.dates).toEqual([DATE])
  })

  it('uses the 24-hour window the feed is declared with', async () => {
    expect(await windowOf(berlinStartupJobsSpec, config())).toEqual({
      from: new Date('2026-11-23T20:00:00Z'),
      to: NOW,
    })
  })
})

describe('parsePythonTitle - the company after the last ", "', () => {
  it.each([
    ['a plain pair', 'Backend Engineer, Acme', 'Backend Engineer', 'Acme'],
    ['padded title and company', '  Backend Engineer ,   Acme  ', 'Backend Engineer', 'Acme'],
    ['no comma: whole title, no employer', 'Backend Engineer', 'Backend Engineer', null],
    ['empty input', '', '', null],
    ['an empty title before the comma: whole string, no employer', ', Acme', ', Acme', null],
    [
      'a legal suffix with dots joins the company',
      'Data Engineer, Acme, Inc.',
      'Data Engineer',
      'Acme, Inc.',
    ],
    ['a legal suffix without dots joins the company', 'Dev, Acme, Co', 'Dev', 'Acme, Co'],
    ['a legal suffix matches regardless of case', 'Dev, Acme, ltd', 'Dev', 'Acme, ltd'],
    [
      'a bare legal suffix with no company before it names no employer',
      'Acme, Inc.',
      'Acme, Inc.',
      null,
    ],
    [
      'a legal suffix joins when the title has a comma',
      'Platform Engineer, Acme, LLC',
      'Platform Engineer',
      'Acme, LLC',
    ],
    [
      'a company word that only contains a suffix is not a suffix',
      'Platform, Engineer, Acme Corp',
      'Platform, Engineer',
      'Acme Corp',
    ],
    [
      'a company word that starts with a suffix is not a suffix',
      'Platform, Dev, Incredible Labs',
      'Platform, Dev',
      'Incredible Labs',
    ],
    ['padded bare title with no comma', '   Engineer   ', 'Engineer', null],
    ['padded company before a legal suffix', 'Dev,  Acme , Inc', 'Dev', 'Acme, Inc'],
    ['padded title before a legal suffix', 'Dev ,  Acme, Inc', 'Dev', 'Acme, Inc'],
    ['a legal suffix "Inc" without dots joins the company', 'Dev, Acme, Inc', 'Dev', 'Acme, Inc'],
    ['a legal suffix "Corp" joins the company', 'Dev, Acme, Corp', 'Dev', 'Acme, Corp'],
    ['a legal suffix "B.V" joins the company', 'Dev, Acme, B.V', 'Dev', 'Acme, B.V'],
  ] as const)('%s', (_label, raw, title, companyName) => {
    expect(parsePythonTitle(raw)).toEqual({ title, companyName })
  })
})

describe('pythonorg mapEntry', () => {
  const config = () => pythonOrgProvider.parseConfig({ namespace: 'pythonorg', configVersion: 1 })

  it('maps a padded title to its trimmed title and company', () => {
    const mapped = pythonOrgSpec.mapEntry(
      entry({ title: '  Backend Engineer ,  Acme  ' }),
      config(),
    )
    expect(mapped).toMatchObject({
      namespace: 'pythonorg',
      title: 'Backend Engineer',
      companyName: 'Acme',
      url: 'https://example.test/job/1',
    })
  })

  it('maps an absent title to an empty title and no employer', () => {
    const mapped = pythonOrgSpec.mapEntry(entry({ title: null }), config())
    expect(mapped.title).toBe('')
    expect(mapped.companyName).toBeNull()
  })

  it('prefers the full content over the summary and declares HTML', () => {
    const mapped = pythonOrgSpec.mapEntry(
      entry({ content: '<p>Full</p>', summary: 'Short' }),
      config(),
    )
    expect(mapped.description).toBe('<p>Full</p>')
    expect(mapped.descriptionKind).toBe('html')
  })

  it('falls back to the summary, and to null without either', () => {
    expect(pythonOrgSpec.mapEntry(entry({ summary: 'Short' }), config()).description).toBe('Short')
    expect(pythonOrgSpec.mapEntry(entry(), config()).description).toBeNull()
  })

  it('copies the categories as tags and the dates unchanged', () => {
    const mapped = pythonOrgSpec.mapEntry(
      entry({ categories: ['Remote'], dates: [DATE] }),
      config(),
    )
    expect(mapped.tags).toEqual(['Remote'])
    expect(mapped.dates).toEqual([DATE])
  })

  it('uses the declared 24-hour window', async () => {
    expect(await windowOf(pythonOrgSpec, config())).toEqual({
      from: new Date('2026-11-23T20:00:00Z'),
      to: NOW,
    })
  })
})

describe('helloworld: the employer and the IT filter', () => {
  it.each([
    ['the usual " - " separator', 'Supabase - Remote | Full-time', 'Supabase'],
    ['padded before the separator', 'Supabase  - Remote', 'Supabase'],
    ['a trailing " -" with an empty location', 'Supabase -', 'Supabase'],
    ['a hyphen inside a word is not a separator', 'Acme-Labs - Remote', 'Acme-Labs'],
    ['no separator: no employer', 'Remote only', null],
    ['an empty company before the separator: no employer', ' - Remote', null],
    ['an absent description: no employer', null, null],
  ] as const)('%s', (_label, description, expected) => {
    expect(parseHelloworldCompany(description)).toBe(expected)
  })

  it.each([
    ['a DevOps title is IT', 'DevOps Engineer', true],
    ['a data title is IT', 'Data Engineer', true],
    ['a QA title is IT', 'SDET', true],
    ['a title the classifier cannot place is kept', 'Chief Vibes Officer', true],
    ['an absent title is kept', null, true],
    ['a design title is dropped', 'Senior Product Designer', false],
  ] as const)('%s', (_label, title, expected) => {
    expect(isItTitle(title)).toBe(expected)
  })
})

describe('helloworld isItTitle: only the stored prefix is classified', () => {
  const MAX = ORIGINAL_LIMITS.title

  it('drops a non-IT title of exactly the cap', () => {
    // Filler is non-space so trim() keeps it: the title really is MAX characters long.
    expect(isItTitle('Product Designer '.padEnd(MAX, 'x'))).toBe(false)
  })

  it('ignores a DESIGN tail past the cap: an UNKNOWN prefix stays kept', () => {
    // Without truncation the whole string reads DESIGN and is dropped; with the cap it is UNKNOWN and kept.
    expect(isItTitle('Chief Vibes Officer'.padEnd(MAX) + 'Product Designer')).toBe(true)
  })

  // DEVOPS precedes DESIGN in ROLE_FAMILIES, so an IT phrase inside the cap wins over a DESIGN prefix.
  // Boundary pair: 'DevOps' ends exactly at MAX (kept) vs one character later (its last 's' is cut, so
  // the prefix reads 'DevOp' and the DESIGN prefix decides).
  it('reads an IT phrase that ends exactly at the cap (2,000 characters)', () => {
    expect(isItTitle('Product Designer'.padEnd(MAX - 6) + 'DevOps')).toBe(true)
  })

  it('does not read an IT phrase that ends one character past the cap (2,001 characters)', () => {
    expect(isItTitle('Product Designer'.padEnd(MAX - 5) + 'DevOps')).toBe(false)
  })

  it('drops bidi marks before classifying: a bidi-padded prefix is its text', () => {
    // The funnel's canonical title drops bidi marks (`cleanLine`); a raw-slice classifier would read 2,000 marks (UNKNOWN, kept).
    expect(isItTitle('‏'.repeat(MAX) + 'Product Designer')).toBe(false)
  })

  it('classifies the stored prefix: NULs and surrounding whitespace are not counted', () => {
    // The store keeps 'Product Designer'; a raw-slice classifier would read an empty prefix (UNKNOWN, kept).
    expect(isItTitle('\u0000'.repeat(MAX) + 'Product Designer')).toBe(false)
    expect(isItTitle(' '.repeat(MAX) + 'Product Designer')).toBe(false)
  })

  it('keeps an IT prefix at the cap whatever follows it', () => {
    expect(isItTitle('Senior Software Engineer'.padEnd(MAX) + 'Product Designer')).toBe(true)
  })

  it('returns well under 1 s for a 1 MB title and drops a non-IT prefix', () => {
    // Measured on this host (2026-11-25): a 2,000-char non-space title classifies in 12.05 ms cold
    // (first call), under 0.1 ms warm; 40,000-char non-space probes classify in under 30 ms uncapped.
    // This is a time bound only: with the cap removed it still passes, so the cap itself is pinned by
    // the 2,000 / 2,001 boundary specs above, not by this one.
    const huge = 'Senior Product Designer ' + 'x'.repeat(1_000_000)
    const started = performance.now()
    const verdict = isItTitle(huge)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(verdict).toBe(false)
  })

  it('gives a 1 MB title the same verdict as its first 2,000 characters', () => {
    // The DESIGN phrase sits past the cap: capped, the prefix is UNKNOWN and kept; uncapped, it reads DESIGN
    // and is dropped. So this spec goes red with the cap removed (the fixed-length filler alone would not).
    const huge = 'Chief Vibes Officer'.padEnd(MAX) + 'Product Designer ' + 'x'.repeat(1_000_000)
    expect(isItTitle(huge)).toBe(isItTitle(huge.slice(0, MAX)))
    expect(isItTitle(huge)).toBe(true)
  })
})

describe('helloworld mapEntry', () => {
  const config = () => helloworldProvider.parseConfig({ namespace: 'helloworld', configVersion: 1 })

  it('trims a padded title and takes the company from the summary', () => {
    const mapped = helloworldSpec.mapEntry(
      entry({ title: '  Senior Backend Engineer  ', summary: 'Supabase - Remote' }),
      config(),
    )
    expect(mapped).toMatchObject({
      namespace: 'helloworld',
      title: 'Senior Backend Engineer',
      companyName: 'Supabase',
      url: 'https://example.test/job/1',
    })
  })

  it('maps an absent title to an empty title', () => {
    expect(helloworldSpec.mapEntry(entry({ title: null }), config()).title).toBe('')
  })

  it('prefers the content, falls back to the summary, and declares HTML', () => {
    expect(
      helloworldSpec.mapEntry(entry({ content: '<p>Full</p>', summary: 'S' }), config())
        .description,
    ).toBe('<p>Full</p>')
    const fallback = helloworldSpec.mapEntry(entry({ summary: 'Short' }), config())
    expect(fallback.description).toBe('Short')
    expect(fallback.descriptionKind).toBe('html')
  })

  it('copies the categories as tags and the dates unchanged', () => {
    const mapped = helloworldSpec.mapEntry(
      entry({ categories: ['Serbia'], dates: [DATE] }),
      config(),
    )
    expect(mapped.tags).toEqual(['Serbia'])
    expect(mapped.dates).toEqual([DATE])
  })

  it('uses the declared 24-hour window', async () => {
    expect(await windowOf(helloworldSpec, config())).toEqual({
      from: new Date('2026-11-23T20:00:00Z'),
      to: NOW,
    })
  })
})

describe('larajobs mapEntry', () => {
  const config = () => larajobsProvider.parseConfig({ namespace: 'larajobs', configVersion: 1 })
  const COMPANY = '{https://larajobs.com}company'

  it('trims a padded title and takes the namespaced company', () => {
    const mapped = larajobsSpec.mapEntry(
      entry({ title: '  Laravel Developer  ', extensions: { [COMPANY]: ['Acme'] } }),
      config(),
    )
    expect(mapped).toMatchObject({
      namespace: 'larajobs',
      title: 'Laravel Developer',
      companyName: 'Acme',
      url: 'https://example.test/job/1',
    })
  })

  it('maps an absent title to an empty title', () => {
    expect(larajobsSpec.mapEntry(entry({ title: null }), config()).title).toBe('')
  })

  it('has no employer when the company element is absent', () => {
    expect(larajobsSpec.mapEntry(entry({ extensions: {} }), config()).companyName).toBeNull()
  })

  it('prefers the content, falls back to the summary, and declares HTML', () => {
    expect(
      larajobsSpec.mapEntry(entry({ content: '<p>Full</p>', summary: 'S' }), config()).description,
    ).toBe('<p>Full</p>')
    const fallback = larajobsSpec.mapEntry(entry({ summary: 'Short' }), config())
    expect(fallback.description).toBe('Short')
    expect(fallback.descriptionKind).toBe('html')
  })

  it('copies the categories as tags and the dates unchanged', () => {
    const mapped = larajobsSpec.mapEntry(
      entry({ categories: ['Laravel'], dates: [DATE] }),
      config(),
    )
    expect(mapped.tags).toEqual(['Laravel'])
    expect(mapped.dates).toEqual([DATE])
  })

  it('uses the declared 14-day window', async () => {
    expect(await windowOf(larajobsSpec, config())).toEqual({
      from: new Date('2026-11-10T20:00:00Z'),
      to: NOW,
    })
  })
})

describe('parseSolidCompany and the solidjobs mapEntry', () => {
  const config = () => solidJobsProvider.parseConfig({ namespace: 'solidjobs', configVersion: 1 })

  it('trims a padded company before the separator', () => {
    expect(parseSolidCompany('  Verita HR  • Centrum, Kraków')).toBe('Verita HR')
  })

  it('maps a padded title, the company from the summary, and the content as description', () => {
    const mapped = solidJobsSpec.mapEntry(
      entry({ title: '  Fullstack Engineer  ', summary: 'Acme • Kraków', content: '<p>Full</p>' }),
      config(),
    )
    expect(mapped).toMatchObject({
      namespace: 'solidjobs',
      title: 'Fullstack Engineer',
      companyName: 'Acme',
      description: '<p>Full</p>',
      descriptionKind: 'html',
    })
  })

  it('maps an absent title to an empty title and an absent summary to no employer', () => {
    const mapped = solidJobsSpec.mapEntry(entry({ title: null, summary: null }), config())
    expect(mapped.title).toBe('')
    expect(mapped.companyName).toBeNull()
  })

  it('falls back to the summary for the description when there is no content', () => {
    expect(solidJobsSpec.mapEntry(entry({ summary: 'Acme • Kraków' }), config()).description).toBe(
      'Acme • Kraków',
    )
  })

  it('removes the IT label from the tags and keeps the rest', () => {
    const mapped = solidJobsSpec.mapEntry(entry({ categories: ['IT', 'Java', 'Remote'] }), config())
    expect(mapped.tags).toEqual(['Java', 'Remote'])
  })

  it('carries the dates through unchanged', () => {
    expect(solidJobsSpec.mapEntry(entry({ dates: [DATE] }), config()).dates).toEqual([DATE])
  })

  it('uses the declared 24-hour window', async () => {
    expect(await windowOf(solidJobsSpec, config())).toEqual({
      from: new Date('2026-11-23T20:00:00Z'),
      to: NOW,
    })
  })
})
