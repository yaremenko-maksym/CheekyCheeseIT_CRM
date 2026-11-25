import type { DecisionPort, FetchLike } from '@crm/inference'
import {
  BLOCK_TEXT_MAX,
  DESCRIPTION_MD_MAX,
  MANUAL_COMPANY_MAX,
  MANUAL_PARSE_TEXT_MAX,
  MANUAL_TITLE_MAX,
  type JobQueueBlockPickRequest,
  type JobQueueBlockPickResponse,
  type PageBlock,
  type SessionUser,
} from '@crm/shared'
import { ForbiddenException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { apiError } from '../../common/api-error'
import type { Env } from '../../config/env'
import { DatabaseService } from '../../database/database.service'
import {
  pickBlocksBodySchema,
  type BlockPickReply,
  type PickBlocksBody,
} from '../../extraction-worker/link-contract'
import { stripContacts } from '../structuring/contact-strip'
import { buildBlockPicker, type BlockPicker } from '../structuring/model-extraction-wiring'
import {
  createVacancyDecision,
  field,
  isVacancyText,
  PARSE_TIMEOUT_MS,
} from './manual-parse.service'
import { JobQueueScopeService } from './queue-scope.service'

/** The worker body's tab-title cap (`pickBlocksBodySchema`). */
const TAB_TITLE_MAX = 500
/** A title or company in these regions is site chrome, never the posting's. */
const CHROME_REGIONS: ReadonlySet<PageBlock['r']> = new Set(['nav', 'footer'])
/** The Jev gate reads the page's content regions; a page with none gives it every block. */
const CONTENT_REGIONS: ReadonlySet<PageBlock['r']> = new Set(['main', '-'])

export const BLOCK_PICK_PORTS = Symbol('BLOCK_PICK_PORTS')

export type BlockPickPorts = {
  /** Jev (`JEV_API_KEY`); absent = "Jev is down", so the page is treated as a vacancy. */
  readonly decision: DecisionPort | undefined
  /** The worker's `/pick-blocks` in the 30 s parse timeout (`buildBlockPicker`); absent = the 503. */
  readonly picker: BlockPicker | undefined
}

/** The ports from env. */
export function createBlockPickPorts(
  config: ConfigService<Env, true> | undefined,
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: FetchLike,
): BlockPickPorts {
  return {
    decision: createVacancyDecision(config, fetchImpl),
    picker: buildBlockPicker(rawEnv, {
      timeoutMs: PARSE_TIMEOUT_MS,
      ...(fetchImpl && { fetchImpl }),
    }),
  }
}

/**
 * The fields from the picked block ids, every character copied from a block (trimmed, cut to its
 * cap). Ids are positional and unchecked by the worker: an id off the map is dropped, a range is
 * normalised (reversed read forward) and clamped to the map, and a block two ranges share is used
 * once. A title or company in a nav or footer block is dropped.
 */
export function assemblePick(
  blocks: readonly PageBlock[],
  reply: BlockPickReply,
): { title?: string; company?: string; description?: string } {
  const last = blocks.length - 1
  const pickOne = (id: number | null): string | null => {
    const b = blocks[id ?? -1]
    return b === undefined || CHROME_REGIONS.has(b.r) ? null : b.t
  }
  const seen = new Set<number>()
  const parts: string[] = []
  for (const { from, to } of reply.description) {
    const hi = Math.min(Math.max(from, to), last)
    for (let i = Math.max(Math.min(from, to), 0); i <= hi; i++) {
      if (seen.has(i)) continue
      seen.add(i)
      parts.push(blocks[i]!.t)
    }
  }
  const title = field(pickOne(reply.title), MANUAL_TITLE_MAX)
  const company = field(pickOne(reply.company), MANUAL_COMPANY_MAX)
  const description = field(parts.join('\n\n'), DESCRIPTION_MD_MAX)
  return {
    ...(title && { title }),
    ...(company && { company }),
    ...(description && { description }),
  }
}

/** Contact-stripped text, re-cut: NFKC and the token can lengthen a text past the worker's cap. */
const stripped = (text: string, max: number) => stripContacts(text).text.slice(0, max)

/**
 * The worker body: every block, in page order (ids are positions), and the url and tab title,
 * contact-stripped here as well as in the worker. A url the strip changes into a non-URL is dropped.
 */
function pickBody(req: JobQueueBlockPickRequest): Omit<PickBlocksBody, 'tableVersion'> {
  const url =
    req.url === undefined
      ? undefined
      : pickBlocksBodySchema.shape.url.safeParse(stripContacts(req.url).text).data
  return {
    ...(url && { url }),
    tabTitle: stripped(req.tabTitle, TAB_TITLE_MAX),
    blocks: req.blocks.map((b) => ({ ...b, t: stripped(b.t, BLOCK_TEXT_MAX) })),
  }
}

/** The Jev gate's text: the content blocks joined, cut like the worker input. */
function gateText(blocks: readonly PageBlock[]): string {
  const content = blocks.filter((b) => CONTENT_REGIONS.has(b.r))
  return (content.length > 0 ? content : blocks)
    .map((b) => b.t)
    .join('\n\n')
    .slice(0, MANUAL_PARSE_TEXT_MAX)
}

/**
 * `POST /job-queue/manual/pick` (bookmarklet block map): the visible blocks the bookmarklet read in
 * the HR's own browser in; the vacancy fields out, copied verbatim from the blocks the worker's
 * model picked. Nothing is stored, and no text, url or title is logged — only counts and outcome.
 *
 * 1. The role and scope are re-checked here (`JobQueueScopeService.resolve`), before any model call.
 * 2. The shared Jev gate (`isVacancyText`) over the content blocks; not a vacancy is
 *    `{ isVacancy: false }` and no worker call.
 * 3. One `/pick-blocks` call with the contact-stripped map; an outage or an invalid reply is
 *    `JOB_QUEUE_PARSE_UNAVAILABLE` (503). A reply that picks nothing is `{ isVacancy: true }` with
 *    no field, so the form keeps the values it has.
 */
@Injectable()
export class BlockPickService {
  private readonly logger = new Logger(BlockPickService.name)

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueueScopeService) private readonly scopes: JobQueueScopeService,
    @Inject(BLOCK_PICK_PORTS) private readonly ports: BlockPickPorts,
  ) {}

  async pick(user: SessionUser, req: JobQueueBlockPickRequest): Promise<JobQueueBlockPickResponse> {
    const scope = await this.scopes.resolve(user, undefined, this.database.db)
    if (scope.kind === 'NONE') throw new ForbiddenException()
    const outcome = (o: string) => `block pick: blocks=${req.blocks.length} outcome=${o}`

    const unavailable = () => this.logger.warn('block pick: jev unavailable')
    if (!(await isVacancyText(this.ports.decision, gateText(req.blocks), unavailable))) {
      this.logger.log(outcome('NOT_VACANCY'))
      return { isVacancy: false }
    }
    const picker = this.ports.picker
    const picked = picker
      ? await picker(pickBody(req))
      : { ok: false as const, reason: 'NOT_CONFIGURED' }
    if (!picked.ok) {
      this.logger.warn(outcome(`UNAVAILABLE:${picked.reason}`))
      throw apiError('JOB_QUEUE_PARSE_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE)
    }
    const { title, company, description } = assemblePick(req.blocks, picked.reply)
    this.logger.log(outcome(title || company || description ? 'FILLED' : 'EMPTY'))
    return {
      isVacancy: true,
      ...(title && { title }),
      ...(company && { companyName: company }),
      ...(description && { descriptionMd: description }),
    }
  }
}
