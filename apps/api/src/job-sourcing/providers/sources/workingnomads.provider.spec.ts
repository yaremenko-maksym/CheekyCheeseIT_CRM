import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { sourceProvenance } from '../../../test/source-fixtures'
import { markValidated } from '../reporting-provider'
import {
  SourceBlockedError,
  workingNomadsProvider,
  WORKINGNOMADS_SOURCE_STATUS,
} from './workingnomads.provider'

/**
 * Working Nomads is a BLOCKED STUB: no documented permission, so no fetch path and no job fixture.
 * These specs pin the refusal, that nothing reaches a network, and the evidence the verdict rests
 * on (the committed terms page).
 */

const NOW = new Date('2026-10-24T03:00:00Z')
const SEEDED = { categories: ['development'] }

const termsText = () =>
  readFileSync(join(__dirname, '__fixtures__', 'workingnomads', 'terms.html.txt'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')

describe('parseConfig refuses every config with a typed readiness error', () => {
  it.each([
    ['the seeded config', SEEDED],
    ['a config that would otherwise be valid', { configVersion: 1, categories: ['development'] }],
    ['an empty object', {}],
    ['nothing at all', undefined],
  ])('%s', (_label, raw) => {
    let caught: unknown
    try {
      workingNomadsProvider.parseConfig(raw)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SourceBlockedError)
    const error = caught as SourceBlockedError
    expect(error.code).toBe('SOURCE_BLOCKED')
    expect(error.sourceType).toBe('WORKINGNOMADS_API')
    expect(error.permission).toBe('UNCLEAR')
    expect(error.message).toBe(
      'WORKINGNOMADS_API blocked: no documented permission - the terms say nothing either way on automated access',
    )
    expect(error.name).toBe('SourceBlockedError')
  })

  it('declares the provider type', () => {
    expect(workingNomadsProvider.type).toBe('WORKINGNOMADS_API')
  })
})

describe('there is no fetch path', () => {
  it('collectReport refuses even a config that was marked validated, and nothing is fetched or metered', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: '[]' }] })
    const validated = markValidated({ namespace: 'workingnomads', configVersion: 1 })
    await expect(workingNomadsProvider.collectReport(validated, f.ctx)).rejects.toBeInstanceOf(
      SourceBlockedError,
    )
    expect(f.sent).toHaveLength(0)
    expect(f.saved).toHaveLength(0)
  })
})

describe('the recorded evidence', () => {
  it('the status says blocked, UNCLEAR, and the provenance agrees', () => {
    expect(WORKINGNOMADS_SOURCE_STATUS.blocked).toBe(true)
    expect(WORKINGNOMADS_SOURCE_STATUS.permission).toBe('UNCLEAR')
    const p = sourceProvenance('workingnomads', 'terms') as {
      permission: string
      notes: string
      trimmedBy: string
    }
    expect(p.permission).toBe(WORKINGNOMADS_SOURCE_STATUS.permission)
    expect(p.notes).toContain('no clause on automated access')
    expect(p.notes).toContain('/api/exposed_jobs/')
    expect(p.trimmedBy).toContain('NO job data was captured')
  })

  it('the committed Terms of Service are the Working Nomads terms and contain NO automated-access clause', () => {
    const text = termsText()
    expect(text).toContain('Terms of Service')
    // The deciding property is an ABSENCE, so it is stated as one. If a re-captured page makes this
    // fail, the permission verdict is out of date: re-read the terms and decide - do not edit the
    // pattern until it passes. (A frozen file pinned by sha256 cannot detect a live change; that
    // belongs to a scheduled live-vs-rawSha256 comparison, not to this unit suite.)
    expect(text).not.toMatch(
      /scrap|crawl|robot|spider|data mining|harvest|automated (?:access|means|tools? for (?:access|collect))|\bbots?\b/i,
    )
  })

  it('the footer "API" link is the JSON endpoint itself, not documentation', () => {
    const html = readFileSync(
      join(__dirname, '__fixtures__', 'workingnomads', 'terms.html.txt'),
      'utf8',
    )
    expect(html).toContain('<a href="/api/exposed_jobs/" target="_self" rel="nofollow">API</a>')
  })

  it('keeps no job data in the fixture directory', () => {
    expect(termsText()).not.toContain('"description"')
  })
})
