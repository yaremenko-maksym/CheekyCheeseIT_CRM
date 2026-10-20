/**
 * ONE corpus of URLs, run through all THREE guards that implement the
 * `https:`-only, host-required, no-credentials predicate:
 *
 *   * `shared` — `externalHttpsUrlSchema` (`./job-sourcing.ts`), spec in
 *     `job-sourcing.spec.ts`;
 *   * `web`    — `isSafeExternalUrl`, the last barrier before `window.open`
 *     (`apps/web/app/components/job-sourcing/open-original.ts`), test in
 *     `__tests__/open-original.test.ts`;
 *   * `check`  — the Postgres CHECK on every stored navigation URL
 *     (`HTTPS_URL_PATTERN` in `apps/api/src/database/schema/job-opportunities.ts`),
 *     run against a live server in `job-source-type-enum-ddl.integration.spec.ts`.
 *
 * WHY A CORPUS AND NOT PROSE. The three used to be "changed together" by a comment
 * on each, and one of those comments was already wrong (it still quoted the
 * pre-R11-H-4 `^https://\S+$`). A comment cannot fail; a row here can.
 *
 * ABSOLUTE VERDICTS, NOT AGREEMENT. Every row states what each guard must DO
 * (`accept` / `refuse`), so a test that passes proves a specific URL is refused —
 * not merely that the three guards agree. A parity check ("all three give the same
 * answer") passes when all three are weakened the same way; that is exactly the
 * failure R11-H-4 was, where all three accepted `https://user:pw@host/`.
 *
 * DIVERGENCE IS STATED, NOT OMITTED. The guards are equivalent for the security
 * property (https prefix, non-empty authority, no `@` in it) and NOT equivalent as a
 * whole. A row where one guard legitimately differs carries `differs.<guard>` with
 * the reason; an omitted row would be a divergence nobody is told about.
 * `locale-dependent` marks the one thing that cannot be pinned absolutely: the CHECK
 * uses the POSIX class `[:space:]`, whose membership for non-ASCII characters
 * depends on the server's libc and locale. Those rows are listed, with the
 * measured behaviour, and NOT asserted against the live server.
 *
 * Measured on PostgreSQL 16 (alpine/musl, en_US.utf8), Node 20/22, zod 4.
 */

export type ExternalUrlGuard = 'shared' | 'web' | 'check'
export type ExternalUrlVerdict = 'accept' | 'refuse'

export interface ExternalUrlDivergence {
  verdict: ExternalUrlVerdict | 'locale-dependent'
  reason: string
}

export interface ExternalUrlCase {
  name: string
  url: string
  /** What every guard must do, unless `differs` says otherwise for that guard. */
  verdict: ExternalUrlVerdict
  differs?: Partial<Record<ExternalUrlGuard, ExternalUrlDivergence>>
  /**
   * What `externalHttpsUrlSchema.parse` RETURNS, when it accepts and the value is
   * not echoed unchanged: zod's `.url()` runs the WHATWG parser's preprocessing
   * (strips leading/trailing C0 controls and space, removes tab/CR/LF anywhere)
   * before the refinement sees the value.
   */
  sharedParsed?: string
}

/** Resolve the verdict a guard must give for a row. */
export function expectedExternalUrlVerdict(
  row: ExternalUrlCase,
  guard: ExternalUrlGuard,
): ExternalUrlVerdict | 'locale-dependent' {
  return row.differs?.[guard]?.verdict ?? row.verdict
}

const HOST = 'https://host.test'

const WHATWG_ONLY =
  'WHATWG URL parsing refuses it (zod .url() / new URL); the CHECK is a shape-only POSIX regex and has no URL parser in SQL'

const SPACE_CLASS_LOCALE =
  'POSIX [:space:] membership for this non-ASCII character depends on the server libc/locale; JS \\s and the shared regex refuse it'

/** A URL of exactly `length` characters. */
function urlOfLength(length: number): string {
  const prefix = `${HOST}/`
  return prefix + 'a'.repeat(length - prefix.length)
}

