import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MAX_SMALL_DOSE_GROUPS, type SmallDose } from '../contracts/extraction'
import {
  DEFAULT_EXTRACTION_INSTRUCTION,
  MAX_EXTRACTION_INSTRUCTION_CHARS,
} from '../internal/chat-completions'
import {
  answer,
  config,
  deps,
  GOOD,
  GROQ,
  hostOf,
  LOCAL,
  REQ,
  scriptedFetch,
  type Reply,
  type Sent,
} from './__test-helpers__/router-harness'
import { createRouter, createRouterExtractionAdapter, type RouterEvent } from './router'

type Page = { title: string; salary?: number }

const TITLE_ASK = 'GROUP-TITLE: the title only.'
const SALARY_ASK = 'GROUP-SALARY: the salary only.'

/** Two groups, each asking one field; `merge` builds what `REQ.schema` validates. */
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
      maxAnswerTokens: 222,
    },
  ],
  merge(parts) {
    const { title } = parts.title as { title: string }
    const { salary } = parts.salary as { salary: number | null }
    return { ok: true, data: { title, ...(salary !== null && { salary }) } }
  },
}

const DOSE_REQ = { ...REQ, instruction: 'the whole envelope', smallDose: DOSE }

const systemOf = (s: Sent): string =>
  (s.body.messages as { role: string; content: string }[])[0]!.content
const userOf = (s: Sent): string =>
  (s.body.messages as { role: string; content: string }[])[1]!.content
const schemaSentBy = (s: Sent): unknown =>
  (s.body.response_format as { json_schema: { schema: unknown } }).json_schema.schema
const propertiesOf = (s: Sent): string[] =>
  Object.keys((schemaSentBy(s) as { properties: object }).properties)

/** The local script: `title` and `salary` answer by the group constant in the system message. */
function byGroup(title: Reply, salary: Reply): (s: Sent) => Reply {
  return (s) => (systemOf(s).includes(TITLE_ASK) ? title : salary)
}
const TITLE_OK = answer({ title: 'Engineer' })
const SALARY_OK = answer({ salary: 100 })
const HOSTED_DOWN: Reply = { status: 500, body: '' }

function clockLeaping(step: number): () => number {
  let t = 1_000
  return () => (t += step)
}

describe('small dose: what each route receives (§5.4)', () => {
  it('a local request never carries the full schema, only its group', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ)
    expect(f.sent.map(propertiesOf)).toEqual([['title'], ['salary']])
  })

  it('a hosted route gets the full schema and never a group', async () => {
    const f = scriptedFetch((s) =>
      s.host === hostOf.groq ? HOSTED_DOWN : byGroup(TITLE_OK, SALARY_OK)(s),
    )
    await createRouter(
      config([{ ...GROQ, models: ['openai/gpt-oss-120b'] }, LOCAL]),
      deps(f.fetchImpl),
    ).run(DOSE_REQ)
    const hosted = f.sent.filter((s) => s.host === hostOf.groq)
    expect(hosted.length).toBeGreaterThan(0)
    for (const s of hosted) {
      expect(propertiesOf(s).sort()).toEqual(['salary', 'title'])
      expect(systemOf(s)).toBe('the whole envelope')
    }
  })

  it('a hosted answer ends the call: no group is asked', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.groq ? GOOD : HOSTED_DOWN))
    const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ)
    expect(r).toEqual({ ok: true, data: { title: 'Engineer' }, usage: { totalTokens: 10 } })
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.groq])
  })

  it('every group body carries the whole instruction, its own constant after it, and the same input', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ)
    expect(f.sent.map(systemOf)).toEqual([
      `the whole envelope\n\n${TITLE_ASK}`,
      `the whole envelope\n\n${SALARY_ASK}`,
    ])
    expect(f.sent.map(userOf)).toEqual([REQ.input, REQ.input])
  })

  it('with no caller instruction the group constant follows the default one', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({ ...REQ, smallDose: DOSE })
    expect(systemOf(f.sent[0]!)).toBe(`${DEFAULT_EXTRACTION_INSTRUCTION}\n\n${TITLE_ASK}`)
  })

  it("every group request carries the group's own answer bound, not the route's", async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ)
    expect(f.sent.map((s) => s.body.max_tokens)).toEqual([111, 222])
  })

  it('a group schema renders without maxLength; an overlong value still fails Zod', async () => {
    const bounded: SmallDose<Page> = {
      groups: [
        {
          name: 'title',
          instruction: TITLE_ASK,
          schema: z.object({ title: z.string().max(5) }),
          maxAnswerTokens: 111,
        },
      ],
      merge: (parts) => ({ ok: true, data: parts.title as Page }),
    }
    const f = scriptedFetch(() => answer({ title: 'far too long for it' }))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: bounded,
    })
    expect(JSON.stringify(f.sent[0]!.body)).not.toContain('maxLength')
    expect(r).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
  })

  it("a group follows the local route's structured-output mode", async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    await createRouter(
      config([{ ...LOCAL, structuredOutput: 'json_object' }]),
      deps(f.fetchImpl),
    ).run(DOSE_REQ)
    expect(f.sent[0]!.body.response_format).toEqual({ type: 'json_object' })
  })

  it('a group schema JSON Schema cannot express falls back to json_object, as a whole call does', async () => {
    const unusual: SmallDose<Page> = {
      groups: [
        {
          name: 'title',
          instruction: TITLE_ASK,
          schema: z.object({ title: z.string().transform((t) => t) }),
          maxAnswerTokens: 111,
        },
      ],
      merge: (parts) => ({ ok: true, data: parts.title as Page }),
    }
    const f = scriptedFetch(() => TITLE_OK)
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: unusual,
    })
    expect(f.sent[0]!.body.response_format).toEqual({ type: 'json_object' })
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer' } })
  })
})

