import type { ReportingJobSourceProvider } from '../reporting-provider'

/**
 * Working Nomads (`https://www.workingnomads.com/api/exposed_jobs/`) - a BLOCKED STUB with NO
 * fetch path.
 *
 * The plan blocks this source "until documented/approved use and an authentic fixture (public JSON
 * is not permission)". Neither exists:
 *  - (Read by an AI coding agent and a reviewing agent on 2026-10-24; not legal advice, no lawyer or
 *    owner has read them.) The Terms of Service (committed byte for byte as `__fixtures__/workingnomads/terms.html.txt`)
 *    have no clause on automated access, scraping, an API or reuse of listings, either way. The
 *    only mention of automation is "We do not use automated decision-making tools".
 *  - robots.txt allows everything, which is silence, not a grant.
 *  - The footer's "API" link goes to the JSON endpoint itself, not to documentation or terms.
 *  - So there is no authentic job fixture either: capturing one would have been using the data
 *    before being permitted to. The endpoint was read once, outside the repository, only to see
 *    what the footer link is.
 *
 * `parseConfig` therefore refuses EVERY config with a typed readiness error, and `collectReport`
 * refuses too, so even a hand-built config cannot reach a network. Lifting the block means an
 * owner decision or an answer from the site, then a real adapter with a real fixture - not a flag.
 */

export const WORKINGNOMADS_SOURCE_STATUS = {
  blocked: true,
  permission: 'UNCLEAR',
  reason:
    'blocked: no documented permission - the terms say nothing either way on automated access',
} as const

/** The source cannot be configured: it is not ready, and nothing about the config would change that. */
export class SourceBlockedError extends Error {
  readonly code = 'SOURCE_BLOCKED'
  constructor(
    readonly sourceType: string,
    readonly permission: string,
    readonly reason: string,
  ) {
    super(`${sourceType} ${reason}`)
    this.name = 'SourceBlockedError'
  }
}

const refuse = (): never => {
  throw new SourceBlockedError(
    'WORKINGNOMADS_API',
    WORKINGNOMADS_SOURCE_STATUS.permission,
    WORKINGNOMADS_SOURCE_STATUS.reason,
  )
}

export const workingNomadsProvider: ReportingJobSourceProvider = {
  type: 'WORKINGNOMADS_API',
  parseConfig: () => refuse(),
  collectReport: async () => refuse(),
}
