import type { DecisionPort, FetchLike } from '@crm/inference'
import {
  BLOCK_TEXT_MAX,
  DESCRIPTION_MD_MAX,
  MANUAL_COMPANY_MAX,
  MANUAL_PARSE_TEXT_MAX,
  MANUAL_TITLE_MAX,
  TAB_TITLE_MAX,
  type JobQueueBlockPickRequest,
  type JobQueueBlockPickResponse,
  type PageBlock,
  type SessionUser,
} from '@crm/shared'
import { ForbiddenException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { domainToUnicode } from 'node:url'
import type { ConfigService } from '@nestjs/config'
import { sql } from 'drizzle-orm'
import { apiError } from '../../common/api-error'
import type { Env } from '../../config/env'
import { DatabaseService } from '../../database/database.service'
import {
  pickBlocksBodySchema,
  type BlockPickReply,
  type PickBlocksBody,
} from '../../extraction-worker/link-contract'
import {
  redactContacts,
  scanContacts,
  type ContactContext,
} from '../../resumes/verification/contact-scan'
import { stripContacts } from '../structuring/contact-strip'
import { buildBlockPicker, type BlockPicker } from '../structuring/model-extraction-wiring'
import {
  createVacancyDecision,
  field,
  isVacancyText,
  PARSE_TIMEOUT_MS,
} from './manual-parse.service'
import { JobQueueScopeService } from './queue-scope.service'

/** A title or company in these regions is site chrome, never the posting's. */
const CHROME_REGIONS: ReadonlySet<PageBlock['r']> = new Set(['nav', 'footer'])
/**
 * Site chrome, as the bookmarklet's `CHROME`: never copied into a description, and cut to a line
 * for the worker (it carries the HR's own name on a logged-in site). A posting's own `<header>`
 * still gives the title, so the title and company keep `CHROME_REGIONS`.
 */
const SITE_CHROME: ReadonlySet<PageBlock['r']> = new Set(['nav', 'header', 'footer'])
/** The bookmarklet's `CHROME_TEXT_MAX`, mirrored here: the worker gets one line of site chrome. */
const CHROME_TEXT_MAX = 80
/** A display name shorter than this is not redacted: it would hit ordinary words. */
const NAME_MIN = 3
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
 * once. A title or company in a nav or footer block is dropped; a description never copies a nav,
 * header or footer block.
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
      if (seen.has(i) || SITE_CHROME.has(blocks[i]!.r)) continue
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

/**
 * The worker's url: origin and path only (a query or fragment carries tracking ids), contact-stripped.
 * A url naming the viewer (raw, percent-decoded or in the Unicode host form), a path that does not
 * decode, or a url the strip turns into a non-URL, is dropped.
 */
function workerUrl(raw: string, viewer: ContactContext): string | undefined {
  const { origin, host, hostname, pathname } = new URL(raw)
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const url = stripContacts(origin + pathname).text
  // Host and path apart: scanned whole, the url is one URL hit and no name inside it is reported.
  const forms = `${host} ${domainToUnicode(hostname)} ${pathname} ${decoded}`
  const named = scanContacts(forms, viewer).some((hit) => hit.kind === 'name')
  return named ? undefined : pickBlocksBodySchema.shape.url.safeParse(url).data
}

/**
 * The worker body: every block, in page order (ids are positions), and the url and tab title. All
 * contact-stripped here as well as in the worker, with the viewer's own name redacted, then re-cut
 * (NFKC and the tokens can lengthen a text past the worker's cap); site chrome is cut to one line.
 * `req` itself is untouched: the fields are copied from it, not from this copy.
 */
function pickBody(
  req: JobQueueBlockPickRequest,
  viewer: ContactContext,
): Omit<PickBlocksBody, 'tableVersion'> {
  const hide = (text: string, max: number) =>
    redactContacts(stripContacts(text).text, viewer).slice(0, max)
  const url = req.url === undefined ? undefined : workerUrl(req.url, viewer)
  return {
    ...(url && { url }),
    tabTitle: hide(req.tabTitle, TAB_TITLE_MAX),
    blocks: req.blocks.map((b) => ({
      ...b,
      t: hide(b.t, SITE_CHROME.has(b.r) ? CHROME_TEXT_MAX : BLOCK_TEXT_MAX),
    })),
  }
}

/**
 * The Jev gate's text: the content blocks joined, the viewer's name redacted (a page with no
 * content block falls back to every block, the header that names the HR included), then cut like
 * the worker input.
 */
function gateText(blocks: readonly PageBlock[], viewer: ContactContext): string {
  const content = blocks.filter((b) => CONTENT_REGIONS.has(b.r))
  const joined = (content.length > 0 ? content : blocks).map((b) => b.t).join('\n\n')
  return redactContacts(joined, viewer).slice(0, MANUAL_PARSE_TEXT_MAX)
}

/**
 * `POST /job-queue/manual/pick` (bookmarklet block map): the visible blocks the bookmarklet read in
 * the HR's own browser in; the vacancy fields out, copied verbatim from the blocks the worker's
 * model picked. Nothing is stored, and no text, url or title is logged — only counts and outcome.
 *
 * 1. The role and scope are re-checked here (`JobQueueScopeService.resolve`), before any model call.
 * 2. The shared Jev gate (`isVacancyText`) over the content blocks; not a vacancy is
 *    `{ isVacancy: false }` and no worker call.
 * 3. One `/pick-blocks` call with the contact-stripped map, the HR's own display name (read from
 *    `users`: the session carries none) redacted; an outage or an invalid reply is
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

    const viewer = await this.viewer(user)
    const unavailable = () => this.logger.warn('block pick: jev unavailable')
    if (!(await isVacancyText(this.ports.decision, gateText(req.blocks, viewer), unavailable))) {
      this.logger.log(outcome('NOT_VACANCY'))
      return { isVacancy: false }
    }
    const picker = this.ports.picker
    const picked = picker
      ? await picker(pickBody(req, viewer))
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

  /**
   * The viewer as a redaction context: `users.display_name` by id, since the request's user is the
   * JWT payload, which carries no name. No row or a name under `NAME_MIN` redacts no name.
   * `surnameFirst` makes the first part redact alone as well as the last: `display_name` order is
   * not known, and each part alone still names the HR.
   */
  private async viewer(user: SessionUser): Promise<ContactContext> {
    const { rows } = await this.database.db.execute(
      // Stryker disable next-line StringLiteral: the query text is a DB fact a unit double cannot see; job-queue-rbac.integration.spec.ts reads the seeded users.display_name through it and fails if the name reaches the worker
      sql`SELECT display_name FROM users WHERE id = ${user.id}`,
    )
    const stored = rows[0]?.['display_name']
    const name = typeof stored === 'string' ? stored.trim() : undefined
    // Stryker disable next-line StringLiteral,ArrayDeclaration: equivalent — an unused name only has to match nothing (a blank one yields no pattern), and the e-mails are already stripped
    return {
      fullName: name !== undefined && name.length >= NAME_MIN ? name : '',
      emails: [],
      surnameFirst: true,
    }
  }
}