describe('small dose: the hand-back (§5.4)', () => {
  const internalCode = 'SMALL_DOSE_NEEDED'

  it('every hosted failure hands back to the groups, and the fall is an event naming why', async () => {
    const f = scriptedFetch((s) =>
      s.host === hostOf.groq ? HOSTED_DOWN : byGroup(TITLE_OK, SALARY_OK)(s),
    )
    const d = deps(f.fetchImpl)
    const r = await createRouter(
      config([{ ...GROQ, models: ['openai/gpt-oss-120b'] }, LOCAL]),
      d,
    ).run(DOSE_REQ)
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer', salary: 100 } })
    const fell = d.events.filter((e: RouterEvent) => e.type === 'FELL_TO_LOCAL')
    expect(fell).toEqual([
      {
        type: 'FELL_TO_LOCAL',
        plan: 'full-then-small',
        reasons: [{ route: 'groq', code: 'TRANSPORT' }],
      },
    ])
    expect(JSON.stringify([r, d.events])).not.toContain(internalCode)
  })

  it('a local-only config plans small and still emits the fall', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const d = deps(f.fetchImpl)
    await createRouter(config([LOCAL]), d).run(DOSE_REQ)
    expect(d.events.filter((e) => e.type === 'FELL_TO_LOCAL')).toEqual([
      { type: 'FELL_TO_LOCAL', plan: 'small', reasons: [] },
    ])
  })

  it('a failed floor never carries the internal code', async () => {
    const f = scriptedFetch(() => answer('not json'))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([LOCAL]), d).run(DOSE_REQ)
    expect(JSON.stringify([r, d.events])).not.toContain(internalCode)
  })

  it('the CALL event says the floor answered', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const d = deps(f.fetchImpl)
    await createRouter(config([LOCAL]), d).run(DOSE_REQ)
    expect(d.events.at(-1)).toMatchObject({ type: 'CALL', code: 'OK', floorAnswered: true })
  })

  it('a request without a table runs the whole schema on the floor, as before', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent).toHaveLength(1)
    expect(propertiesOf(f.sent[0]!).sort()).toEqual(['salary', 'title'])
    expect(f.sent[0]!.body.max_tokens).toBe(LOCAL.maxAnswerTokens)
  })
})

