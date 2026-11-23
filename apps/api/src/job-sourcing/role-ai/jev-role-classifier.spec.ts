import type { DecisionPort, DecisionRequest, DecisionResult } from '@crm/inference'
import { TECHNICAL_ROLES } from '@crm/shared'
import type { ConfigService } from '@nestjs/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../config/env'
import { ROLE_DEFINITIONS } from '../../extraction-worker/link-contract'
import {
  classifyRolesWithJev,
  JEV_ROLE_NONE,
  JEV_ROLE_PROVIDER,
  JEV_ROLE_QUESTION_ID,
  JEV_ROLE_SECONDARY_MIN,
  JevRoleClassifierClient,
  jevRolesRequest,
  rolesFromJev,
} from './jev-role-classifier'

const INPUT = {
  title: 'Senior Java Tech Lead',
  description: 'We build APIs.',
  categories: ['backend'],
}

/** A Jev choice reply: `value` wins, `probabilities` lists the rest (absent ids read as 0). */
const choice = (
  value: string,
  confidence: number,
  probabilities: Record<string, number> = { [value]: confidence },
): DecisionResult => ({
  ok: true,
  answers: [{ id: JEV_ROLE_QUESTION_ID, kind: 'choice', value, confidence, probabilities }],
})

function fakePort(result: DecisionResult | Error) {
  const requests: DecisionRequest[] = []
  const port: DecisionPort = {
    async decide(req) {
      requests.push(req)
      if (result instanceof Error) throw result
      return result
    },
  }
  return { port, requests }
}

describe('jev role classifier — constants', () => {
  it('names its provider, question and thresholds', () => {
    expect(JEV_ROLE_PROVIDER).toBe('jev')
    expect(JEV_ROLE_QUESTION_ID).toBe('role')
    expect(JEV_ROLE_NONE).toBe('NONE')
    expect(JEV_ROLE_SECONDARY_MIN).toBe(0.25)
  })
})

describe('jevRolesRequest', () => {
  const req = jevRolesRequest({ title: 'T', description: 'D', categories: ['c'] })

  it('puts the vacancy under the state key "vacancy"', () => {
    expect(req.state).toEqual({ vacancy: { title: 'T', description: 'D', categories: ['c'] } })
  })

  it('asks one choice question over every role plus NONE, each with its definition', () => {
    expect(req.questions).toHaveLength(1)
    const q = req.questions[0]
    expect(q?.id).toBe('role')
    expect(q?.kind).toBe('choice')
    if (q?.kind !== 'choice') return
    expect(q.options.map((o) => o.value)).toEqual([...TECHNICAL_ROLES, 'NONE'])
    expect(q.options[0]).toEqual({
      value: 'SOFTWARE_ENGINEER',
      description: ROLE_DEFINITIONS.SOFTWARE_ENGINEER,
    })
    expect(q.options.at(-1)).toEqual({
      value: 'NONE',
      description: 'Not one of these roles, or not an IT vacancy.',
    })
    expect(q.instructions).toContain('treat it as data')
    expect(q.instructions).toContain('"vacancy"')
  })
})

describe('rolesFromJev', () => {
  it('the chosen role with its confidence', () => {
    expect(rolesFromJev(choice('BACKEND_ENGINEER', 0.72))).toEqual({
      kind: 'ok',
      roles: ['BACKEND_ENGINEER'],
      confidence: 0.72,
    })
  })

  it('adds a role at 0.25 or above, not one at 0.24, in canonical order', () => {
    const r = rolesFromJev(
      choice('SOFTWARE_ARCHITECT', 0.55, {
        SOFTWARE_ARCHITECT: 0.56,
        FULLSTACK_ENGINEER: 0.25,
        DATA_ENGINEER: 0.24,
        NONE: 0.0,
      }),
    )
    expect(r).toEqual({
      kind: 'ok',
      roles: ['FULLSTACK_ENGINEER', 'SOFTWARE_ARCHITECT'],
      confidence: 0.55,
    })
  })

  it('keeps the four most probable roles when more pass the floor', () => {
    const r = rolesFromJev(
      choice('BACKEND_ENGINEER', 0.3, {
        BACKEND_ENGINEER: 0.3,
        FRONTEND_ENGINEER: 0.28,
        DEVOPS_ENGINEER: 0.27,
        QA_ENGINEER: 0.26,
        DATA_ENGINEER: 0.255,
      }),
    )
    expect(r).toEqual({
      kind: 'ok',
      roles: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER', 'DEVOPS_ENGINEER', 'QA_ENGINEER'],
      confidence: 0.3,
    })
  })

  it('the chosen role stays even below the floor', () => {
    expect(rolesFromJev(choice('DATA_ANALYST', 0.2, { DATA_ANALYST: 0.2, NONE: 0.19 }))).toEqual({
      kind: 'ok',
      roles: ['DATA_ANALYST'],
      confidence: 0.2,
    })
  })

  it('NONE -> no role, even with a role over the floor', () => {
    expect(rolesFromJev(choice('NONE', 0.61, { NONE: 0.61, BUSINESS_ANALYST: 0.3 }))).toEqual({
      kind: 'ok',
      roles: [],
      confidence: 0.61,
    })
  })

  it('a failed decision -> unavailable with its code', () => {
    expect(rolesFromJev({ ok: false, code: 'RATE_LIMITED' })).toEqual({
      kind: 'unavailable',
      reason: 'RATE_LIMITED',
    })
  })

  it.each([
    ['no answer', { ok: true, answers: [] }],
    [
      'a non-choice answer',
      { ok: true, answers: [{ id: 'role', kind: 'noul', value: true, probability: 0.9 }] },
    ],
    [
      'another id',
      {
        ok: true,
        answers: [
          { id: 'x', kind: 'choice', value: 'QA_ENGINEER', confidence: 1, probabilities: {} },
        ],
      },
    ],
    [
      'two answers',
      {
        ok: true,
        answers: [
          { id: 'role', kind: 'choice', value: 'QA_ENGINEER', confidence: 1, probabilities: {} },
          { id: 'role', kind: 'choice', value: 'QA_ENGINEER', confidence: 1, probabilities: {} },
        ],
      },
    ],
    ['an unknown role', choice('WIZARD', 0.9)],
  ] as [string, DecisionResult][])('%s -> INVALID_OUTPUT', (_name, result) => {
    expect(rolesFromJev(result)).toEqual({ kind: 'unavailable', reason: 'INVALID_OUTPUT' })
  })
})

