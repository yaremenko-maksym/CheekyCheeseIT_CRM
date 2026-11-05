import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { SmallDose } from '../contracts/extraction'
import {
  answer,
  config,
  deps,
  KEY_MARKER,
  LOCAL,
  PROVIDER_BODY_MARKER,
  REQ,
  scriptedFetch,
  TEXT_MARKER,
  type Reply,
  type Sent,
} from './__test-helpers__/router-harness'
import { routerInputCeilingChars } from './fit'
import { createRouter } from './router'

type Page = { title: string; salary?: number }

const REPLY_MARKER = 'REPLY-MARKER-3b8c'
const GROUP_MARKER = 'GROUP-MARKER-a41f'
const TITLE_ASK = `GROUP-TITLES ${GROUP_MARKER}`
const SALARY_ASK = `GROUP-SALARY ${GROUP_MARKER}`
const MARKERS = [
  KEY_MARKER,
  TEXT_MARKER,
  PROVIDER_BODY_MARKER,
  REPLY_MARKER,
  GROUP_MARKER,
  'Bearer',
]

const DOSE: SmallDose<Page> = {
  groups: [
    {
      name: 'title',
      instruction: TITLE_ASK,
      schema: z.object({ title: z.string() }),
      maxAnswerTokens: 111,
    },
    {
      name: 'salary',
      instruction: SALARY_ASK,
      schema: z.object({ salary: z.number().nullable() }),
      maxAnswerTokens: 111,
    },
  ],
  merge(parts) {
    const { title } = parts.title as { title: string }
    return { ok: true, data: { title } }
  },
}
const DOSE_REQ = { ...REQ, instruction: `the envelope ${TEXT_MARKER}`, smallDose: DOSE }

const systemOf = (s: Sent): string =>
  (s.body.messages as { role: string; content: string }[])[0]!.content
const charsOf = (s: Sent): number =>
  (s.body.messages as { content: string }[]).reduce((n, m) => n + m.content.length, 0)
const byGroup =
  (title: Reply, salary: Reply) =>
  (s: Sent): Reply =>
    systemOf(s).includes(TITLE_ASK) ? title : salary
const TITLE_OK = answer({ title: 'Engineer' })
const SALARY_OK = answer({ salary: 100 })

function assertClean(label: string, value: unknown): void {
  const text = JSON.stringify(value)
  for (const m of MARKERS) expect(text, `${label} carries ${m}`).not.toContain(m)
}

const providerBody = JSON.stringify({ error: { message: PROVIDER_BODY_MARKER } })
const GROUP_FAILURES: Reply[] = [
  { status: 401, body: providerBody },
  { status: 429, body: providerBody, headers: { 'retry-after': PROVIDER_BODY_MARKER } },
  { status: 500, body: providerBody },
  answer(`not json ${REPLY_MARKER}`),
  answer(REPLY_MARKER, {}, 'length'),
  answer({ wrong: REPLY_MARKER }),
  answer({ wrong: REPLY_MARKER }, { model: `other ${PROVIDER_BODY_MARKER}` }),
  'network',
]
const LOCAL_KEYED = { ...LOCAL, apiKey: KEY_MARKER, baseUrl: 'https://10.0.0.5/v1' }

describe('small dose privacy (AC5)', () => {
  it.each(GROUP_FAILURES.map((f, i) => [i, f] as const))(
    'failed first group, shape %i: no key, header, text, group ask, body or reply anywhere',
    async (_i, failure) => {
      const f = scriptedFetch(byGroup(failure, SALARY_OK))
      const d = deps(f.fetchImpl)
      const r = await createRouter(config([LOCAL_KEYED]), d).run(DOSE_REQ)
      expect(r.ok).toBe(false)
      assertClean('result', r)
      assertClean('events', d.events)
      expect(d.events.length).toBeGreaterThan(0)
    },
  )

  it.each(GROUP_FAILURES.map((f, i) => [i, f] as const))(
    'failed later group after a good one, shape %i: the good answer does not surface either',
    async (_i, failure) => {
      const f = scriptedFetch(byGroup(answer({ title: REPLY_MARKER }), failure))
      const d = deps(f.fetchImpl)
      const r = await createRouter(config([LOCAL_KEYED]), d).run(DOSE_REQ)
      expect(r.ok).toBe(false)
      assertClean('result', r)
      assertClean('events', d.events)
    },
  )

  it('a success event stream carries no answer text', async () => {
    const f = scriptedFetch(byGroup(answer({ title: 'Engineer' }), SALARY_OK))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([LOCAL_KEYED]), d).run(DOSE_REQ)
    expect(r.ok).toBe(true)
    assertClean('events', d.events)
    expect(JSON.stringify(d.events)).not.toContain('Engineer')
  })

  it('a merge that refuses returns a code, with nothing of the answers', async () => {
    const f = scriptedFetch(byGroup(answer({ title: REPLY_MARKER }), SALARY_OK))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([LOCAL_KEYED]), d).run({
      ...DOSE_REQ,
      smallDose: { ...DOSE, merge: () => ({ ok: false }) },
    })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
    assertClean('result', r)
    assertClean('events', d.events)
  })
})

describe('small dose: a merge that refuses (ADR 5.4)', () => {
  it('is INVALID_OUTPUT even when the whole schema would accept nothing at all', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const dose: SmallDose<unknown> = { groups: DOSE.groups, merge: () => ({ ok: false }) }
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      schema: z.unknown(),
      smallDose: dose,
    })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
  })
})

describe('small dose: a reply with nothing in it (ADR 6.1)', () => {
  it.each(['', '   '])(
    'an empty answer %j is INVALID_OUTPUT at once: no correction retry, no later group',
    async (empty) => {
      const f = scriptedFetch(byGroup(answer(empty), SALARY_OK))
      const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
        ...REQ,
        smallDose: DOSE,
      })
      expect(r).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
      expect(f.sent).toHaveLength(1)
      expect(f.sent.every((s) => systemOf(s).includes(TITLE_ASK))).toBe(true)
    },
  )
})

describe('small dose: fit on the correction retry (ADR 6.1)', () => {
  const route = { ...LOCAL, contextTokens: 4_000 }
  const instruction = 'short'
  // Both constants have one length, so the first group fits exactly as the second does.
  const window = { contextTokens: route.contextTokens, maxAnswerTokens: 111 }
  const ceiling = routerInputCeilingChars(window, `${instruction}\n\n${TITLE_ASK}`)

  it('a first group that barely fits still sends its correction retry', async () => {
    expect(ceiling).toBeGreaterThan(0)
    let titles = 0
    const f = scriptedFetch((s) => {
      if (!systemOf(s).includes(TITLE_ASK)) return SALARY_OK
      titles += 1
      return titles === 1 ? answer({ wrong: 'x' }) : TITLE_OK
    })
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([route]), d).run({
      ...REQ,
      input: 'p'.repeat(ceiling),
      instruction,
      smallDose: DOSE,
    })
    expect(r.ok).toBe(true)
    expect(f.sent).toHaveLength(3)
    expect(charsOf(f.sent[1]!)).toBeGreaterThan(charsOf(f.sent[0]!))
    expect(JSON.stringify(d.events)).not.toContain('PROMPT_TOO_LARGE')
  })

  it('one character more is refused before anything is sent', async () => {
    const f = scriptedFetch(() => TITLE_OK)
    const r = await createRouter(config([route]), deps(f.fetchImpl)).run({
      ...REQ,
      input: 'p'.repeat(ceiling + 1),
      instruction,
      smallDose: DOSE,
    })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
    expect(f.sent).toHaveLength(0)
  })
})