describe('small dose: merging (§5.4)', () => {
  it('merges the groups into one value that passes the full schema, with tokens added up', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ)
    expect(r).toMatchObject({
      ok: true,
      data: { title: 'Engineer', salary: 100 },
      usage: { totalTokens: 20 },
    })
  })

  it('merge receives each part under its group name, validated', async () => {
    const merge = vi.fn(() => ({ ok: true as const, data: { title: 'Engineer' } }))
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: { ...DOSE, merge },
    })
    expect(merge).toHaveBeenCalledWith({ title: { title: 'Engineer' }, salary: { salary: 100 } })
  })

  it('a model null on a nullable field is an answer, not a failure', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, answer({ salary: null })))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ)
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer' } })
    expect((r as { data: Page }).data).not.toHaveProperty('salary')
  })

  it('a merge that refuses ends in INVALID_OUTPUT, never an empty answer', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: { ...DOSE, merge: () => ({ ok: false }) },
    })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
  })

  it('a merged value the full schema refuses ends in INVALID_OUTPUT', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: { ...DOSE, merge: () => ({ ok: true, data: { salary: 5 } as unknown as Page }) },
    })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
  })

  it('the merged value is what the full schema parsed', async () => {
    const trimming = z.object({ title: z.string().transform((t) => t.trim()) })
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      input: REQ.input,
      schema: trimming,
      smallDose: {
        groups: DOSE.groups,
        merge: () => ({ ok: true, data: { title: '  spaced  ' } }),
      },
    })
    expect(r).toMatchObject({ ok: true, data: { title: 'spaced' } })
  })

  it('a one-group table holding the whole schema behaves as a full call on local', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: {
        groups: [{ name: 'whole', instruction: 'ALL.', schema: REQ.schema, maxAnswerTokens: 333 }],
        merge: (parts) => ({ ok: true, data: parts.whole as Page }),
      },
    })
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer' } })
    expect(f.sent).toHaveLength(1)
    expect(propertiesOf(f.sent[0]!).sort()).toEqual(['salary', 'title'])
  })

  it('an invalid group answer gets its one correction retry, on that group', async () => {
    const f = scriptedFetch((s, n) =>
      n === 1 ? answer('not json') : byGroup(TITLE_OK, SALARY_OK)(s),
    )
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ)
    expect(r).toMatchObject({ ok: true, data: { title: 'Engineer', salary: 100 } })
    expect(f.sent.map(systemOf)).toEqual([
      `the whole envelope\n\n${TITLE_ASK}`,
      `the whole envelope\n\n${TITLE_ASK}`,
      `the whole envelope\n\n${SALARY_ASK}`,
    ])
    expect((f.sent[1]!.body.messages as unknown[]).length).toBe(3)
    expect((f.sent[2]!.body.messages as unknown[]).length).toBe(2)
  })
})

describe('small dose: a failed group is a failed call (§5.4)', () => {
  const merge = vi.fn(DOSE.merge)

  it.each([
    ['TRANSPORT', 'network' as Reply, 'PROVIDER_ERROR'],
    ['a 500', { status: 500, body: '' } as Reply, 'PROVIDER_ERROR'],
    ['INVALID_OUTPUT', answer('not json') as Reply, 'INVALID_OUTPUT'],
    ['an answer cut at length', answer('{"title"', {}, 'length') as Reply, 'INVALID_OUTPUT'],
  ])('%s in the first group ends the call, with the second never asked', async (_n, bad, code) => {
    merge.mockClear()
    const f = scriptedFetch(byGroup(bad, SALARY_OK))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: { ...DOSE, merge },
    })
    expect(r).toMatchObject({ ok: false, code })
    expect(merge).not.toHaveBeenCalled()
    expect(f.sent.every((s) => systemOf(s).includes(TITLE_ASK))).toBe(true)
  })

  it.each([
    ['TRANSPORT', 'network' as Reply, 'PROVIDER_ERROR'],
    ['INVALID_OUTPUT', answer('not json') as Reply, 'INVALID_OUTPUT'],
  ])('%s in the last group fails the whole answer, never a partial one', async (_n, bad, code) => {
    merge.mockClear()
    const f = scriptedFetch(byGroup(TITLE_OK, bad))
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: { ...DOSE, merge },
    })
    expect(r).toMatchObject({ ok: false, code })
    expect(r).not.toHaveProperty('data')
    expect(merge).not.toHaveBeenCalled()
  })

  it('a group failure never goes back up the cascade', async () => {
    const f = scriptedFetch((s) =>
      s.host === hostOf.groq ? HOSTED_DOWN : byGroup(TITLE_OK, 'network')(s),
    )
    const r = await createRouter(
      config([{ ...GROQ, models: ['openai/gpt-oss-120b'] }, LOCAL]),
      deps(f.fetchImpl),
    ).run(DOSE_REQ)
    expect(r).toMatchObject({ ok: false, code: 'PROVIDER_ERROR' })
    const hosts = f.sent.map((s) => s.host)
    expect(hosts.lastIndexOf(hostOf.groq)).toBeLessThan(hosts.indexOf(hostOf.local))
  })

  it('the floor budget is shared: a group past it sends nothing and ends in TIMEOUT', async () => {
    let t = 1_000
    const f = scriptedFetch((s) => {
      t += 60_000 // the first group's answer uses up the 60 s floor budget
      return byGroup(TITLE_OK, SALARY_OK)(s)
    })
    const r = await createRouter(
      config([{ ...LOCAL, timeoutMs: 5_000 }]),
      deps(f.fetchImpl, { now: () => t }),
    ).run(DOSE_REQ)
    expect(r).toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(f.sent).toHaveLength(1)
  })

  it('an abort between groups stops the call: no further request', async () => {
    const stop = new AbortController()
    const f = scriptedFetch((s) => {
      stop.abort()
      return byGroup(TITLE_OK, SALARY_OK)(s)
    })
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(DOSE_REQ, stop.signal)
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
    expect(f.sent).toHaveLength(1)
  })
})