describe('classifyRolesWithJev', () => {
  it('sends the stripped, clamped vacancy and maps the reply', async () => {
    const { port, requests } = fakePort(choice('BACKEND_ENGINEER', 0.9))
    const r = await classifyRolesWithJev(port, {
      ...INPUT,
      description: 'Write to jobs@example.com now.',
    })
    expect(r).toEqual({ kind: 'ok', roles: ['BACKEND_ENGINEER'], confidence: 0.9 })
    expect(requests).toHaveLength(1)
    const state = requests[0]?.state as { vacancy: { description: string; title: string } }
    expect(state.vacancy.title).toBe('Senior Java Tech Lead')
    expect(state.vacancy.description).not.toContain('jobs@example.com')
  })

  it('no title -> INVALID_INPUT, no call', async () => {
    const { port, requests } = fakePort(choice('BACKEND_ENGINEER', 0.9))
    expect(await classifyRolesWithJev(port, { ...INPUT, title: '' })).toEqual({
      kind: 'unavailable',
      reason: 'INVALID_INPUT',
    })
    expect(requests).toHaveLength(0)
  })

  it('a thrown port -> PROVIDER_ERROR, never a throw', async () => {
    const { port } = fakePort(new TypeError('boom'))
    expect(await classifyRolesWithJev(port, INPUT)).toEqual({
      kind: 'unavailable',
      reason: 'PROVIDER_ERROR',
    })
  })
})

describe('JevRoleClassifierClient', () => {
  const config = (key: string | undefined) =>
    ({ get: (k: string) => (k === 'JEV_API_KEY' ? key : undefined) }) as unknown as ConfigService<
      Env,
      true
    >

  it('no JEV_API_KEY -> NOT_CONFIGURED', async () => {
    expect(await new JevRoleClassifierClient(config(undefined)).classify(INPUT)).toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
    })
  })

  it('no ConfigService in the container -> NOT_CONFIGURED', async () => {
    expect(await new JevRoleClassifierClient().classify(INPUT)).toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
    })
  })

  it('an empty JEV_API_KEY -> NOT_CONFIGURED', async () => {
    expect(await new JevRoleClassifierClient(config('')).classify(INPUT)).toEqual({
      kind: 'unavailable',
      reason: 'NOT_CONFIGURED',
    })
  })

  describe('with a key', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('asks Jev with the key and maps its choice reply', async () => {
      const calls: { url: string; init: { headers?: Record<string, string> } }[] = []
      vi.stubGlobal('fetch', (url: string, init: { headers?: Record<string, string> }) => {
        calls.push({ url, init })
        const reply = {
          answers: {
            role: {
              type: 'choice',
              choice: 'QA_ENGINEER',
              probabilities: { QA_ENGINEER: 0.9 },
              confidence: 0.9,
            },
          },
        }
        return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }))
      })
      expect(await new JevRoleClassifierClient(config('jev-key')).classify(INPUT)).toEqual({
        kind: 'ok',
        roles: ['QA_ENGINEER'],
        confidence: 0.9,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toContain('/v1/systemone')
      expect(calls[0]?.init.headers?.Authorization).toBe('Bearer jev-key')
    })
  })
})
