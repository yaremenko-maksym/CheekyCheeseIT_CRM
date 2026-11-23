import {
  createExtractionWorkerAdapter,
  createJevDecisionAdapter,
  routerInputCeilingChars,
  type DecisionPort,
  type ExtractionPort,
  type FetchLike,
} from '@crm/inference'
import {
  DESCRIPTION_MD_MAX,
  jobQueueManualParseResponseSchema,
  type JobQueueManualParseResponse,
  type SessionUser,
} from '@crm/shared'
import { ForbiddenException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { apiError } from '../../common/api-error'
import type { Env } from '../../config/env'
import { DatabaseService } from '../../database/database.service'
import { EXTRACTION_TABLE_VERSION } from '../../extraction-worker/link-contract'
import { stripContacts } from '../structuring/contact-strip'
import { InMemoryModelBudget } from '../structuring/model-budget.port'
import {
  readExtractionInputWindow,
  readExtractionWorkerEnv,
} from '../structuring/model-extraction-wiring'
import { ModelStructurer } from '../structuring/model-structurer'
import { EXTRACTION_SYSTEM_PROMPT } from '../structuring/prompt-envelope'
import { JobQueueScopeService } from './queue-scope.service'

/** The hosted extraction may take this long; the dialog waits for it, so it is short. */
export const PARSE_TIMEOUT_MS = 30_000
/** Jev's own HTTP timeout here: a slow answer is treated as "Jev is down", never a hang. */
export const JEV_TIMEOUT_MS = 10_000
export const VACANCY_QUESTION = 'Does this text describe one job vacancy?'
const VACANCY_QUESTION_ID = 'vacancy'
/** Jev's `probability` is P(true): at or above this the text is a vacancy. */
const VACANCY_THRESHOLD = 0.5
// Stryker disable next-line StringLiteral: equivalent — the version is echoed in the outcome, which the answer never carries
const EXTRACTION_VERSION = 'manual-parse-1'

export const MANUAL_PARSE_PORTS = Symbol('MANUAL_PARSE_PORTS')

export type ManualParsePorts = {
  /** Jev (`JEV_API_KEY`); absent = "Jev is down", so the text is treated as a vacancy. */
  readonly decision: DecisionPort | undefined
  /** The extraction worker's `/extract`, the collector's hosted client; absent = the 503. */
  readonly extraction: ExtractionPort | undefined
  /** The smallest hosted input window (`EXTRACTION_INPUT_*`), as the collector cuts to it. */
  readonly inputCeilingChars: number | undefined
}

/**
 * The ports from env. The worker reply's events and health flags are the collector's records
 * (§5.3); a manual parse stores nothing, so its `onReply` drops them.
 */
export function createManualParsePorts(
  config: ConfigService<Env, true> | undefined,
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: FetchLike,
): ManualParsePorts {
  // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — `infer` only types the return
  const apiKey = config?.get('JEV_API_KEY', { infer: true })
  const worker = readExtractionWorkerEnv(rawEnv)
  const window = readExtractionInputWindow(rawEnv)
  return {
    decision: apiKey
      ? createJevDecisionAdapter({
          apiKey,
          timeoutMs: JEV_TIMEOUT_MS,
          ...(fetchImpl && { fetchImpl }),
        })
      : undefined,
    extraction:
      worker.kind === 'ok'
        ? createExtractionWorkerAdapter({
            baseUrl: worker.url,
            secret: worker.secret,
            tableVersion: EXTRACTION_TABLE_VERSION,
            timeoutMs: PARSE_TIMEOUT_MS,
            // Stryker disable next-line BlockStatement: equivalent — the sink is a no-op on purpose
            onReply: () => {},
            ...(fetchImpl && { fetchImpl }),
          })
        : undefined,
    inputCeilingChars: window
      ? routerInputCeilingChars(window, EXTRACTION_SYSTEM_PROMPT)
      : undefined,
  }
}

/** Trimmed and cut to `max`; blank is absent. */
function field(value: string | null, max: number): string | undefined {
  const cut = value?.trim().slice(0, max).trim()
  return cut ? cut : undefined
}

/** The guarded record as the wire answer: every field trimmed and capped to the response schema. */
export function toParseResponse(record: {
  title: string | null
  company: string | null
  description: string | null
}): JobQueueManualParseResponse {
  const title = field(record.title, 500)
  const companyName = field(record.company, 255)
  const descriptionMd = field(record.description, DESCRIPTION_MD_MAX)
  return jobQueueManualParseResponseSchema.parse({
    isVacancy: true,
    ...(title && { title }),
    ...(companyName && { companyName }),
    ...(descriptionMd && { descriptionMd }),
  })
}

/**
 * `POST /job-queue/manual/parse` (external vacancy intake, spec §D): the text an HR pasted, or the
 * page text the bookmarklet read in the HR's own browser, in; the vacancy fields out. Nothing is
 * stored, and the text is never logged — only its length and the outcome.
 *
 * 1. The role and scope are re-checked here (`JobQueueScopeService.resolve`), before any model call.
 * 2. Jev answers one `noul` question; below the threshold the answer is `{ isVacancy: false }` and
 *    no hosted call is made. Jev down, unset or answering off-contract counts as "yes": the HR
 *    still gets the fields (degrade, never break).
 * 3. The hosted extraction is the collector's `ModelStructurer` over the worker's `/extract`, with
 *    its own one-call budget per request (never the collector's per-cycle budget) and a 30 s
 *    timeout; the reply passes `guardExtractionResult` inside it. Any outcome but EXTRACTED is
 *    `JOB_QUEUE_PARSE_UNAVAILABLE` (503).
 *
 * `assertModelAllowed` (the robots `ai-input` gate) is a per-SOURCE policy and does not apply: the
 * text comes from the HR, not from a source, so the request states `aiInput: 'yes'`.
 */
@Injectable()
export class ManualParseService {
  private readonly logger = new Logger(ManualParseService.name)

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueueScopeService) private readonly scopes: JobQueueScopeService,
    @Inject(MANUAL_PARSE_PORTS) private readonly ports: ManualParsePorts,
  ) {}

  async parse(user: SessionUser, text: string): Promise<JobQueueManualParseResponse> {
    const scope = await this.scopes.resolve(user, undefined, this.database.db)
    if (scope.kind === 'NONE') throw new ForbiddenException()
    const done = (outcome: string) =>
      this.logger.log(`manual parse: chars=${text.length} outcome=${outcome}`)

    if (!(await this.isVacancy(text))) {
      done('NOT_VACANCY')
      return { isVacancy: false }
    }
    const outcome = await this.extract(text)
    if (outcome.kind !== 'EXTRACTED') {
      this.logger.warn(`manual parse: chars=${text.length} outcome=UNAVAILABLE:${outcome.kind}`)
      throw apiError('JOB_QUEUE_PARSE_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE)
    }
    const [record] = outcome.records
    if (record === undefined) {
      done('NO_RECORD')
      return { isVacancy: false }
    }
    done('FILLED')
    return toParseResponse(record)
  }

  private async isVacancy(text: string): Promise<boolean> {
    const port = this.ports.decision
    // Stryker disable next-line ConditionalExpression: equivalent — an absent port throws inside the try, which also answers true
    if (port === undefined) return true
    try {
      const res = await port.decide({
        state: { text: stripContacts(text).text },
        questions: [{ id: VACANCY_QUESTION_ID, kind: 'noul', instructions: VACANCY_QUESTION }],
      })
      if (!res.ok || res.answers.length !== 1) return true
      const [answer] = res.answers
      // Stryker disable next-line OptionalChaining: equivalent — the length check above makes `answer` defined
      if (answer?.kind !== 'noul' || answer.id !== VACANCY_QUESTION_ID) return true
      return answer.probability >= VACANCY_THRESHOLD
    } catch {
      return true
    }
  }

  private async extract(text: string) {
    const port = this.ports.extraction
    if (port === undefined) return { kind: 'NOT_CONFIGURED' as const }
    const structurer = new ModelStructurer({
      port,
      budget: new InMemoryModelBudget(1),
      timeoutMs: PARSE_TIMEOUT_MS,
      // Stryker disable next-line ConditionalExpression: equivalent — the structurer reads an undefined ceiling as no ceiling
      ...(this.ports.inputCeilingChars !== undefined && {
        inputCeilingChars: this.ports.inputCeilingChars,
      }),
    })
    return structurer.structure({
      aiInput: 'yes',
      // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — with aiInput 'yes' the policy is never read
      policy: { onUnspecified: 'block' },
      // No verified URL: the text is not a fetched page, so the guard proves URLs from the text only.
      // Stryker disable next-line StringLiteral: equivalent — the id and the URL shape only the URL facts and issue ids, which the answer never carries
      records: [{ id: 'manual', url: '', text }],
      extractionVersion: EXTRACTION_VERSION,
    })
  }
}
