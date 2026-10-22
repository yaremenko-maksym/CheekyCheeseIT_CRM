import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JobExclusionDto } from '@crm/shared'
import { canonicalStackKeywords, stackMatchScore, textMentionsStackKeyword } from '@crm/shared'
import { DouRssProvider, parseDouTitle } from './dou.provider'
import { deriveProjectExclusions, findMatchingExclusion } from './filtering'
import { MAX_DESCRIPTION_CHARS } from './html-to-markdown'
import { canonicalizePostingUrl, computePostingFingerprint } from './job-source.provider'
import { buildNormalizedPosting } from './normalize/build-posting'
import { parseRssItems, type RawRssItem } from './rss'

/**
 * GOLDEN CHARACTERIZATION of the DOU sourcing path (r5 compatibility fixture gate).
 *
 * These specs pin what the code does TODAY on a fixed, hand-crafted DOU RSS payload
 * (`__fixtures__/dou-feed.golden.xml`, expected output in `dou-feed.golden.expected.json`).
 * They are a regression anchor for the upcoming store/funnel changes (r5 phases 1-4): if
 * one of them goes red, DOU behaviour changed — decide on purpose, then re-capture.
 * They assert CURRENT behaviour, not what is ideal (e.g. the missing blank line after a
 * list in `descriptionMd` is pinned as-is).
 *
 * Pure transforms only (no DB, no network) so the mutation gate — which runs the unit
 * suite — can see them. The DB-touching half lives in `dou-golden.integration.spec.ts`.
 */

const FIXTURES = join(__dirname, '__fixtures__')
const xml = readFileSync(join(FIXTURES, 'dou-feed.golden.xml'), 'utf8')

interface GoldenPosting {
  sourceType: string
  externalId: string
  url: string
  title: string
  companyName: string
  companyNameNormalized: string
  location: string | null
  descriptionMd: string
  publishedAt: string | null
  fingerprint: string
}
const expected = JSON.parse(
  readFileSync(join(FIXTURES, 'dou-feed.golden.expected.json'), 'utf8'),
) as {
  rawItems: RawRssItem[]
  postings: GoldenPosting[]
}

const provider = new DouRssProvider()
const rawItems = parseRssItems(xml)
const postings = provider.normalize(rawItems)

/** Postings with `publishedAt` as ISO so they compare with the JSON golden. */
const serialized = postings.map((p) => ({
  ...p,
  publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
}))

describe('DOU golden — parseRssItems on the fixture feed', () => {
  it('reads all 13 <item>s and never the channel header', () => {
    expect(rawItems).toHaveLength(13)
    expect(rawItems.map((i) => i.title)).not.toContain(
      'Channel title that must NOT be read as an item',
    )
  })

  it('returns exactly the golden raw items (entities decoded, CDATA unwrapped, missing fields empty)', () => {
    expect(rawItems).toEqual(expected.rawItems)
  })

  it('pins the three representative extraction edges explicitly', () => {
    // entity-escaped HTML description is decoded to real HTML (the next stage converts it)
    expect(rawItems[0]?.description.startsWith('<p>We are <strong>hiring</strong>')).toBe(true)
    // `&amp;amp;` is decoded exactly once: still `&amp;` for the HTML stage
    expect(rawItems[0]?.description).toContain('GraphQL &amp; REST')
    // CDATA title: content is literal, `&` is not re-decoded, absent tags are ''
    expect(rawItems[9]).toEqual({
      title: 'Senior Java Developer в R&D Labs, Одеса',
      link: '',
      guid: 'https://jobs.dou.ua/companies/rnd-labs/vacancies/360008/?1786092523',
      pubDate: '',
      description: '',
    })
  })
})

