import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common'
import type { JobCollectionRunDto, SessionUser } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { captureRejection } from '../common/testing/capture-rejection'
import { JobSourcingController } from './job-sourcing.controller'
import type { JobSourcingService } from './job-sourcing.service'

const ADMIN = { id: '00000000-0000-4000-8000-000000000001', role: 'ADMIN' } as SessionUser
const failure: JobCollectionRunDto['failures'][number] = {
  sourceType: 'DOU_RSS',
  message: 'boom',
  budgetExhausted: false,
}
const result: JobCollectionRunDto['results'][number] = {
  sourceType: 'DOU_RSS',
  fetched: 1,
  created: 1,
  duplicates: 0,
  invalid: 0,
  merged: 0,
  filtered: 0,
  suggestionsCreated: 0,
}

const controllerFor = (run: JobCollectionRunDto) =>
  new JobSourcingController({
    collectAllAsActor: () => Promise.resolve(run),
  } as unknown as JobSourcingService)

/** ADR 2026-11-03 §H.8: the ADMIN manual run (`POST /job-sourcing/collect`). */
describe('JobSourcingController.collect — the AI-limits notice', () => {
  it('nothing succeeded AND the model stage stopped on limits: 503 with the new code', async () => {
    const run: JobCollectionRunDto = {
      results: [],
      failures: [failure],
      sourcingNotice: 'AI_LIMITS_EXHAUSTED',
    }
    const err = await captureRejection(() => controllerFor(run).collect(ADMIN))
    expect(err).toBeInstanceOf(HttpException)
    const http = err as HttpException
    expect(http.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(http.getResponse()).toEqual({
      statusCode: 503,
      code: 'JOB_SOURCING_AI_LIMITS_EXHAUSTED',
      params: undefined,
      message:
        'Vacancy sourcing is temporarily unavailable: AI model limits are exhausted for now. Try again later.',
    })
  })

  it('nothing succeeded without limits: today’s 503, no new code', async () => {
    const run: JobCollectionRunDto = { results: [], failures: [failure], sourcingNotice: null }
    const err = await captureRejection(() => controllerFor(run).collect(ADMIN))
    expect(err).toBeInstanceOf(ServiceUnavailableException)
    const body = (err as HttpException).getResponse() as Record<string, unknown>
    expect(body['code']).toBeUndefined()
    expect(body['message']).toBe('Сбор не удался: DOU_RSS — boom')
  })

  it('a partial run with limits is a 200 that carries the notice', async () => {
    const run: JobCollectionRunDto = {
      results: [result],
      failures: [failure],
      sourcingNotice: 'AI_LIMITS_EXHAUSTED',
    }
    await expect(controllerFor(run).collect(ADMIN)).resolves.toMatchObject({
      sourcingNotice: 'AI_LIMITS_EXHAUSTED',
    })
  })

  it('an empty run with no failures and limits is a 200, not a 503 (nothing failed)', async () => {
    const run: JobCollectionRunDto = {
      results: [],
      failures: [],
      sourcingNotice: 'AI_LIMITS_EXHAUSTED',
    }
    await expect(controllerFor(run).collect(ADMIN)).resolves.toEqual(run)
  })
})
