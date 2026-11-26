/** Bookmarklet block map, Task 4 — `BlockPickService`: Jev gate, the worker's block ids, verbatim fields. */
import type { DecisionPort, DecisionResult } from '@crm/inference'
import {
  BLOCK_TEXT_MAX,
  DESCRIPTION_MD_MAX,
  MANUAL_COMPANY_MAX,
  MANUAL_PARSE_TEXT_MAX,
  MANUAL_TITLE_MAX,
  type JobQueueBlockPickRequest,
  type PageBlock,
  type SessionUser,
} from '@crm/shared'
import { ForbiddenException, HttpException, Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import {
  blockPickWorkerInput,
  EXTRACTION_TABLE_VERSION,
  pickBlocksBodySchema,
  type BlockPickReply,
} from '../../extraction-worker/link-contract'
import type { BlockPicker } from '../structuring/model-extraction-wiring'
import {
  assemblePick,
  BlockPickService,
  createBlockPickPorts,
  type BlockPickPorts,
} from './block-pick.service'
import { VACANCY_QUESTION } from './manual-parse.service'
import { JobQueueScopeService } from './queue-scope.service'

const ADMIN = { id: 'a', role: 'ADMIN' } as SessionUser
const HR = { id: 'h', role: 'HR' } as SessionUser

const block = (t: string, r: PageBlock['r'] = 'main'): PageBlock => ({
  t,
  k: 'p',
  fs: 16,
  fw: 400,
  x: 0,
  y: 0,
  w: 800,
  r,
})

/** A page: site nav, title, company, two description paragraphs, a footer. Ids 0..5. */
const BLOCKS: PageBlock[] = [
  block('Jobs Home Login', 'nav'),
  block('Senior Go Engineer'),
  block('Acme Corp'),
  block('You will build the billing platform in Go.'),
  block('Salary: 5000 USD, remote.', '-'),
  block('Copyright Acme', 'footer'),
]

/** The HR viewing the page: a logged-in site shows this name in its header. */
const VIEWER_NAME = 'Olena Kovalenko'

const REPLY: BlockPickReply = { title: 1, company: 2, description: [{ from: 3, to: 4 }] }

const REQUEST: JobQueueBlockPickRequest = {
  url: 'https://jobs.example.com/vacancy/42',
  tabTitle: 'Senior Go Engineer - Acme',
  blocks: BLOCKS,
}

const jev = (probability: number): DecisionResult => ({
  ok: true,
  answers: [{ id: 'vacancy', kind: 'noul', value: probability >= 0.5, probability }] as never,
})

function harness(
  opts: {
    decide?: DecisionPort['decide'] | null
    picker?: BlockPicker | null
    scope?: 'real' | 'NONE' | 'TEAM'
    /** The viewer's `users.display_name`; null = no row. */
    name?: string | null
  } = {},
) {
  const decide = vi.fn(
    opts.decide === undefined ? async () => jev(0.9) : (opts.decide ?? undefined),
  )
  const picker = vi.fn<BlockPicker>(
    opts.picker === undefined
      ? async () => ({ ok: true as const, reply: REPLY })
      : (opts.picker ?? undefined),
  )
  const ports: BlockPickPorts = {
    decision: opts.decide === null ? undefined : ({ decide } as DecisionPort),
    picker: opts.picker === null ? undefined : picker,
  }
  const resolve = vi.fn(async () =>
    opts.scope === 'NONE' ? { kind: 'NONE' as const } : { kind: 'TEAM' as const, teamId: 't' },
  )
  const scopes =
    opts.scope === 'real'
      ? new JobQueueScopeService()
      : ({ resolve } as unknown as JobQueueScopeService)
  const name = opts.name === undefined ? VIEWER_NAME : opts.name
  const execute = vi.fn(async () => ({ rows: name === null ? [] : [{ display_name: name }] }))
  const db = { marker: 'db', execute }
  const service = new BlockPickService({ db } as unknown as DatabaseService, scopes, ports)
  return { service, decide, picker, resolve, db, execute }
}

const code = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HttpException)
  const ex = err as HttpException
  return { status: ex.getStatus(), body: ex.getResponse() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('assemblePick — every character comes from a block', () => {
  it('copies the title, the company and the description ranges verbatim', () => {
    expect(assemblePick(BLOCKS, REPLY)).toEqual({
      title: 'Senior Go Engineer',
      company: 'Acme Corp',
      description: 'You will build the billing platform in Go.\n\nSalary: 5000 USD, remote.',
    })
  })

  it('joins the ranges in reply order, a blank line between blocks', () => {
    const reply = {
      ...REPLY,
      description: [
        { from: 4, to: 4 },
        { from: 1, to: 2 },
      ],
    }
    expect(assemblePick(BLOCKS, reply).description).toBe(
      'Salary: 5000 USD, remote.\n\nSenior Go Engineer\n\nAcme Corp',
    )
  })

  it('reads a reversed range as the same range, in page order', () => {
    const reply = { ...REPLY, description: [{ from: 4, to: 3 }] }
    expect(assemblePick(BLOCKS, reply).description).toBe(
      'You will build the billing platform in Go.\n\nSalary: 5000 USD, remote.',
    )
  })

  it('never repeats a block that two ranges overlap on', () => {
    const reply = {
      ...REPLY,
      description: [
        { from: 2, to: 3 },
        { from: 3, to: 4 },
        { from: 2, to: 2 },
      ],
    }
    expect(assemblePick(BLOCKS, reply).description).toBe(
      'Acme Corp\n\nYou will build the billing platform in Go.\n\nSalary: 5000 USD, remote.',
    )
  })

  it('drops out-of-range ids and clamps a range to the map', () => {
    expect(assemblePick(BLOCKS, { title: 6, company: -1, description: [] })).toEqual({})
    expect(
      assemblePick(BLOCKS, { title: null, company: null, description: [{ from: 6, to: 99 }] }),
    ).toEqual({})
    const plain = [block('First'), block('Middle'), block('Last')]
    expect(
      assemblePick(plain, { title: null, company: null, description: [{ from: -5, to: 0 }] })
        .description,
    ).toBe('First')
    // A huge range is clamped before any loop, so it never iterates past the map.
    expect(
      assemblePick(plain, {
        title: null,
        company: null,
        description: [{ from: 2, to: Number.MAX_SAFE_INTEGER }],
      }).description,
    ).toBe('Last')
  })

  it('the last block is in range, one past it is not', () => {
    expect(assemblePick(BLOCKS, { title: 5, company: null, description: [] })).toEqual({})
    const last = [...BLOCKS.slice(0, 5), block('Lead Go Engineer')]
    expect(assemblePick(last, { title: 5, company: 0, description: [] })).toEqual({
      title: 'Lead Go Engineer',
    })
  })

  it.each(['nav', 'footer'] as const)('a title or company in a %s block is dropped', (r) => {
    const blocks = [block('Careers', r), block('Acme', r), block('Body')]
    expect(
      assemblePick(blocks, { title: 0, company: 1, description: [{ from: 0, to: 2 }] }),
    ).toEqual({
      description: 'Body',
    })
  })

  it.each(['nav', 'header', 'footer'] as const)(
    'a description range never copies a %s block',
    (r) => {
      const blocks = [block('Intro'), block('Site chrome', r), block('Body')]
      expect(
        assemblePick(blocks, { title: null, company: null, description: [{ from: 0, to: 2 }] }),
      ).toEqual({ description: 'Intro\n\nBody' })
    },
  )

  it.each(['aside', 'dialog', 'main', '-'] as const)(
    'a description range copies a %s block',
    (r) => {
      const blocks = [block('Intro'), block('Aside text', r)]
      expect(
        assemblePick(blocks, { title: null, company: null, description: [{ from: 0, to: 1 }] }),
      ).toEqual({ description: 'Intro\n\nAside text' })
    },
  )

  it.each(['header', 'aside', 'dialog', 'main', '-'] as const)(
    'a title in a %s block is kept',
    (r) => {
      expect(
        assemblePick([block('Go Engineer', r)], { title: 0, company: 0, description: [] }),
      ).toEqual({
        title: 'Go Engineer',
        company: 'Go Engineer',
      })
    },
  )

  it('cuts each field to its cap and trims it; a blank field is absent', () => {
    const blocks = [
      block('T'.repeat(MANUAL_TITLE_MAX + 5)),
      block('C'.repeat(MANUAL_COMPANY_MAX + 5)),
      ...Array.from({ length: 40 }, () => block('D'.repeat(BLOCK_TEXT_MAX))),
      block('   '),
    ]
    const out = assemblePick(blocks, { title: 0, company: 1, description: [{ from: 2, to: 41 }] })
    expect(out.title).toBe('T'.repeat(MANUAL_TITLE_MAX))
    expect(out.company).toBe('C'.repeat(MANUAL_COMPANY_MAX))
    expect(out.description).toHaveLength(DESCRIPTION_MD_MAX)
    expect(
      assemblePick(blocks, { title: 42, company: 42, description: [{ from: 42, to: 42 }] }),
    ).toEqual({})
    expect(
      assemblePick([block('  Go  ')], { title: 0, company: null, description: [] }).title,
    ).toBe('Go')
  })
})

describe('BlockPickService — the role, re-checked before any model call', () => {
  it.each(['SENIOR', 'JUNIOR', 'ACCOUNTANT'])('%s is a 403 and no port is called', async (role) => {
    const h = harness({ scope: 'real' })
    await expect(h.service.pick({ id: 'x', role } as SessionUser, REQUEST)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.picker).not.toHaveBeenCalled()
  })

  it('an ADMIN passes the real scope check', async () => {
    const h = harness({ scope: 'real' })
    expect((await h.service.pick(ADMIN, REQUEST)).isVacancy).toBe(true)
  })

  it('an HR without an active team (scope NONE) is a 403 and no port is called', async () => {
    const h = harness({ scope: 'NONE' })
    await expect(h.service.pick(HR, REQUEST)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.picker).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('the scope is resolved for the actor without a team, over the service db', async () => {
    const h = harness()
    await h.service.pick(HR, REQUEST)
    expect(h.resolve).toHaveBeenCalledWith(HR, undefined, h.db)
  })
})

describe('BlockPickService — the Jev gate', () => {
  it('asks the shared vacancy question about the main and unmarked blocks only', async () => {
    const h = harness()
    await h.service.pick(HR, REQUEST)
    expect(h.decide).toHaveBeenCalledWith({
      state: {
        text: 'Senior Go Engineer\n\nAcme Corp\n\nYou will build the billing platform in Go.\n\nSalary: 5000 USD, remote.',
      },
      questions: [{ id: 'vacancy', kind: 'noul', instructions: VACANCY_QUESTION }],
    })
  })

  it('a page with no main or unmarked block gives Jev every block', async () => {
    const h = harness()
    await h.service.pick(HR, {
      ...REQUEST,
      blocks: [block('Go Engineer', 'dialog'), block('Acme', 'aside')],
    })
    expect(h.decide.mock.calls[0]![0].state).toEqual({ text: 'Go Engineer\n\nAcme' })
  })

  it("a header-only page reaches Jev without the viewer's name, in any case", async () => {
    const h = harness()
    await h.service.pick(HR, {
      ...REQUEST,
      blocks: [block('Signed in as OLENA kovalenko', 'header'), block('Go Engineer', 'header')],
    })
    const { text } = h.decide.mock.calls[0]![0].state as { text: string }
    expect(text.toLowerCase()).not.toMatch(/olena|kovalenko/)
    expect(text).toContain('Go Engineer')
  })

  it('a fullwidth name on a header-only page reaches Jev redacted', async () => {
    const h = harness()
    await h.service.pick(HR, {
      ...REQUEST,
      blocks: [block('Ｏｌｅｎａ Ｋｏｖａｌｅｎｋｏ', 'header')],
    })
    const { text } = h.decide.mock.calls[0]![0].state as { text: string }
    expect(text.normalize('NFKC').toLowerCase()).not.toMatch(/olena|kovalenko/)
  })

  it('a name split by a control character reaches Jev redacted, as the worker body is', async () => {
    const h = harness()
    await h.service.pick(HR, {
      ...REQUEST,
      blocks: [block('Signed in as Ol\u000Bena Kov\u000Balenko', 'header')],
    })
    const { text } = h.decide.mock.calls[0]![0].state as { text: string }
    expect(text.replace(/[\u0000-\u001F]/g, '').toLowerCase()).not.toMatch(/olena|kovalenko/)
  })

  it.each(['olena', 'kovalenko'])(
    'a url naming only the part %s is not sent to the worker',
    async (part) => {
      const h = harness()
      await h.service.pick(HR, { ...REQUEST, url: `https://jobs.example.com/u/${part}/go` })
      expect(h.picker.mock.calls[0]![0]).not.toHaveProperty('url')
    },
  )

  it('a stored name with a run of spaces still drops a url naming its first part', async () => {
    const h = harness({ name: 'Olena \t Kovalenko' })
    await h.service.pick(HR, { ...REQUEST, url: 'https://jobs.example.com/u/olena/go' })
    expect(h.picker.mock.calls[0]![0]).not.toHaveProperty('url')
  })

  it.each([
    ['the first name', 'Hi, olena'],
    ['the last name', 'KOVALENKO profile'],
  ])('%s alone never reaches the worker or Jev', async (_, text) => {
    const h = harness()
    await h.service.pick(HR, { tabTitle: 'x', blocks: [block(text), block('Go Engineer')] })
    const sent = JSON.stringify(h.picker.mock.calls[0]![0]).toLowerCase()
    const gate = (h.decide.mock.calls[0]![0].state as { text: string }).text.toLowerCase()
    for (const seen of [sent, gate]) expect(seen).not.toMatch(/olena|kovalenko/)
    expect(gate).toContain('go engineer')
  })

  it('the gate text is capped like the worker input', async () => {
    const h = harness()
    const big = Array.from({ length: 30 }, () => block('x'.repeat(BLOCK_TEXT_MAX)))
    await h.service.pick(HR, { ...REQUEST, blocks: big })
    const { text } = h.decide.mock.calls[0]![0].state as { text: string }
    expect(text).toHaveLength(MANUAL_PARSE_TEXT_MAX)
  })

  it('strips contacts from the text Jev sees', async () => {
    const h = harness()
    await h.service.pick(HR, {
      ...REQUEST,
      blocks: [block('Go dev, write to jane.doe@example.com')],
    })
    const { text } = h.decide.mock.calls[0]![0].state as { text: string }
    expect(text).not.toContain('jane.doe@example.com')
    expect(text).toContain('Go dev')
  })

  it('not a vacancy: { isVacancy: false } and the worker is never called', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const h = harness({ decide: async () => jev(0.2) })
    expect(await h.service.pick(HR, REQUEST)).toEqual({ isVacancy: false })
    expect(h.picker).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('block pick: blocks=6 outcome=NOT_VACANCY')
  })

  it('Jev throwing is a vacancy (degrade) and a warning without any page text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const h = harness({
      decide: async () => {
        throw new Error('down')
      },
    })
    expect((await h.service.pick(HR, REQUEST)).isVacancy).toBe(true)
    expect(warn).toHaveBeenCalledWith('block pick: jev unavailable')
  })

  it('no Jev configured: the worker is asked, with no Jev warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const h = harness({ decide: null })
    expect((await h.service.pick(HR, REQUEST)).isVacancy).toBe(true)
    expect(h.picker).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })
})