describe('DOU golden — DouRssProvider.normalize on the fixture feed', () => {
  it('produces exactly the golden postings, in feed order', () => {
    expect(serialized).toEqual(expected.postings)
  })

  it('skips the four malformed items and keeps the other nine', () => {
    expect(postings).toHaveLength(9)
    const urls = postings.map((p) => p.url)
    // javascript: link, http-only link, empty title, no company anywhere -> dropped
    expect(urls.some((u) => u.includes('hacker') || u.includes('Hacker'))).toBe(false)
    expect(urls).not.toContain('https://jobs.dou.ua/companies/plainhttp/vacancies/360005')
    expect(urls).not.toContain('https://jobs.dou.ua/companies/notitle/vacancies/360006')
    expect(urls).not.toContain('https://jobs.dou.ua/vacancies/360007')
  })

  it('pins the title grammar edge cases', () => {
    const byUrlTail = (tail: string) => postings.find((p) => p.url.endsWith(tail))
    // legal-form tail re-attached to the company, not shown as a location
    expect(byUrlTail('/360001')).toMatchObject({
      title: 'Middle Node.js Developer',
      companyName: 'Wetelo, Inc.',
      companyNameNormalized: 'wetelo',
      location: 'Луцьк, віддалено',
    })
    // salary segment stays verbatim inside the location line
    expect(byUrlTail('/360002')).toMatchObject({
      companyName: 'Advanced Software Development (ASD Team)',
      location: '$1100–1300, віддалено',
    })
    // split on the LAST ' в '
    expect(byUrlTail('/360003')).toMatchObject({ title: 'Продажі в IT', companyName: 'Ciklum' })
    // no ' в ' -> company from the URL slug, location null
    expect(byUrlTail('/360004')).toMatchObject({
      title: 'Plain title with no separator',
      companyName: 'soft serve',
      location: null,
    })
    // <link> missing -> <guid> used; unparseable/absent pubDate -> null
    expect(byUrlTail('/360008')).toMatchObject({ publishedAt: null, descriptionMd: '' })
    expect(byUrlTail('/360009')?.publishedAt).toBeNull()
  })

  it('pins publishedAt as the absolute instant of the RFC-822 pubDate (+0300)', () => {
    expect(postings[0]?.publishedAt?.toISOString()).toBe('2026-08-07T08:48:38.000Z')
  })

  it('pins description markdown: structure kept, script/handler/img gone', () => {
    const md = (tail: string) => postings.find((p) => p.url.endsWith(tail))?.descriptionMd ?? ''
    expect(md('/356562')).toBe(
      'We are **hiring** a Senior Frontend Engineer.\n\n- React 18, TypeScript\n- GraphQL & REST\n- CI/CD, Docker\nApply: [our page](<https://epam.example/apply>)',
    )
    expect(md('/360010')).toBe('Terraform, AWS, Kubernetes')
  })

  it('parseDouTitle: exact splits for the fixture titles', () => {
    expect(
      parseDouTitle('Senior Frontend Engineer (React, TypeScript) в EPAM, Київ, віддалено'),
    ).toEqual({
      title: 'Senior Frontend Engineer (React, TypeScript)',
      companyName: 'EPAM',
      location: 'Київ, віддалено',
    })
    expect(parseDouTitle('Mystery Role')).toEqual({
      title: 'Mystery Role',
      companyName: '',
      location: null,
    })
  })
})