describe('small dose: the group cap (§5.5 item 1)', () => {
  const groups = (n: number) =>
    Array.from({ length: n }, (_x, i) => ({
      name: `g${i}`,
      instruction: `GROUP-${i}.`,
      schema: z.object({ title: z.string() }),
      maxAnswerTokens: 50,
    }))
  const merged = { merge: () => ({ ok: true as const, data: { title: 'Engineer' } }) }

  it('a table over the cap sends nothing, on hosted routes too, and fails', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GROQ, LOCAL]), d).run({
      ...REQ,
      smallDose: { groups: groups(MAX_SMALL_DOSE_GROUPS + 1), ...merged },
    })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(0)
    expect(d.events).toEqual([
      expect.objectContaining({ type: 'CALL', code: 'PROVIDER_ERROR', floorAnswered: false }),
    ])
  })

  it('a table exactly at the cap runs every group', async () => {
    const f = scriptedFetch(() => TITLE_OK)
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      smallDose: { groups: groups(MAX_SMALL_DOSE_GROUPS), ...merged },
    })
    expect(r.ok).toBe(true)
    expect(f.sent).toHaveLength(MAX_SMALL_DOSE_GROUPS)
  })
})

describe('small dose: fit (§5.1, §8.4)', () => {
  // `promptFits` counts 2 characters a token: a 100-char system and input leave this context tight.
  const big = (at: 0 | 1): SmallDose<Page> => ({
    ...DOSE,
    groups: DOSE.groups.map((g, i) => (i === at ? { ...g, maxAnswerTokens: 100_000 } : g)),
  })

  it.each([0, 1] as const)('group %i over the window: refused with zero sent', async (at) => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([LOCAL]), d).run({ ...DOSE_REQ, smallDose: big(at) })
    expect(f.sent).toHaveLength(0)
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    expect(d.events.filter((e) => e.type === 'ATTEMPT')).toEqual([
      expect.objectContaining({ route: 'local', code: 'PROMPT_TOO_LARGE' }),
    ])
  })

  it('a combined instruction past the cut is refused rather than cut, with zero sent', async () => {
    const f = scriptedFetch(byGroup(TITLE_OK, SALARY_OK))
    const instruction = 'x'.repeat(MAX_EXTRACTION_INSTRUCTION_CHARS - TITLE_ASK.length - 1)
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...DOSE_REQ,
      instruction,
    })
    expect(f.sent).toHaveLength(0)
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
  })

  it('a combined instruction exactly at the cut is sent whole', async () => {
    const only = { ...DOSE, groups: [DOSE.groups[0]!] }
    const instruction = 'x'.repeat(MAX_EXTRACTION_INSTRUCTION_CHARS - TITLE_ASK.length - 2)
    const f = scriptedFetch(() => TITLE_OK)
    await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      instruction,
      smallDose: { ...only, merge: () => ({ ok: true, data: { title: 'E' } }) },
    })
    expect(systemOf(f.sent[0]!)).toBe(`${instruction}\n\n${TITLE_ASK}`)
  })

  it('the fit counts the constant: an instruction that fits alone can overflow with it', async () => {
    // A window that holds the bare instruction and input but not the group constant on top.
    const longAsk = 'y'.repeat(2_000)
    const table: SmallDose<Page> = {
      groups: [{ ...DOSE.groups[0]!, instruction: longAsk, maxAnswerTokens: 10 }],
      merge: () => ({ ok: true, data: { title: 'E' } }),
    }
    const f = scriptedFetch(() => TITLE_OK)
    const route = { ...LOCAL, contextTokens: 400, maxAnswerTokens: 10 }
    const plain = await createRouter(config([route]), deps(f.fetchImpl)).run({
      ...REQ,
      instruction: 'short',
    })
    expect(plain.ok).toBe(true)
    const sentBare = f.sent.length
    const r = await createRouter(config([route]), deps(f.fetchImpl)).run({
      ...REQ,
      instruction: 'short',
      smallDose: table,
    })
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    expect(f.sent.length).toBe(sentBare)
  })
})