/** Jev answering the gate "yes" and every block-pick choice from `probs` (default: other). */
const jevPicks =
  (probs: Record<number, Record<string, number>>): DecisionPort['decide'] =>
  async (req) =>
    req.questions[0]?.kind === 'noul'
      ? jev(0.9)
      : {
          ok: true,
          answers: req.questions.map((q) => {
            const probabilities = probs[Number(q.id.slice(1))] ?? { other: 1 }
            return {
              id: q.id,
              kind: 'choice' as const,
              value: 'other',
              confidence: 1,
              probabilities,
            }
          }),
        }

describe('BlockPickService — Jev picks first, the worker on failure', () => {
  const PICKS = { 1: { title: 0.9 }, 2: { company: 0.9 }, 3: { description: 0.9 } }

  it('a Jev pick is the answer and the worker is never called', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const h = harness({ decide: jevPicks(PICKS) })
    expect(await h.service.pick(HR, REQUEST)).toEqual({
      isVacancy: true,
      title: 'Senior Go Engineer',
      companyName: 'Acme Corp',
      descriptionMd: 'You will build the billing platform in Go.',
    })
    expect(h.picker).not.toHaveBeenCalled()
    expect(h.decide).toHaveBeenCalledTimes(2)
    expect(h.decide.mock.calls[1]![0]).toMatchObject({ longContext: true })
    expect(warn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('block pick: blocks=6 outcome=FILLED')
  })

  it('Jev picks over the worker-bound body: the gate first, the same state the worker reads', async () => {
    const picks = harness({ decide: jevPicks(PICKS) })
    await picks.service.pick(HR, {
      ...REQUEST,
      blocks: [block(`Hi ${VIEWER_NAME}`, 'header'), ...BLOCKS],
    })
    const fallback = harness({
      decide: async (req) =>
        req.questions[0]?.kind === 'noul' ? jev(0.9) : { ok: false, code: 'TIMEOUT' },
    })
    await fallback.service.pick(HR, {
      ...REQUEST,
      blocks: [block(`Hi ${VIEWER_NAME}`, 'header'), ...BLOCKS],
    })
    expect(picks.decide.mock.calls[0]![0].questions[0]!.kind).toBe('noul')
    const state = picks.decide.mock.calls[1]![0].state as string
    const workerBody = fallback.picker.mock.calls[0]![0]
    expect(state).toBe(
      blockPickWorkerInput({ ...workerBody, tableVersion: EXTRACTION_TABLE_VERSION }).input,
    )
    expect(state.toLowerCase()).not.toContain('olena')
    expect(state.toLowerCase()).not.toContain('kovalenko')
  })

  it('a failed Jev pick falls back to the worker, with a warning that carries no text', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const h = harness({
      decide: async (req) =>
        req.questions[0]?.kind === 'noul' ? jev(0.9) : { ok: false, code: 'RATE_LIMITED' },
    })
    expect(await h.service.pick(HR, REQUEST)).toMatchObject({ title: 'Senior Go Engineer' })
    expect(h.picker).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('block pick: jev pick failed, worker fallback')
  })

  it('not a vacancy: no Jev pick request and no worker call', async () => {
    const h = harness({ decide: async () => jev(0.2) })
    await h.service.pick(HR, REQUEST)
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(h.picker).not.toHaveBeenCalled()
  })

  it('a refused HR (scope NONE) reaches neither Jev nor the worker', async () => {
    const h = harness({ decide: jevPicks(PICKS), scope: 'NONE' })
    await expect(h.service.pick(HR, REQUEST)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.picker).not.toHaveBeenCalled()
  })
})

