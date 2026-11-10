import { describe, expect, it } from 'vitest'
import {
  answer,
  config,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  hostOf,
  LOCAL,
  REQ,
  scriptedFetch,
} from './__test-helpers__/router-harness'
import { createRouter } from './router'

const IMAGES = ['iVBORw0KGgo=']
const BAD = answer('not json at all')
const hosts = (sent: { host: string }[]) => sent.map((s) => s.host)
const userContent = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: unknown }[])[1]!.content

describe('router: image requests go only to vision-capable pairs', () => {
  it('skips the text-only route and sends the pages to Gemini as image parts', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r.ok).toBe(true)
    expect(hosts(f.sent)).toEqual([hostOf.gemini])
    expect(userContent(f.sent[0]!.body)).toEqual([
      { type: 'text', text: REQ.input },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGES[0]}` } },
    ])
  })

  it('never falls to the local floor when every vision pair fails', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : BAD))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), d).run({ ...REQ, images: IMAGES })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(new Set(hosts(f.sent))).toEqual(new Set([hostOf.gemini]))
    expect(d.events.some((e) => e.type === 'FELL_TO_LOCAL')).toBe(false)
  })

  it('with no vision route configured sends nothing and answers NOT_CONFIGURED', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
  })

  it('a local-only config never receives the pages', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({ ...REQ, images: IMAGES })
    expect(r).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
  })

  it('without images the order and the floor are unchanged, content stays a string', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : BAD))
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl)).run(REQ)
    expect(r.ok).toBe(true)
    // Two models per route, each asked once and corrected once, then the floor.
    expect(hosts(f.sent)).toEqual([
      ...Array<string>(4).fill(hostOf.groq),
      ...Array<string>(4).fill(hostOf.gemini),
      hostOf.local,
    ])
    expect(f.sent.every((s) => typeof userContent(s.body) === 'string')).toBe(true)
  })
})
