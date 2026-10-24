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

const GH_HOST = /^(?:job-)?boards\.(?:eu\.)?greenhouse\.io$/
const GH_PATH = /^\/([a-z0-9][a-z0-9_-]*)\/jobs\/([0-9]+)(?:\/|$)/i
const GH_EMBED_PATH = /^\/embed\/job_app\/?$/
const NAME_ONLY = /^[a-z0-9][a-z0-9_-]*$/i
const DIGITS_ONLY = /^[0-9]+$/
const LEVER_HOST = /^jobs\.(?:eu\.)?lever\.co$/
const LEVER_PATH =
  /^\/([a-z0-9][a-z0-9_-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/apply)?\/?$/i
const ASHBY_HOST = /^jobs\.ashbyhq\.com$/
const ASHBY_PATH =
  /^\/([a-z0-9][a-z0-9_-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/application)?\/?$/i
const WORKABLE_HOST = /^apply\.workable\.com$/
const WORKABLE_PATH = /^\/([a-z0-9][a-z0-9_-]*)\/j\/([a-z0-9]{6,20})(?:\/apply)?\/?$/i
const SR_HOST = /^(?:jobs|careers)\.smartrecruiters\.com$/
const SR_PATH = /^\/([a-z0-9][a-z0-9_-]*)\/([0-9]+)(?:-[^/]*)?\/?$/i
const RECRUITEE_HOST = /^(?!www\.)([a-z0-9][a-z0-9_-]*)\.recruitee\.com$/
const RECRUITEE_PATH = /^\/o\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i
const PERSONIO_HOST = /^([a-z0-9][a-z0-9_-]*)\.jobs\.personio\.(?:de|com)$/
const PERSONIO_PATH = /^\/job\/([0-9]+)\/?$/

const VENDOR_HOSTS = [
  GH_HOST,
  LEVER_HOST,
  ASHBY_HOST,
  WORKABLE_HOST,
  SR_HOST,
  RECRUITEE_HOST,
  PERSONIO_HOST,
]

/** Capture groups of `re` on `text`, or null. Every group of every pattern above is mandatory. */
function groups(re: RegExp, text: string): string[] | null {
  const m = re.exec(text)
  return m === null ? null : (m.slice(1) as string[])
}

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

function hosted(host: string, path: string, query: URLSearchParams): AtsJobKey | null {
  if (GH_HOST.test(host)) {
    const m = groups(GH_PATH, path)
    if (m !== null) return make('greenhouse', m[0], m[1], 'ATS_HOSTED')
    const board = query.get('for') ?? ''
    const token = query.get('token') ?? ''
    if (GH_EMBED_PATH.test(path) && NAME_ONLY.test(board) && DIGITS_ONLY.test(token)) {
      return make('greenhouse', board, token, 'ATS_HOSTED')
    }
    return null
  }
  if (LEVER_HOST.test(host)) {
    const m = groups(LEVER_PATH, path)
    return m === null ? null : make('lever', m[0], m[1].toLowerCase(), 'ATS_HOSTED')
  }
  if (ASHBY_HOST.test(host)) {
    const m = groups(ASHBY_PATH, path)
    return m === null ? null : make('ashby', m[0], m[1].toLowerCase(), 'ATS_HOSTED')
  }
  if (WORKABLE_HOST.test(host)) {
    const m = groups(WORKABLE_PATH, path)
    return m === null ? null : make('workable', m[0], m[1].toUpperCase(), 'ATS_HOSTED')
  }
  if (SR_HOST.test(host)) {
    const m = groups(SR_PATH, path)
    return m === null ? null : make('smartrecruiters', m[0], m[1], 'ATS_HOSTED')
  }
  const recruitee = groups(RECRUITEE_HOST, host)
  if (recruitee !== null) {
    const m = groups(RECRUITEE_PATH, path)
    return m === null ? null : make('recruitee', recruitee[0], m[0].toLowerCase(), 'ATS_HOSTED')
  }
  const personio = groups(PERSONIO_HOST, host)
  if (personio !== null) {
    const m = groups(PERSONIO_PATH, path)
    return m === null ? null : make('personio', personio[0], m[0], 'ATS_HOSTED')
  }
  return null
}

export function atsJobKey(raw: string | null | undefined): AtsJobKey | null {
  const link = checkStoredLink(raw)
  if (!link.ok) return null
  const { hostname, pathname, searchParams } = link.url
  const found = hosted(hostname, pathname, searchParams)
  if (found !== null) return found

  // `gh_jid` on any other host: an employer page embedding a Greenhouse board. Scoped to the host
  // because the same number on another site is another job. A dotless host ("acme") is a legal URL
  // host but not an employer site, and would read like a board slug; the scope is also in the key
  // tuple, so the two can never collide.
  // A vendor host is never an "employer host": a URL it rejected stays rejected.
  const jid = searchParams.get('gh_jid') ?? ''
  return DIGITS_ONLY.test(jid) &&
    hostname.includes('.') &&
    !VENDOR_HOSTS.some((re) => re.test(hostname))
    ? make('greenhouse', hostname, jid, 'EMPLOYER_HOST')
    : null
}