describe('BlockPickService — the worker call', () => {
  it('answers the picked fields verbatim from the request blocks', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const h = harness()
    expect(await h.service.pick(HR, REQUEST)).toEqual({
      isVacancy: true,
      title: 'Senior Go Engineer',
      companyName: 'Acme Corp',
      descriptionMd: 'You will build the billing platform in Go.\n\nSalary: 5000 USD, remote.',
    })
    expect(log).toHaveBeenCalledWith('block pick: blocks=6 outcome=FILLED')
  })

  it('a reply that picks nothing is a vacancy with no fields: the form keeps its values', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const h = harness({
      picker: async () => ({ ok: true, reply: { title: null, company: null, description: [] } }),
    })
    expect(await h.service.pick(HR, REQUEST)).toEqual({ isVacancy: true })
    expect(log).toHaveBeenCalledWith('block pick: blocks=6 outcome=EMPTY')
  })

  it.each([
    ['title', { title: 1, company: null, description: [] }, { title: 'Senior Go Engineer' }],
    ['company', { title: null, company: 2, description: [] }, { companyName: 'Acme Corp' }],
    [
      'description',
      { title: null, company: null, description: [{ from: 3, to: 3 }] },
      { descriptionMd: 'You will build the billing platform in Go.' },
    ],
  ] as const)('only a %s is FILLED with that field alone', async (_, reply, fields) => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const h = harness({
      picker: async () => ({ ok: true, reply: { ...reply, description: [...reply.description] } }),
    })
    expect(await h.service.pick(HR, REQUEST)).toEqual({ isVacancy: true, ...fields })
    expect(log).toHaveBeenCalledWith('block pick: blocks=6 outcome=FILLED')
  })

  it('posts contact-stripped blocks, url and tab title in page order, in a body the worker accepts', async () => {
    const h = harness()
    await h.service.pick(HR, {
      url: 'https://www.linkedin.com/in/jane-doe',
      tabTitle: 'Go Engineer - call +380 67 123 45 67',
      blocks: [
        block('Write to jane.doe@example.com'),
        block('Go Engineer', 'nav'),
        block('@'.repeat(BLOCK_TEXT_MAX)),
      ],
    })
    const body = h.picker.mock.calls[0]![0]
    const posted = JSON.stringify(body)
    expect(posted).not.toContain('jane.doe@example.com')
    expect(posted).not.toContain('123 45 67')
    expect(posted).not.toContain('linkedin.com/in/jane-doe')
    expect(body.blocks.map((b) => b.r)).toEqual(['main', 'nav', 'main'])
    expect(body.blocks[1]).toEqual(block('Go Engineer', 'nav'))
    expect(body.tabTitle).toContain('Go Engineer')
    expect(
      pickBlocksBodySchema.safeParse({ ...body, tableVersion: EXTRACTION_TABLE_VERSION }).success,
    ).toBe(true)
  })

  it('the fields come from the page blocks, not the stripped copy the worker saw', async () => {
    const h = harness({
      picker: async () => ({
        ok: true,
        reply: { title: null, company: null, description: [{ from: 0, to: 0 }] },
      }),
    })
    const page = 'Apply: jobs@acme.example'
    expect(await h.service.pick(HR, { tabTitle: 'x', blocks: [block(page)] })).toEqual({
      isVacancy: true,
      descriptionMd: page,
    })
    expect(JSON.stringify(h.picker.mock.calls[0]![0])).not.toContain('jobs@acme.example')
  })

  it("the viewer's own name never reaches the worker: header, tab title, any case", async () => {
    const h = harness()
    await h.service.pick(HR, {
      url: REQUEST.url,
      tabTitle: 'Go Engineer | OLENA KOVALENKO',
      blocks: [
        block('Signed in as olena kovalenko', 'header'),
        block('Go Engineer, Olena Kovalenko'),
      ],
    })
    const posted = JSON.stringify(h.picker.mock.calls[0]![0]).toLowerCase()
    expect(posted).not.toContain('kovalenko')
    expect(posted).toContain('go engineer')
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('a Cyrillic name in mixed case is gone from the worker body', async () => {
    const h = harness({ name: 'Олена Коваленко' })
    await h.service.pick(HR, {
      tabTitle: 'Вакансія — ОЛЕНА коваленко',
      blocks: [block('Олена КОВАЛЕНКО, вийти', 'nav'), block('Go розробник')],
    })
    const posted = JSON.stringify(h.picker.mock.calls[0]![0]).toLowerCase()
    expect(posted).not.toContain('коваленко')
    expect(posted).toContain('go розробник')
  })

  it("a url that carries the viewer's name is dropped from the worker body", async () => {
    const h = harness({ name: 'Kovalenko' })
    await h.service.pick(HR, { ...REQUEST, url: 'https://jobs.example.com/u/kovalenko/saved' })
    expect(h.picker.mock.calls[0]![0]).not.toHaveProperty('url')
  })

  it.each([
    ['no users row', null],
    ['an empty name', ''],
    ['a name under three characters', 'Go'],
    ['a padded name under three characters', ' Go '],
  ])('%s redacts no name', async (_, name) => {
    const h = harness({ name })
    await h.service.pick(HR, REQUEST)
    expect(h.picker.mock.calls[0]![0]).toEqual({
      url: REQUEST.url,
      tabTitle: REQUEST.tabTitle,
      blocks: BLOCKS,
    })
  })

  it('a three-character name is redacted', async () => {
    const h = harness({ name: 'Ola' })
    await h.service.pick(HR, { tabTitle: 'x', blocks: [block('Hi Ola'), block('Go job')] })
    expect(JSON.stringify(h.picker.mock.calls[0]![0])).not.toContain('Ola')
  })

  it("the description still copies the page's own text, name included", async () => {
    const h = harness({
      picker: async () => ({
        ok: true,
        reply: { title: null, company: null, description: [{ from: 0, to: 0 }] },
      }),
    })
    const page = 'Recruiter: Olena Kovalenko'
    expect(await h.service.pick(HR, { tabTitle: 'x', blocks: [block(page)] })).toEqual({
      isVacancy: true,
      descriptionMd: page,
    })
    expect(JSON.stringify(h.picker.mock.calls[0]![0])).not.toContain('Kovalenko')
  })

  it.each(['nav', 'header', 'footer'] as const)(
    'a %s block reaches the worker cut to 80 characters; content blocks keep theirs',
    async (r) => {
      const h = harness()
      await h.service.pick(HR, {
        tabTitle: 'x',
        blocks: [block('n'.repeat(81), r), block('m'.repeat(200))],
      })
      const sent = h.picker.mock.calls[0]![0].blocks
      expect(sent[0]!.t).toBe('n'.repeat(80))
      expect(sent[1]!.t).toBe('m'.repeat(200))
    },
  )

  it.each([
    ['a percent-encoded name in the path', 'https://jobs.example.com/jobs/Olena%20Kovalenko'],
    ['a path that does not decode', 'https://jobs.example.com/jobs/%E0%A4%A'],
    ['a name in a punycode host', new URL('https://коваленко.example.com/jobs').href],
  ])('%s drops the url from the worker body', async (label, url) => {
    const h = harness({ name: label.includes('punycode') ? 'Коваленко' : VIEWER_NAME })
    await h.service.pick(HR, { ...REQUEST, url })
    expect(h.picker.mock.calls[0]![0]).not.toHaveProperty('url')
  })

  it('keeps a url whose path holds another site, not a name', async () => {
    const h = harness()
    const url = 'https://jobs.example.com/out/www.acme.com/apply'
    await h.service.pick(HR, { ...REQUEST, url })
    expect(h.picker.mock.calls[0]![0].url).toBe(url)
  })

  it('sends the worker only the origin and path of the url', async () => {
    const h = harness()
    await h.service.pick(HR, {
      ...REQUEST,
      url: 'https://jobs.example.com/vacancy/42?trk=x&refId=y#frag',
    })
    const body = h.picker.mock.calls[0]![0]
    expect(body.url).toBe('https://jobs.example.com/vacancy/42')
    expect(JSON.stringify(body)).not.toMatch(/trk|refId|frag/)
  })

  it('keeps a job url that carries no contact', async () => {
    const h = harness()
    await h.service.pick(HR, REQUEST)
    const body = h.picker.mock.calls[0]![0]
    expect(body).toEqual({ url: REQUEST.url, tabTitle: REQUEST.tabTitle, blocks: BLOCKS })
  })

  it('no url in the request is no url in the body', async () => {
    const h = harness()
    await h.service.pick(HR, { tabTitle: 'x', blocks: BLOCKS })
    expect(h.picker.mock.calls[0]![0]).not.toHaveProperty('url')
  })

  it('a stripped block or title longer than its cap is cut to it', async () => {
    const h = harness()
    // NFKC turns each U+FB03 ligature into three letters, so the stripped text outgrows the cap.
    await h.service.pick(HR, {
      tabTitle: 'ﬃ'.repeat(500),
      blocks: [block('ﬃ'.repeat(BLOCK_TEXT_MAX))],
    })
    const body = h.picker.mock.calls[0]![0]
    expect(body.tabTitle).toBe('ffi'.repeat(167).slice(0, 500))
    expect(body.blocks[0]!.t).toHaveLength(BLOCK_TEXT_MAX)
  })

  it.each([
    ['no worker configured', null, 'NOT_CONFIGURED'],
    ['a worker outage', async () => ({ ok: false as const, reason: 'timeout' }), 'timeout'],
    ['a bad reply', async () => ({ ok: false as const, reason: 'INVALID_REPLY' }), 'INVALID_REPLY'],
  ] as const)('%s is JOB_QUEUE_PARSE_UNAVAILABLE 503, logged by code', async (_, picker, tag) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const h = harness({ picker: picker as BlockPicker | null })
    const err = await code(h.service.pick(HR, REQUEST))
    expect(err.status).toBe(503)
    expect(err.body).toMatchObject({ code: 'JOB_QUEUE_PARSE_UNAVAILABLE' })
    expect(warn).toHaveBeenCalledWith(`block pick: blocks=6 outcome=UNAVAILABLE:${tag}`)
  })

  it('no log line carries block text, the url or the tab title', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const marked = {
      url: 'https://jobs.example.com/MARKURL',
      tabTitle: 'MARKTAB',
      blocks: [block('MARKBLOCK title'), block('MARKBLOCK body')],
    }
    const reply = { title: 0, company: null, description: [{ from: 1, to: 1 }] }
    await harness({ picker: async () => ({ ok: true, reply }) }).service.pick(HR, marked)
    await harness({ decide: async () => jev(0) }).service.pick(HR, marked)
    await harness({
      decide: async () => {
        throw new Error('MARKBLOCK')
      },
      picker: async () => ({ ok: false, reason: 'transport' }),
    })
      .service.pick(HR, marked)
      .catch(() => undefined)
    const lines = [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0]))
    expect(lines.length).toBeGreaterThanOrEqual(4)
    for (const line of lines) expect(line).not.toMatch(/MARK/)
  })
})