describe('DOU golden — dedupe identity (canonical URL + fingerprint)', () => {
  const EPAM_CANONICAL = 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562'

  it('locks the exact fingerprint of every kept posting', () => {
    expect(postings.map((p) => [p.url, p.fingerprint])).toEqual([
      [EPAM_CANONICAL, '2e820b0e9a6438200cf757c323b4788203855c8225a635a940c05dfceffd5046'],
      [
        'https://jobs.dou.ua/companies/wetelo/vacancies/360001',
        'd17054a76661df129bdd0ceccb44eb01f7b20e8b6c73b346c1b22f94d55aabb1',
      ],
      [
        'https://jobs.dou.ua/companies/asd-team/vacancies/360002',
        'a353b4e872ab75cd45984e0c8a2c19fec603798a0949796ab1db1c21182c8cc1',
      ],
      [
        'https://jobs.dou.ua/companies/ciklum/vacancies/360003',
        '95b0b2a40a3834ad78046d4386427b4097dcf735e0a182f1b5a7fe771956da5d',
      ],
      [
        'https://jobs.dou.ua/companies/soft-serve/vacancies/360004',
        '68bfb873f8443cce664e081e22bbfd14123c54522f5f422bd68b3f4bdd85ee9b',
      ],
      [
        'https://jobs.dou.ua/companies/rnd-labs/vacancies/360008',
        '6dde141c6d50a3a12e99fa666a1ea8122ba26b0acddf9b6bf43dfd7c0252f1aa',
      ],
      [
        'https://jobs.dou.ua/companies/romashka/vacancies/360009',
        'f5b7f83a1e4017701ed697e7c3683ff86f68417ea6eaac628940939bf7097fe4',
      ],
      [
        'https://jobs.dou.ua/companies/ciklum/vacancies/360010',
        'fe28c0f28ffda7169e0c10c60fa243f24173f31049346851ce65880ff3b4b92c',
      ],
      [EPAM_CANONICAL, '2e820b0e9a6438200cf757c323b4788203855c8225a635a940c05dfceffd5046'],
    ])
  })

  it('the re-fetched twin (new guid timestamp, other utm, upper-case host, fragment) is the SAME identity', () => {
    expect(postings[0]?.fingerprint).toBe(postings[8]?.fingerprint)
    expect(postings[0]?.externalId).toBe(postings[8]?.externalId)
  })

  it('canonicalizePostingUrl: exact outputs for fixture link shapes', () => {
    expect(
      canonicalizePostingUrl(
        'https://jobs.dou.ua/companies/epam-systems/vacancies/356562/?utm_source=jobsrss',
      ),
    ).toBe(EPAM_CANONICAL)
    expect(
      canonicalizePostingUrl(
        'https://JOBS.dou.ua/companies/epam-systems/vacancies/356562/?utm_source=other&utm_medium=x#top',
      ),
    ).toBe(EPAM_CANONICAL)
    expect(
      canonicalizePostingUrl('http://jobs.dou.ua/companies/plainhttp/vacancies/360005/'),
    ).toBeNull()
    expect(canonicalizePostingUrl('javascript:alert(1)')).toBeNull()
  })

  it('fingerprint = sha256("DOU_RSS|<canonical url>") — a different source type never collides', () => {
    expect(computePostingFingerprint('DOU_RSS', EPAM_CANONICAL)).toBe(
      '2e820b0e9a6438200cf757c323b4788203855c8225a635a940c05dfceffd5046',
    )
    expect(computePostingFingerprint('DOU_RSS', EPAM_CANONICAL)).not.toBe(
      computePostingFingerprint('HN_WHO_IS_HIRING', EPAM_CANONICAL),
    )
  })
})

describe('DOU golden — shared buildNormalizedPosting over the same items', () => {
  // NOTE (pinned divergence): DouRssProvider.normalize does NOT call buildNormalizedPosting;
  // it has its own normalizer. The shared one has no URL-slug company fallback, so it drops
  // item 5 (no ' в ' in the title) where the DOU provider keeps it.
  const built = rawItems.map((item) => {
    const parsed = parseDouTitle(item.title)
    return buildNormalizedPosting('DOU_RSS', {
      url: item.link || item.guid,
      title: parsed.title,
      companyName: parsed.companyName,
      location: parsed.location,
      description: item.description,
      publishedAt: item.pubDate,
    })
  })

  it('agrees field-for-field with the DOU provider wherever both keep the item', () => {
    const agreed = built.filter((p) => p !== null)
    expect(agreed).toHaveLength(8)
    expect(
      agreed.map((p) => ({ ...p, publishedAt: p.publishedAt?.toISOString() ?? null })),
    ).toEqual(
      expected.postings
        .filter((p) => !p.url.endsWith('/360004'))
        .map((p) => ({
          ...p,
          remote: null,
          employmentType: null,
          seniorityHint: null,
          tags: [],
        })),
    )
  })

  it('skips malformed items and the slug-only company item (indexes 4-8 of the feed)', () => {
    expect(built.slice(4, 9)).toEqual([null, null, null, null, null])
  })
})

