import { HttpException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { SessionUser } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROLES_KEY } from '../common/decorators/roles.decorator'
import { TailoredResumesController } from './tailored-resumes.controller'

const OPP = '0b5e0000-0000-4000-8000-0000000000a1'
const S1 = '0b5e0000-0000-4000-8000-000000000001'
const RUN = '0b5e0000-0000-4000-8000-0000000000e1'
const RENDER = '0b5e0000-0000-4000-8000-0000000000f1'
const EDIT = {
  summary: 'Backend engineer.',
  skills: ['TypeScript'],
  bullets: [['Built the billing API.']],
  coverLetter: 'I would like to apply.',
}
const user = { id: 'u', role: 'HR' } as SessionUser
const row = {
  seniorId: S1,
  eligibility: 'READY',
  runStatus: null,
  runStage: null,
  runErrorCode: null,
  published: false,
  pdfStatus: 'IDLE',
  pdfRenderId: null,
  baseChanged: false,
}
const detail = {
  ...row,
  coverLetter: null,
  editable: null,
  summary: null,
  generatedAt: null,
  editedAt: null,
}

function make(enabled = true) {
  const svc = {
    generate: vi.fn(async () => ({ runId: RUN })),
    edit: vi.fn(async () => ({ renderId: RENDER })),
    list: vi.fn(async () => [row]),
    detail: vi.fn(async () => detail),
    pdf: vi.fn(),
  }
  const config = { get: vi.fn(() => enabled) }
  const ctl = new TailoredResumesController(svc as never, config as never)
  return { ctl, svc, config }
}

function reply() {
  const r = {
    sent: undefined as unknown,
    statusCode: 200,
    headers: {} as Record<string, string>,
    status: vi.fn((c: number) => {
      r.statusCode = c
      return r
    }),
    header: vi.fn((k: string, v: string) => {
      r.headers[k] = v
      return r
    }),
    send: vi.fn(async (b: unknown) => {
      r.sent = b
      return r
    }),
  }
  return r
}

const status404 = async (p: () => Promise<unknown>) => {
  const err = await p().then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HttpException)
  expect((err as HttpException).getStatus()).toBe(404)
  expect((err as HttpException).getResponse()).toMatchObject({ code: 'JOB_OPPORTUNITY_NOT_FOUND' })
}

beforeEach(() => vi.clearAllMocks())

describe('TailoredResumesController', () => {
  it('every route is ADMIN and HR only', () => {
    const reflector = new Reflector()
    const proto = TailoredResumesController.prototype as unknown as Record<string, () => unknown>
    for (const name of ['list', 'generate', 'edit', 'detail', 'pdf']) {
      expect(reflector.get(ROLES_KEY, proto[name] as () => unknown)).toEqual(['ADMIN', 'HR'])
    }
  })

  it('flag off: every route answers the uniform 404 before the service or any parse', async () => {
    const { ctl, svc, config } = make(false)
    await status404(() => ctl.list(OPP, { seniorIds: 'bad' }, user))
    await status404(() => ctl.generate(OPP, S1, { nonsense: 1 }, user))
    await status404(() => ctl.edit(OPP, S1, { nonsense: 1 }, user))
    await status404(() => ctl.detail(OPP, S1, {}, user))
    await status404(() => ctl.pdf(OPP, S1, {}, user, reply() as never))
    expect(config.get).toHaveBeenCalledWith('TAILORED_RESUME_ENABLED', { infer: true })
    expect(Object.values(svc).every((f) => f.mock.calls.length === 0)).toBe(true)
  })

  it('list parses the query (D10) and the answer', async () => {
    const { ctl, svc } = make()
    expect(await ctl.list(OPP, { seniorIds: ` ${S1.toUpperCase()} ,${S1}` }, user)).toEqual([row])
    expect(svc.list).toHaveBeenCalledWith(user, OPP, { seniorIds: [S1] })
    await expect(ctl.list(OPP, { seniorIds: '' }, user)).rejects.toThrow()
    svc.list.mockResolvedValueOnce([{ ...row, eligibility: 'NOPE' }] as never)
    await expect(ctl.list(OPP, { seniorIds: S1 }, user)).rejects.toThrow()
  })

  it('generate parses the strict body and answers the run id', async () => {
    const { ctl, svc } = make()
    expect(await ctl.generate(OPP, S1, { overwrite: true }, user)).toEqual({ runId: RUN })
    expect(svc.generate).toHaveBeenCalledWith(user, OPP, S1, { overwrite: true })
    await expect(ctl.generate(OPP, S1, { overwrite: true, extra: 1 }, user)).rejects.toThrow()
    expect(svc.generate).toHaveBeenCalledTimes(1)
  })

  it('edit parses the strict body and answers the render id', async () => {
    const { ctl, svc } = make()
    expect(await ctl.edit(OPP, S1, EDIT, user)).toEqual({ renderId: RENDER })
    expect(svc.edit).toHaveBeenCalledWith(user, OPP, S1, EDIT)
    await expect(ctl.edit(OPP, S1, { ...EDIT, displayName: 'x' }, user)).rejects.toThrow()
    expect(svc.edit).toHaveBeenCalledTimes(1)
    svc.edit.mockResolvedValueOnce({ renderId: 'not-a-uuid' })
    await expect(ctl.edit(OPP, S1, EDIT, user)).rejects.toThrow()
  })

  it('detail passes the scope team and parses the answer', async () => {
    const { ctl, svc } = make()
    const teamId = '0b5e0000-0000-4000-8000-0000000000c1'
    expect(await ctl.detail(OPP, S1, { teamId }, user)).toEqual(detail)
    expect(svc.detail).toHaveBeenCalledWith(user, OPP, S1, teamId)
    await expect(ctl.detail(OPP, S1, { cursor: 'x' }, user)).rejects.toThrow()
  })

  it('pdf: pending is 202 with no body; a PDF is sent as an attachment with both file names', async () => {
    const { ctl, svc } = make()
    svc.pdf.mockResolvedValueOnce({ kind: 'PENDING' })
    const pending = reply()
    await ctl.pdf(OPP, S1, {}, user, pending as never)
    expect(pending.statusCode).toBe(202)
    expect(pending.send).toHaveBeenCalledWith()
    expect(svc.pdf).toHaveBeenCalledWith(user, OPP, S1, undefined)

    svc.pdf.mockResolvedValueOnce({
      kind: 'PDF',
      body: Buffer.from('%PDF'),
      filename: { ascii: 'A - B - CV.pdf', utf8: 'A%20-%20B%20-%20CV.pdf' },
    })
    const ok = reply()
    await ctl.pdf(OPP, S1, {}, user, ok as never)
    expect(ok.status).not.toHaveBeenCalled()
    expect(ok.headers).toEqual({
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="A - B - CV.pdf"; filename*=UTF-8''A%20-%20B%20-%20CV.pdf`,
    })
    expect(ok.sent).toEqual(Buffer.from('%PDF'))
  })
})