describe('local time in usage (§5.5 item 6)', () => {
  it('a floor answer reports the time of its local requests', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl, { now: clockLeaping(10) })).run(
      REQ,
    )
    expect(r.ok).toBe(true)
    expect((r as { usage: { localMs: number } }).usage.localMs).toBeGreaterThan(0)
  })

  it('every group of a dose is charged', async () => {
    let t = 1_000
    const f = scriptedFetch((s) => {
      t += 700
      return byGroup(TITLE_OK, SALARY_OK)(s)
    })
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl, { now: () => t })).run(DOSE_REQ)
    expect(r).toMatchObject({ ok: true, usage: { localMs: 1_400 } })
  })

  it('a failed floor call is charged too', async () => {
    let t = 1_000
    const f = scriptedFetch(() => {
      t += 700
      return { status: 500, body: '' }
    })
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl, { now: () => t })).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR', usage: { localMs: 700 } })
  })

  it('a hosted answer charges no local time', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run(REQ)
    expect((r as { usage: object }).usage).not.toHaveProperty('localMs')
  })

  it('a floor refused before sending charges nothing', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([{ ...LOCAL, contextTokens: 10 }]), deps(f.fetchImpl)).run(
      REQ,
    )
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    expect(f.sent).toHaveLength(0)
  })

  it('a local answer with no reported tokens still reports its time, and only that', async () => {
    let t = 1_000
    const f = scriptedFetch(() => {
      t += 700
      return answer({ title: 'Engineer' }, { usage: undefined })
    })
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl, { now: () => t })).run(REQ)
    expect(r).toStrictEqual({ ok: true, data: { title: 'Engineer' }, usage: { localMs: 700 } })
  })

  it('an abort reports no local time: the caller charges the elapsed time itself', async () => {
    const stop = new AbortController()
    const f = scriptedFetch(() => {
      stop.abort()
      return GOOD
    })
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run(
      { ...REQ, smallDose: DOSE },
      stop.signal,
    )
    expect(r).toEqual({ ok: false, code: 'ABORTED' })
  })
})

describe('the ExtractionPort adapter carries the signal (§5.5 item 3)', () => {
  it('the request signal stops the call, publicly TIMEOUT, with nothing sent', async () => {
    const f = scriptedFetch(() => GOOD)
    const port = createRouterExtractionAdapter(config([GROQ, LOCAL]), deps(f.fetchImpl))
    const r = await port.extract({ ...REQ, signal: AbortSignal.abort() })
    expect(r).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(f.sent).toHaveLength(0)
  })

  it('an abort during a dose stops the groups', async () => {
    const stop = new AbortController()
    const f = scriptedFetch((s) => {
      stop.abort()
      return byGroup(TITLE_OK, SALARY_OK)(s)
    })
    const port = createRouterExtractionAdapter(config([LOCAL]), deps(f.fetchImpl))
    const r = await port.extract({ ...DOSE_REQ, signal: stop.signal })
    expect(r).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(f.sent).toHaveLength(1)
  })
})