describe('DOU golden — truncation and NUL stripping', () => {
  const raw = (over: Partial<RawRssItem>): RawRssItem => ({
    title: 'Dev в Acme, Київ',
    link: 'https://jobs.dou.ua/companies/acme/vacancies/1/',
    guid: '',
    pubDate: '',
    description: '<p>x</p>',
    ...over,
  })

  it('strips NUL from title, company, location and description', () => {
    const [p] = provider.normalize([
      raw({ title: 'De\u0000v в Ac\u0000me, Ки\u0000їв', description: '<p>a\u0000b</p>' }),
    ])
    expect(p).toMatchObject({
      title: 'Dev',
      companyName: 'Acme',
      location: 'Київ',
      descriptionMd: 'ab',
    })
  })

  it('caps title at 500, company at 255, location at 500 chars', () => {
    const [p] = provider.normalize([
      raw({ title: `${'T'.repeat(600)} в ${'C'.repeat(300)}, ${'L'.repeat(600)}` }),
    ])
    expect(p?.title).toHaveLength(500)
    expect(p?.companyName).toHaveLength(255)
    expect(p?.location).toHaveLength(500)
    expect(p?.companyNameNormalized.length).toBeLessThanOrEqual(255)
  })

  it('cuts a huge description to MAX_DESCRIPTION_CHARS plus a single ellipsis marker', () => {
    const [p] = provider.normalize([
      raw({ description: `<p>${'word '.repeat(MAX_DESCRIPTION_CHARS)}</p>` }),
    ])
    expect(p?.descriptionMd).toHaveLength(MAX_DESCRIPTION_CHARS + 1)
    expect(p?.descriptionMd.endsWith('…')).toBe(true)
  })

  it('a long, Cyrillic, multi-paragraph description keeps its text through the pipeline', () => {
    const para = '<p>Ми шукаємо інженера з досвідом у розробці та підтримці сервісів.</p>'
    const [p] = provider.normalize([raw({ description: para.repeat(40) })])
    expect(p?.descriptionMd.split('\n\n')).toHaveLength(40)
    expect(p?.descriptionMd.startsWith('Ми шукаємо інженера')).toBe(true)
  })
})

