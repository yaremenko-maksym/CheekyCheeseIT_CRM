import { encodeIdentityTuple } from '../normalize/identity-key'
import { checkStoredLink } from '../normalize/url-policy'

/**
 * `atsJobKey(url)`: the provider-issued job identity carried by a posting or application URL, read
 * from the URL text alone. No network and no redirect following: a tracking or redirect wrapper is
 * not an ATS URL and yields null, however plainly it embeds one. Reuses the stored-link policy
 * (HTTPS only, no userinfo, no ports, no IP literals), so a URL we would refuse to store is never
 * an identity either.
 */

/** Bump when the key layout changes: old and new keys must never be comparable by accident. */
export const ATS_KEY_VERSION = 'ats1'

export type AtsProvider =
  'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee' | 'personio'

/**
 * ATS_HOSTED: the host is the ATS vendor's, so the namespace is the vendor-issued board/account.
 * EMPLOYER_HOST: the job id came from a parameter (`gh_jid`) on an arbitrary host; it identifies a
 * job only on that host, and nothing here can verify the host is the employer's.
 */
export type AtsKeyScope = 'ATS_HOSTED' | 'EMPLOYER_HOST'

export interface AtsJobKey {
  provider: AtsProvider
  /** Lowercased board / account / host. */
  namespace: string
  /** Provider-issued job id in its canonical case. */
  jobId: string
  scope: AtsKeyScope
  /** Canonical JSON tuple; equal keys = the same job at the same provider namespace. */
  key: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGITS = /^[0-9]+$/
/** One DNS label / path segment worth of account name. */
const ACCOUNT = /^[a-z0-9][a-z0-9_-]{0,99}$/i
const SHORTCODE = /^[a-z0-9]{6,20}$/i
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/i

function make(
  provider: AtsProvider,
  namespace: string,
  jobId: string,
  scope: AtsKeyScope,
): AtsJobKey {
  const ns = namespace.toLowerCase()
  return {
    provider,
    namespace: ns,
    jobId,
    scope,
    key: encodeIdentityTuple([ATS_KEY_VERSION, provider, scope, ns, jobId]),
  }
}

/** Path segments with empty ones dropped (trailing/double slashes are not information). */
const segments = (path: string): string[] => path.split('/').filter((s) => s.length > 0)

function greenhouse(host: string, url: URL, parts: string[]): AtsJobKey | null {
  const [p0 = '', p1 = '', p2 = ''] = parts
  if (
    host === 'boards.greenhouse.io' ||
    host === 'job-boards.greenhouse.io' ||
    host === 'boards.eu.greenhouse.io' ||
    host === 'job-boards.eu.greenhouse.io'
  ) {
    if (parts.length >= 3 && p1 === 'jobs' && ACCOUNT.test(p0) && DIGITS.test(p2)) {
      return make('greenhouse', p0, p2, 'ATS_HOSTED')
    }
    const board = url.searchParams.get('for')
    const token = url.searchParams.get('token')
    if (
      parts.length === 2 &&
      p0 === 'embed' &&
      p1 === 'job_app' &&
      board &&
      token &&
      ACCOUNT.test(board) &&
      DIGITS.test(token)
    ) {
      return make('greenhouse', board, token, 'ATS_HOSTED')
    }
    return null
  }
  return null
}

const LEVER_HOSTS = new Set(['jobs.lever.co', 'jobs.eu.lever.co'])
const ASHBY_HOSTS = new Set(['jobs.ashbyhq.com'])

/** `<account>/<uuid>[/apply|/application]` on a fixed-host ATS. */
function accountUuid(provider: 'lever' | 'ashby', parts: string[], tail: string): AtsJobKey | null {
  const [account = '', id = '', suffix] = parts
  if (parts.length < 2 || parts.length > 3) return null
  if (parts.length === 3 && suffix !== tail) return null
  if (!ACCOUNT.test(account) || !UUID.test(id)) return null
  return make(provider, account, id.toLowerCase(), 'ATS_HOSTED')
}

function workable(parts: string[]): AtsJobKey | null {
  // /<account>/j/<SHORTCODE>[/apply]
  const [account = '', j, code = '', suffix] = parts
  if (parts.length < 3 || parts.length > 4 || j !== 'j') return null
  if (parts.length === 4 && suffix !== 'apply') return null
  if (!ACCOUNT.test(account) || !SHORTCODE.test(code)) return null
  return make('workable', account, code.toUpperCase(), 'ATS_HOSTED')
}

function smartRecruiters(parts: string[]): AtsJobKey | null {
  // /<Company>/<numeric id>[-slug]
  const [account = '', last = ''] = parts
  if (parts.length !== 2 || !ACCOUNT.test(account)) return null
  const id = /^([0-9]+)(?:-.*)?$/.exec(last)?.[1]
  return id === undefined ? null : make('smartrecruiters', account, id, 'ATS_HOSTED')
}

function subdomainOf(host: string, suffix: string): string | null {
  if (!host.endsWith(`.${suffix}`)) return null
  const sub = host.slice(0, host.length - suffix.length - 1)
  return ACCOUNT.test(sub) && sub !== 'www' ? sub : null
}

function recruitee(host: string, parts: string[]): AtsJobKey | null {
  const account = subdomainOf(host, 'recruitee.com')
  const [o, slug = ''] = parts
  if (account === null || parts.length < 2 || o !== 'o' || !SLUG.test(slug)) return null
  return make('recruitee', account, slug.toLowerCase(), 'ATS_HOSTED')
}

function personio(host: string, parts: string[]): AtsJobKey | null {
  const account = subdomainOf(host, 'jobs.personio.de') ?? subdomainOf(host, 'jobs.personio.com')
  const [job, id = ''] = parts
  if (account === null || parts.length !== 2 || job !== 'job' || !DIGITS.test(id)) return null
  return make('personio', account, id, 'ATS_HOSTED')
}

export function atsJobKey(raw: string | null | undefined): AtsJobKey | null {
  const link = checkStoredLink(raw)
  if (!link.ok) return null
  const url = link.url
  const host = url.hostname.toLowerCase()
  const parts = segments(url.pathname)

  const hosted =
    greenhouse(host, url, parts) ??
    (LEVER_HOSTS.has(host) ? accountUuid('lever', parts, 'apply') : null) ??
    (ASHBY_HOSTS.has(host) ? accountUuid('ashby', parts, 'application') : null) ??
    (host === 'apply.workable.com' ? workable(parts) : null) ??
    (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com'
      ? smartRecruiters(parts)
      : null) ??
    recruitee(host, parts) ??
    personio(host, parts)
  if (hosted !== null) return hosted

  // `gh_jid` on any other host: an employer page embedding a Greenhouse board. Scoped to the host
  // because the same number on another site is another job.
  const jid = url.searchParams.get('gh_jid')
  // A dotless host ("acme") is a legal URL host but not an employer site, and would read like a
  // board slug; the scope is also in the key tuple, so the two can never collide.
  if (jid !== null && DIGITS.test(jid) && host.includes('.')) {
    return make('greenhouse', host, jid, 'EMPLOYER_HOST')
  }
  return null
}