describe('createBlockPickPorts', () => {
  const SECRET = 'k3Y9fQ2mZ8wP4xL7vR1tN6bH5cJ0dAeGsUoIyTqWnMrKjXhV'
  const WORKER = {
    EXTRACTION_WORKER_URL: 'http://crm-extraction-worker:3100',
    EXTRACTION_WORKER_SECRET: SECRET,
  }
  const config = (key: string | undefined) =>
    ({ get: (name: string) => (name === 'JEV_API_KEY' ? key : 'other') }) as never

  it('no key and no worker env: no port at all', () => {
    expect(createBlockPickPorts(config(undefined), {})).toEqual({
      decision: undefined,
      picker: undefined,
    })
    expect(createBlockPickPorts(undefined, {}).decision).toBeUndefined()
  })

  it('a Jev key gives the decision port; a worker env gives a picker', () => {
    const ports = createBlockPickPorts(config('k'), WORKER)
    expect(typeof ports.decision?.decide).toBe('function')
    expect(typeof ports.picker).toBe('function')
  })

  it('the picker posts to the worker /pick-blocks with the shared secret', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }))
    const ports = createBlockPickPorts(config(undefined), WORKER, fetchImpl as never)
    const service = new BlockPickService(
      { db: { execute: async () => ({ rows: [] }) } } as unknown as DatabaseService,
      { resolve: async () => ({ kind: 'STUDIO' }) } as unknown as JobQueueScopeService,
      ports,
    )
    expect(await code(service.pick(ADMIN, REQUEST))).toMatchObject({ status: 503 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://crm-extraction-worker:3100/pick-blocks')
    expect(JSON.stringify(init.headers)).toContain(SECRET)
  })
})