describe('DOU golden — exclusion filtering on fixture postings', () => {
  const SENIOR = '11111111-1111-4111-8111-111111111111'
  const exclusion = (kind: 'COMPANY' | 'KEYWORD', value: string): JobExclusionDto => ({
    id: '22222222-2222-4222-8222-222222222222',
    scope: 'SENIOR',
    seniorId: SENIOR,
    kind,
    value,
    normalizedValue: value.toLowerCase(),
    origin: 'MANUAL',
    sourceLabel: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  const verdict = (exclusions: JobExclusionDto[]) =>
    postings.map((p) => findMatchingExclusion(p, exclusions)?.value ?? null)

  it('a COMPANY exclusion matches by normalized company (legal form / alphabet / spacing)', () => {
    // EPAM x2 (feed item 1 and its twin), Ciklum x2
    expect(verdict([exclusion('COMPANY', 'EPAM Systems Inc.')])).toEqual([
      'EPAM Systems Inc.',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'EPAM Systems Inc.',
    ])
    expect(verdict([exclusion('COMPANY', 'Ciklum')])).toEqual([
      null,
      null,
      null,
      'Ciklum',
      null,
      null,
      null,
      'Ciklum',
      null,
    ])
    // legal form + guillemets stripped on both sides
    expect(verdict([exclusion('COMPANY', 'Ромашка')])[6]).toBe('Ромашка')
    expect(verdict([exclusion('COMPANY', 'Soft-Serve')])[4]).toBe('Soft-Serve')
  })

  it('a KEYWORD exclusion looks at TITLE and COMPANY only — never the description', () => {
    // 'java' appears in the title of the R&D Labs item (index 5) and in the BODY of Soft Serve (4)
    const v = verdict([exclusion('KEYWORD', 'java')])
    expect(v[5]).toBe('java')
    expect(v[4]).toBeNull()
    // word-level, not substring: 'java' does not hit JavaScript
    expect(v.filter((x) => x !== null)).toHaveLength(1)
  })

  it('the board-assigned URL slug also counts as the company (alias)', () => {
    const titleHidesCompany = {
      companyName: 'Ромашка Digital',
      title: 'Dev',
      sourceType: 'DOU_RSS',
      url: 'https://jobs.dou.ua/companies/epam-systems/vacancies/1',
    }
    expect(findMatchingExclusion(titleHidesCompany, [exclusion('COMPANY', 'EPAM')])?.value).toBe(
      'EPAM',
    )
  })

  it('deriveProjectExclusions: one derived COMPANY entry per distinct client, archived included', () => {
    const derived = deriveProjectExclusions(SENIOR, [
      { name: 'Alpha', companyName: 'EPAM Systems Inc.', archivedAt: null },
      { name: 'Beta', companyName: 'epam systems', archivedAt: new Date('2026-01-01') },
      { name: 'Gamma', companyName: 'ТОВ «Ромашка»', archivedAt: new Date('2026-02-01') },
      { name: 'Blank', companyName: '   ', archivedAt: null },
    ])
    expect(derived).toEqual([
      {
        id: null,
        scope: 'SENIOR',
        seniorId: SENIOR,
        kind: 'COMPANY',
        value: 'EPAM Systems Inc.',
        normalizedValue: 'epam systems',
        origin: 'PROJECT',
        sourceLabel: 'Alpha',
        createdAt: null,
      },
      {
        id: null,
        scope: 'SENIOR',
        seniorId: SENIOR,
        kind: 'COMPANY',
        value: 'ТОВ «Ромашка»',
        normalizedValue: 'romashka',
        origin: 'PROJECT',
        sourceLabel: 'Gamma',
        createdAt: null,
      },
    ])
    // and the derived set hides exactly the senior's clients from the fixture feed
    expect(verdict(derived).map((v) => v !== null)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      true,
    ])
  })
})

describe('DOU golden — stackMatchScore of fixture postings against senior stacks', () => {
  const text = (tail: string) => {
    const p = postings.find((x) => x.url.endsWith(tail))
    return { title: p?.title, body: p?.descriptionMd }
  }

  it('canonicalStackKeywords folds spellings and keeps order/distinctness', () => {
    expect(
      canonicalStackKeywords(['React.js', 'react', 'TS', 'Node', 'k8s', 'C#', '.NET']),
    ).toEqual(['react', 'typescript', 'nodejs', 'kubernetes', 'csharp', 'dotnet'])
  })

  it('frontend senior vs the EPAM frontend posting', () => {
    expect(
      stackMatchScore(text('/356562'), ['TypeScript', 'React', 'GraphQL', 'Kubernetes']),
    ).toEqual({ score: 0.75, matched: ['typescript', 'react', 'graphql'], total: 4 })
  })

  it('same stack vs an unrelated posting scores zero', () => {
    expect(
      stackMatchScore(text('/360003'), ['TypeScript', 'React', 'GraphQL', 'Kubernetes']),
    ).toEqual({ score: 0, matched: [], total: 4 })
  })

  it('java is not javascript: a Java senior matches the Java posting, not the JS ones', () => {
    expect(stackMatchScore(text('/360008'), ['Java']).score).toBe(1)
    expect(stackMatchScore(text('/360002'), ['Java']).score).toBe(0)
  })

  it('ambiguous aliases count in the title only; body mentions of body-safe spellings count', () => {
    expect(stackMatchScore(text('/360001'), ['Node.js', 'PostgreSQL', 'Kubernetes', 'Go'])).toEqual(
      { score: 0.75, matched: ['nodejs', 'postgresql', 'kubernetes'], total: 4 },
    )
    expect(textMentionsStackKeyword('react', text('/356562'))).toBe(true)
    expect(textMentionsStackKeyword('react', text('/360010'))).toBe(false)
  })

  it('an empty stack scores 0 with total 0 (caller decides what that means)', () => {
    expect(stackMatchScore(text('/356562'), [])).toEqual({ score: 0, matched: [], total: 0 })
    expect(stackMatchScore(text('/356562'), null)).toEqual({ score: 0, matched: [], total: 0 })
  })
})