export const EXTERNAL_URL_CORPUS: readonly ExternalUrlCase[] = [
  // ---- accepted everywhere ------------------------------------------------
  { name: 'plain https url', url: 'https://jobs.dou.ua/x/1', verdict: 'accept' },
  { name: 'bare host', url: HOST, verdict: 'accept' },
  { name: 'canonical form with kept params', url: `${HOST}/path?kept=params`, verdict: 'accept' },
  { name: '@ in the path', url: `${HOST}/a@b`, verdict: 'accept' },
  { name: '@ in the query', url: `${HOST}/jobs?ref=a@b`, verdict: 'accept' },
  { name: '@ in the fragment', url: `${HOST}/jobs#a@b`, verdict: 'accept' },
  { name: 'explicit port', url: `${HOST}:8443/a`, verdict: 'accept' },
  { name: 'upper-case scheme and host', url: 'HTTPS://HOST.TEST/x', verdict: 'accept' },
  { name: 'exactly 2048 characters', url: urlOfLength(2048), verdict: 'accept' },

  // ---- refused everywhere: scheme -----------------------------------------
  { name: 'javascript: url', url: 'javascript:alert(1)', verdict: 'refuse' },
  { name: 'data: url', url: 'data:text/html,<script>alert(1)</script>', verdict: 'refuse' },
  { name: 'http: url', url: 'http://host.test/x', verdict: 'refuse' },
  { name: 'ftp: url', url: 'ftp://host.test/x', verdict: 'refuse' },
  { name: 'relative path', url: '/relative/path', verdict: 'refuse' },
  { name: 'empty string', url: '', verdict: 'refuse' },
  { name: 'single slash after the scheme', url: 'https:/host.test/x', verdict: 'refuse' },
  {
    name: 'https url smuggled inside javascript:',
    url: 'javascript:https://evil.test/a',
    verdict: 'refuse',
  },
  {
    name: 'https url smuggled inside data:',
    url: 'data:text/html,https://host.test/a',
    verdict: 'refuse',
  },
  { name: 'https url after a newline', url: 'x\nhttps://evil.test/a', verdict: 'refuse' },

  // ---- refused everywhere: authority --------------------------------------
  { name: 'no authority at all', url: 'https://', verdict: 'refuse' },
  { name: 'empty authority before a path', url: 'https:///path', verdict: 'refuse' },
  { name: 'authority is only an @', url: 'https://@/a', verdict: 'refuse' },
  { name: 'empty userinfo', url: 'https://@host.test/a', verdict: 'refuse' },
  { name: 'user without password', url: 'https://user@host.test/a', verdict: 'refuse' },
  { name: 'user and password', url: 'https://user:pw@host.test/a', verdict: 'refuse' },
  { name: 'space in the authority', url: 'https://exa mple.com/x', verdict: 'refuse' },
  { name: 'authority is a space', url: 'https:// x', verdict: 'refuse' },
  { name: 'space in the path', url: `${HOST}/a b`, verdict: 'refuse' },

  // ---- legitimate divergence: WHATWG-unparseable --------------------------
  {
    name: 'empty host with a port',
    url: 'https://:443/a',
    verdict: 'refuse',
    differs: { check: { verdict: 'accept', reason: WHATWG_ONLY } },
  },
  {
    name: 'port out of range',
    url: 'https://h.test:99999/a',
    verdict: 'refuse',
    differs: { check: { verdict: 'accept', reason: WHATWG_ONLY } },
  },
  {
    name: 'percent-encoded @ in the host',
    url: 'https://a%40b.test/',
    verdict: 'refuse',
    differs: { check: { verdict: 'accept', reason: WHATWG_ONLY } },
  },
  {
    name: 'C0 control character in the host',
    url: 'https://ho\u0001st.test/a',
    verdict: 'refuse',
    differs: { check: { verdict: 'accept', reason: WHATWG_ONLY } },
  },

  // ---- legitimate divergence: length --------------------------------------
  {
    name: '2049 characters',
    url: urlOfLength(2049),
    verdict: 'accept',
    differs: {
      shared: { verdict: 'refuse', reason: 'only the shared schema carries .max(2048)' },
    },
  },

  // ---- legitimate divergence: ASCII whitespace the WHATWG parser strips ---
  ...(
    [
      ['tab in the authority', 'https://ho\tst.test/a', 'https://host.test/a'],
      ['CR in the authority', 'https://ho\rst.test/a', 'https://host.test/a'],
      ['LF in the authority', 'https://ho\nst.test/a', 'https://host.test/a'],
      ['tab in the path', `${HOST}/a\tb`, `${HOST}/ab`],
      ['CR in the path', `${HOST}/a\rb`, `${HOST}/ab`],
      ['LF in the path', `${HOST}/a\nb`, `${HOST}/ab`],
    ] as const
  ).map(([name, url, sharedParsed]): ExternalUrlCase => ({
    name,
    url,
    verdict: 'refuse',
    sharedParsed,
    differs: {
      shared: {
        verdict: 'accept',
        reason:
          'zod .url() strips tab/CR/LF before the refinement runs, so the schema accepts and RETURNS the stripped value; the raw string is never what is stored',
      },
    },
  })),

  // ---- legitimate divergence: surrounding whitespace ----------------------
  ...(
    [
      ['leading space', ` ${HOST}/a`, `${HOST}/a`],
      ['trailing space', `${HOST}/a `, `${HOST}/a`],
      ['trailing tab', `${HOST}/a\t`, `${HOST}/a`],
      ['trailing LF', `${HOST}/a\n`, `${HOST}/a`],
      ['leading NBSP', ` ${HOST}/a`, `${HOST}/a`],
      ['leading BOM', `﻿${HOST}/a`, `${HOST}/a`],
    ] as const
  ).map(([name, url, sharedParsed]): ExternalUrlCase => ({
    name,
    url,
    verdict: 'refuse',
    sharedParsed,
    differs: {
      shared: {
        verdict: 'accept',
        reason: 'zod .url() trims before the refinement; parse returns the trimmed value',
      },
      web: {
        verdict: 'accept',
        reason: 'isSafeExternalUrl trims and openOriginalPosting opens the TRIMMED string',
      },
    },
  })),

  // ---- legitimate divergence: non-ASCII whitespace, locale-dependent ------
  ...(
    [
      ['NBSP in the path', `${HOST}/a b`],
      ['U+1680 in the path', `${HOST}/a b`],
      ['U+202F in the path', `${HOST}/a b`],
      ['BOM in the path', `${HOST}/a﻿b`],
      ['U+2028 in the path', `${HOST}/a b`],
      ['NBSP in the authority', 'https://ho st.test/a'],
    ] as const
  ).map(([name, url]): ExternalUrlCase => ({
    name,
    url,
    verdict: 'refuse',
    differs: { check: { verdict: 'locale-dependent', reason: SPACE_CLASS_LOCALE } },
  })),
  {
    name: 'U+0085 in the path',
    url: `${HOST}/a\u0085b`,
    verdict: 'accept',
    differs: {
      check: {
        verdict: 'locale-dependent',
        reason:
          'JS \\s does not include U+0085, but the server treats it as [:space:] here; membership depends on libc/locale',
      },
    },
  },
]
