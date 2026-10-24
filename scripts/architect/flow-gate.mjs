#!/usr/bin/env node
// Flow Gate — the project's development flow is the default for every PR; skipping a step is a
// deliberate, recorded act.
//
// Why. On 2026-10-21 an audit found that every PR merged by a second collaborator reached `main`
// with zero reviews, although each touched a critical-path zone. The flow (task → plan → tests →
// review → security/spec/copy review → QA/design → AC) existed only as procedure inside the
// owner's Master pipeline, which another harness (Codex, a person at a keyboard) never runs. The
// owner's decision: the flow is the default for EVERYONE — owner, collaborator, any harness — and
// a step may be skipped only by a named line in the PR body that says why.
//
// What this is NOT: a defence against a malicious write-role user. Anyone with write access can
// post a review that says `Verdict: APPROVE`, or write a `Skip-<Step>:` line. The point is that
// every skipped step leaves a visible, attributable record instead of silence. Three cheap guards
// are kept because they cost nothing to the honest flow: verdicts count only from accounts with
// a repository association (OWNER / MEMBER / COLLABORATOR — the repo is public, and any GitHub
// user can comment), both names of a renamed file are classified, and a PR the API could not list
// in full fails instead of being judged on the part that was read.
//
// Each step is either satisfied by EVIDENCE or skipped by a PR-body line `Skip-<Step>: <reason>`
// (key case-insensitive, reason at least MIN_REASON_LENGTH characters). One exemption: a docs-only
// diff (every changed path, and every rename source, ends in `.md`) passes outright — the
// light-track rule. Non-markdown files under `.claude/` (hooks, settings, scripts) are executable
// process config, not documentation: they go through the steps, and hooks/settings are critical.
// The step table is STEPS below; the contract is `.claude/agents/contracts.md` §4.1.
//
// A verdict is pinned to the commit it was given on: a positive verdict on an older commit reads
// STALE, not `done`, unless everything that landed since is an INERT path (`isInertDoc` — an
// allowlist, not "it ends in .md") or belongs to files this PR does not own. See "Verdict
// freshness" below — that section carries the reasoning, the two exemptions and what was rejected.
//
// The decision is a pure function (`evaluate`); the CLI only reads a JSON file and prints.
// Tests: scripts/architect/flow-gate.test.mjs. Wiring: .github/workflows/flow-gate.yml.
//
// Usage:  node scripts/architect/flow-gate.mjs --input <pr-data.json> [--summary <file>]
//         node scripts/architect/flow-gate.mjs --compare-plan --input <pr-data.json>
// Exit:   0 PASS · 1 FAIL · 2 malformed input (never 0 on input it could not read)

import { readFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MIN_REASON_LENGTH = 10

// ---------------------------------------------------------------------------------------------
// Path classes

// Glob → anchored RegExp. `*` stays within one segment; a double star followed by a slash spans
// zero or more whole segments; a trailing double star matches everything below.
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
    } else if (glob[i] === '*') {
      re += '[^/]*'
      i += 1
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${re}$`)
}

const matcher = (globs) => {
  const res = globs.map(globToRegExp)
  return (path) => res.some((re) => re.test(path))
}

// Critical-path zones — derived from `.claude/agents/contracts.md` §2.1 (the canonical table; when
// it changes, change this list). Every glob was checked against the tree on 2026-10-21 rather
// than guessed: there is no `transactions/`, `wallet*/`, `company-account/` or `rbac/` DIRECTORY in
// the API — transactions and the company account are files inside `finance/`, RBAC lives in
// `common/guards/roles.guard.ts`, `*-visibility.util.ts`, `*rbac*.util.ts`, `users/role-guards.util.ts`
// — so those zones are matched by file-name globs, which keep matching if such a directory appears.
// Migrations are `apps/api/drizzle/**` (there is no `migrations/` directory in the product).
export const CRITICAL_PATH_GLOBS = Object.freeze([
  // auth / sessions / JWT / OAuth
  'apps/api/src/**/auth/**',
  '**/*.guard.ts',
  // finance / calculation logic / split math / rates
  'apps/api/src/**/finance/**',
  'packages/shared/src/**/finance/**',
  // wallets / transactions / company-account (USDT)
  'apps/api/src/**/*transaction*',
  'apps/api/src/**/*transaction*/**',
  'apps/api/src/**/*wallet*',
  'apps/api/src/**/*company-account*',
  // RBAC / role visibility / data masking
  'apps/api/src/**/*rbac*',
  'apps/api/src/**/*visibility*',
  'apps/api/src/**/*role*',
  'apps/api/src/database/privileges/**',
  'apps/api/src/database/*privilege*',
  'packages/shared/src/schemas/view-permissions.ts',
  'packages/shared/src/types/roles.ts',
  // Drizzle migrations / new tables
  'apps/api/drizzle/**',
  'apps/api/drizzle.config.ts',
  '**/schema.ts',
  'apps/api/src/database/schema/**',
  // webhooks (signature verification is an auth surface)
  '**/*webhook*',
  // CI/CD pipeline, the agent-process hooks and their registration, and this gate itself — each
  // of them gates the whole process
  '.github/workflows/**',
  '.claude/hooks/**',
  '.claude/settings*.json',
  'scripts/architect/flow-gate*',
])

// User-visible text catalogs (measured): the Lingui catalogs and the landing's own dictionaries.
export const COPY_GLOBS = Object.freeze([
  'packages/shared/src/i18n/locales/**',
  'apps/landing/app/i18n/dictionaries/**',
])

export const isCritical = matcher(CRITICAL_PATH_GLOBS)
export const isCopy = matcher(COPY_GLOBS)
/** Documentation is markdown — nothing else, wherever it lives. */
export const isDoc = (p) => p.endsWith('.md')
/**
 * A path a FOLLOW-UP commit may change without invalidating a verdict (`verdictFreshness`).
 *
 * Named for the property, not the file type: the question is never "is this a document" but
 * "**can changing this change behaviour**". In this repository most markdown can. `CLAUDE.md` is
 * loaded into every session; `CONTEXT.md` is the glossary review findings are judged against;
 * `.claude/rules/common/*.md` are auto-loaded; `.claude/agents/*.md`, `skills/**`, `agents/**` and
 * `docs/superpowers/**` are agent prompts; `docs/runbooks/**` are procedures agents follow;
 * `docs/architecture/rules-rationale/**` is read on demand to decide what a live rule means; and
 * `.github/pull_request_template.md` decides whether a `Skip-*` line counts at all — this gate's
 * own test reads that file. Instructions-as-behaviour is the norm here, not the exception.
 *
 * SO THIS IS AN ALLOWLIST, AND THE REASON IS THE ASYMMETRY OF BEING WRONG (SR-M-3):
 *   - a missing DENYLIST entry silently exempts behaviour from review — nobody finds out;
 *   - a missing ALLOWLIST entry costs one unnecessary review round — the author sees it at once
 *     and says so.
 * One failure mode is silent and unbounded, the other loud and cheap. When a rule's two error
 * directions are that unequal, the rule goes the way where mistakes announce themselves. The first
 * edition of this function was a denylist and exempted `CLAUDE.md`; the inventory that followed
 * found `agents/**`, `skills/**`, `hooks/**` and `docs/superpowers/**` at the repository root too,
 * none of which a denylist would plausibly have enumerated.
 *
 * Inert, verified against `git ls-tree -r --name-only origin/main` on 2026-10-24 (438 `.md` files):
 *   - `docs/architecture/<YYYY-MM-DD>-*.md` — a DATED record of a decision already taken (ADR,
 *     deliverable, RCA). All 42 flat files there are dated, and requiring the date is what keeps
 *     `rules-rationale/**` and `ecc-reference/**` (upstream `RULES`/`AGENTS` copies an architect
 *     reads before adapting a pattern) out by construction rather than by a subtracted clause.
 *   - `docs/business/**` — product and process documentation.
 *   - `README.md` at the repository root, and nowhere else.
 *
 * `docs/business/**` is the one judgement call in that list and the weakest member: it is read when
 * the NEXT task is written, not consumed by an agent executing this one. If it proves wrong, the
 * cost is a documentation change merging without a second look, not code. Everything else — every
 * root-level instruction file, all of `.claude/**`, `docs/runbooks/**`, `docs/design/**`,
 * `docs/legal/**` — takes a fresh review pass.
 *
 * This does NOT touch `isDocsOnly`, the pre-existing WHOLE-PR docs exemption, which still goes by
 * extension alone. That is not an inconsistency: there the reviewers the flow requires are looking
 * at the diff in front of them, where here the verdict is inherited from a review of other code.
 */
export const isInertDoc = (p) =>
  isDoc(p) &&
  (/^docs\/architecture\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(p) ||
    p.startsWith('docs/business/') ||
    p === 'README.md')
// `__test-helpers__/` is a tracked test-support directory (15 files under apps/api on 2026-10-21);
// `__mocks__/` is deliberately absent — no such directory exists in the repo.
export const isTestFile = (p) =>
  /\.(spec|test)\.[cm]?[jt]sx?$/.test(p) ||
  p.includes('/__tests__/') ||
  p.includes('/__test-helpers__/') ||
  p.startsWith('apps/e2e/')
/**
 * Non-test product CODE: a `.ts/.tsx/.js/.jsx/.mjs/.cjs` file under apps/ or packages/ that is not
 * a test file. package.json, i18n catalogs, CSS and assets are not code — they do not require a
 * test change (the Tests step).
 */
export const isProductCode = (p) =>
  (p.startsWith('apps/') || p.startsWith('packages/')) &&
  /\.(?:[cm]?js|jsx|ts|tsx)$/.test(p) &&
  !isTestFile(p)
export const isUiCode = (p) =>
  (p.startsWith('apps/web/') || p.startsWith('apps/landing/')) &&
  !isTestFile(p) &&
  !p.endsWith('.md')

export function isDocsOnly(paths) {
  return paths.length > 0 && paths.every(isDoc)
}

// Repository associations whose verdicts count. The repo is public: any GitHub user can post a
// comment or a COMMENT review, so `NONE` / `CONTRIBUTOR` / `FIRST_TIMER` etc. are ignored — both
// their positive and their negative verdicts. The PR author is NOT excluded: the owner's review
// agents post under the owner's account, and the owner authors his own PRs.
export const TRUSTED_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR'])
const trusted = (it) => TRUSTED_ASSOCIATIONS.includes(it.association)

// The REST lists cap out: pulls/files at 3000 entries, pulls/commits at 250.
export const MAX_LISTED_FILES = 3000
export const MAX_LISTED_COMMITS = 250

// Drift measurements (see "Verdict freshness"). The workflow fetches one `compare` per reference
// sha, so the count is bounded here; above the cap the uncovered verdicts read as unmeasured, and
// unmeasured is STALE. `compare` returns at most 300 files and gives no total, so a list at the
// limit is treated as truncated rather than as a complete answer.
export const MAX_COMPARES = 10
export const MAX_COMPARE_FILES = 300

/** Normalise the pulls/files list: entries + every path to classify (current AND rename source). */
export function normalizeFiles(files) {
  const entries = files.map((f) =>
    typeof f === 'string' ? { filename: f, previous_filename: null, status: 'modified' } : f,
  )
  const paths = []
  for (const e of entries) {
    paths.push(e.filename)
    // A rename moves a file OUT of somewhere: the source path must be judged too, or renaming
    // `apps/api/src/auth/x.ts` to `notes/x.md` would read as docs-only and non-critical.
    if (e.previous_filename) paths.push(e.previous_filename)
  }
  return { entries, paths }
}

/** Fail-closed completeness: did the fetch list the whole PR? Returns a problem or null. */
export function completenessProblem(pr, entries) {
  const want = pr.counts ?? {}
  const issues = []
  // Freshness is decided by comparing a verdict's commit against the head, so a head missing from
  // the list makes every verdict read as "given on something not in the PR" — or, worse, lets a
  // stated sha equal a head nothing corroborates. An absent head fails here instead.
  if (!pr.commits.some((c) => String(c.sha) === pr.headSha))
    issues.push(`the PR head ${short(pr.headSha)} is not among the listed commits`)
  if (typeof want.changedFiles !== 'number' || typeof want.commits !== 'number') {
    issues.push("the PR's own file/commit counts were not provided")
  } else {
    if (want.changedFiles >= MAX_LISTED_FILES)
      issues.push(
        `the PR changes ${want.changedFiles} files — the API lists at most ${MAX_LISTED_FILES}`,
      )
    else if (entries.length !== want.changedFiles)
      issues.push(`listed ${entries.length} changed files, the PR reports ${want.changedFiles}`)
    if (want.commits >= MAX_LISTED_COMMITS)
      issues.push(
        `the PR has ${want.commits} commits — the API lists at most ${MAX_LISTED_COMMITS}`,
      )
    else if (pr.commits.length !== want.commits)
      issues.push(`listed ${pr.commits.length} commits, the PR reports ${want.commits}`)
  }
  return issues.length
    ? `Completeness — could not read the whole PR (${issues.join('; ')}). Split the PR, or re-run the check (push, body edit or label); a skip line cannot cover a PR that was not read.`
    : null
}

// ---------------------------------------------------------------------------------------------
// Non-prose stripping
//
// Text that is not stated by the author must not count: an HTML comment (the PR template keeps
// every `Skip-*:` line inside one, at column 0) and a fenced code block (a quoted example). Both
// the PR body and every review/comment body go through this before any line is read. An
// unterminated comment or fence swallows the rest of the text — fail closed: an unclosed block
// is not a statement either.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

export function stripNonProse(text) {
  const noComments = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/, '')
  const out = []
  let fence = null // the opening run (e.g. "```" or "~~~~") while inside a fenced block
  for (const line of noComments.split(/\r?\n/)) {
    const m = FENCE_RE.exec(line)
    if (fence) {
      if (
        m &&
        m[1][0] === fence[0] &&
        m[1].length >= fence.length &&
        !line.slice(m[0].length).trim()
      )
        fence = null
      continue
    }
    if (m) {
      fence = m[1]
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// PR-body lines

const lineRe = (key) =>
  new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${key.replace(/-/g, '\\-')}:[ \\t]*(.*)$`, 'im')

/**
 * The value of a `Key: value` line in the PR body (trimmed), or null when there is no such line.
 * Lines inside HTML comments and fenced code blocks are not read (stripNonProse).
 */
export function bodyLine(body, key) {
  const m = lineRe(key).exec(stripNonProse(body))
  return m ? m[1].trim() : null
}

/**
 * A template placeholder such as `<why there is no plan>` is not a reason. The template's hint
 * lines carry a trailing `(required when …)` parenthetical after the slot, so anything that
 * starts with `<` and still holds a `>` is the unedited slot.
 */
export const isPlaceholder = (value) => /^<.*>/.test(String(value ?? '').trim())

// ---------------------------------------------------------------------------------------------
// Verdict markers

// A verdict is stated on its own line — by contract the first line of the review
// (`code-review-discipline` §1, `contracts.md` §4). Markdown decoration (`**…**`, `## …`)
// is tolerated; a quoted line (`> …`), a fenced block and an HTML comment are not read; for each marker kind the FIRST matching line of a body is its verdict, so a body
// that later quotes an earlier verdict cannot flip it, and a verdict mid-sentence is no marker.
export const MARKERS = Object.freeze({
  review: { prefix: 'Verdict', pos: ['APPROVE'], neg: ['BLOCK'] },
  security: { prefix: 'Security Review', pos: ['APPROVE'], neg: ['BLOCK'] },
  spec: { prefix: 'Spec Review', pos: ['PASS'], neg: ['ISSUES', 'BLOCK'] },
  copy: { prefix: 'Copy Review', pos: ['PASS'], neg: ['ISSUES', 'BLOCK'] },
  qa: { prefix: 'QA Verdict', pos: ['PASS'], neg: ['FAIL'] },
  // ui-ux-designer.md posts `Design Review: PASS | POLISH-REQUESTED | BLOCK`; APPROVE is accepted
  // as a synonym because the first draft of this contract used it.
  design: { prefix: 'Design Review', pos: ['PASS', 'APPROVE'], neg: ['POLISH-REQUESTED', 'BLOCK'] },
})

/**
 * The lines of a body that are the author's own statements, each normalised so a leading `##` or a
 * `**bold**` wrapper does not hide the key. A quoted line (`> …`) is someone else's text being
 * cited, and a line inside a fenced block or an HTML comment is an example — none of the three is a
 * statement. Shared by `parseMarker` and `statedCommit`: a verdict and the sha it was given on are
 * read under one rule, and that rule has one implementation.
 */
export function proseLines(text) {
  const out = []
  for (const raw of stripNonProse(text).split(/\r?\n/)) {
    if (/^\s*>/.test(raw)) continue
    out.push(raw.replace(/^[\s#*_`-]+/, '').replace(/[*_`]+/g, ''))
  }
  return out
}

export function parseMarker(body, kind) {
  const { prefix, pos, neg } = MARKERS[kind]
  const values = [...pos, ...neg].sort((a, b) => b.length - a.length)
  const re = new RegExp(`^${prefix}:\\s*(${values.join('|')})(?![A-Z-])`)
  for (const line of proseLines(body)) {
    const m = re.exec(line)
    if (m) return pos.includes(m[1]) ? 'pos' : 'neg'
  }
  return null
}

const ts = (s) => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

/**
 * The standing verdict of one kind: the LATEST counting marker decides. Only items from a trusted
 * repository association count (TRUSTED_ASSOCIATIONS), positive and negative alike. A PENDING item was never
 * submitted; a DISMISSED positive no longer stands; a negative counts in any submitted state —
 * dismissing must not be a way to make a block disappear.
 *
 * `positives` is every counting POSITIVE item not already defeated by a later negative, newest
 * first. The freshness check needs the set rather than only the latest: a reviewer can submit a
 * verdict against a commit older than one they submitted before (a stale browser tab does it), and
 * a fresh positive verdict is still a fresh positive verdict whatever was posted after it. Taking
 * only the latest would turn that into a false BLOCK on a required check.
 * @returns {{state:'pos'|'neg'|null, item:object|null, positives:Array<{state:string,item:object}>}}
 */
export function standingVerdict(items, kind) {
  let latest = null
  const counting = []
  for (const it of items) {
    if (it.state === 'PENDING' || !trusted(it)) continue
    const v = parseMarker(it.body, kind)
    if (!v || (v === 'pos' && it.state === 'DISMISSED')) continue
    counting.push({ state: v, item: it })
    if (!latest || ts(it.at) >= ts(latest.item.at)) latest = { state: v, item: it }
  }
  if (!latest) return { state: null, item: null, positives: [] }
  let lastNeg = null
  for (const c of counting)
    if (c.state === 'neg' && (!lastNeg || ts(c.item.at) >= ts(lastNeg.item.at))) lastNeg = c
  const positives = counting
    .filter((c) => c.state === 'pos' && (!lastNeg || ts(c.item.at) >= ts(lastNeg.item.at)))
    .sort((a, b) => ts(b.item.at) - ts(a.item.at))
  return { ...latest, positives }
}

// ---------------------------------------------------------------------------------------------
// Verdict freshness — a verdict is a statement about the code it was given on
//
// Found 2026-10-24 on PR #1110: `Verdict: APPROVE` and `Spec Review: PASS` were given on
// `abc3fa24c`, a further commit landed, and the gate reported both steps `done`. The reviewed code
// and the merged code were different code, with nothing in the output distinguishing them. That is
// the defect this whole gate exists to close, one notch weaker: the gate was built because five
// PRs merged with NO review, and without this it passes a PR on a review of SOMETHING ELSE.
//
// A review object carries `commit_id` — the commit it was submitted against. That is the entire
// mechanism for reviews. A PR comment does not; see `referenceSha` for what is done instead and
// what it costs.
//
// THE TRADE. If every follow-up commit invalidated every verdict, a PR-body edit — or routine
// currency with the base branch — would force a fresh review round, and a gate that expensive is
// one people route around. A routed-around gate is worse than the hole. So two classes of
// follow-up commit preserve a verdict, and both fall out of ONE measurement: the set of paths that
// differ between the reviewed commit V and the head H (`compares`, fetched by the workflow from
// `GET /repos/{repo}/compare/{V}...{H}`), intersected with the set the PR OWNS — `own` in the
// code below, the union of its net diff NOW (`pulls/files`, against the CURRENT base) and its net
// diff at V (`ownedAt`):
//
//   * a path in the drift but NOT in `own` differs between V and H and does NOT differ between the
//     base tip and H — the PR contributes nothing to that file. It is base-branch movement pulled
//     in by a merge, already reviewed on its way into the base. Ignoring it IS the merge
//     exemption, and it is exactly the check the owner ran by hand on #1108 ("the merge of main
//     altered none of the PR's own 14 files"). The union is what makes `own` correct: a file
//     reverted after the verdict is gone from the net diff and must still count — SEC-2 below.
//   * a path in the drift AND in `own` that is exempt documentation is the gate's docs-only rule
//     applied to a follow-up commit. `isInertDoc`, NOT `isDoc`: markdown that an agent reads as
//     instructions is not prose — SR-M-2, stated there.
//
// So a verdict stands iff every drifted path the PR owns is exempt documentation. The dangerous
// case the merge exemption invites — a conflict resolution that mangles a file subtly — cannot slip
// through: a conflicting file was touched by both sides, so it is in `own`, and the merge rewrote
// it, so it is in the drift. The claim being tested is not "this commit is a merge" (which a commit
// can assert about itself) but "nothing the PR owns moved", which it cannot.
//
// EVERYTHING UNMEASURABLE IS STALE, never fresh: a review with no `commit_id`, a comment with no
// `Commit:` line, an ambiguous abbreviation, a reviewed commit no longer in the PR (force-push or
// rebase), and a drift measurement that is missing, unavailable, truncated, or whose owned side
// came back EMPTY — a PR always owns a file, so an empty owned set means the read did not happen,
// not that it found nothing (SR-M-1). The gate already fails closed on a PR it could not read;
// this is the same rule one level down.

const short = (sha) => String(sha ?? '').slice(0, 7) || '(none)'

/**
 * The sha a comment-borne verdict states it was given on: the first `Commit: <sha>` line of the
 * body, 7-40 hex characters. Read with the same line discipline as a verdict marker — a quoted
 * line, a fenced block and an HTML comment are not statements, and markdown decoration is
 * tolerated (`**Commit:** abc1234`), which `bodyLine` does not do.
 */
export function statedCommit(body) {
  for (const line of proseLines(body)) {
    const m = /^Commit:\s*([0-9a-fA-F]{7,40})\b/.exec(line)
    if (m) return m[1].toLowerCase()
  }
  return null
}

/**
 * The commit a verdict item judged, or the reason it cannot be named.
 *
 * A review states it in `commit_id`, which GitHub records — authoritative, nothing to infer.
 * `commit_id` is the ONLY thing read for a review; a `Commit:` line in a review body is ignored on
 * purpose, so a stated sha can never downgrade a server-recorded one.
 *
 * A comment has no such field, so the verdict's author must name the sha: `Commit: <sha>`.
 *
 * WHAT THIS REPLACED, and why (SEC-1, 2026-10-24). The first edition of this function took "the
 * last commit that existed when the comment was written" from each commit's `committedAt`. A
 * committer date is git metadata the committer sets (`git commit --date`), so an author could
 * backdate a commit to between the reviewed commit and the verdict comment: the head then became
 * the newest commit the comment could have seen, and a verdict on older code read as fresh. That
 * is not a weaker check, it is a check that LOOKS like one while keying on data the subject
 * supplies — worse than the hole it replaced. No date is consulted anywhere in this file now.
 *
 * TWO ALTERNATIVES REJECTED.
 *   * Stop honouring comment-borne verdicts. `copy-reviewer` posts its verdict as a PR comment by
 *     contract and QA / Design accept one (`contracts.md` §4.1), so this deletes three steps'
 *     evidence channel. It is a legitimate answer and remains the fallback if the `Commit:` line
 *     proves unworkable in practice — but it costs more than it buys today.
 *   * Take "after" from the PR timeline API. The timeline's `committed` event carries the same
 *     author/committer dates from the commit object, not a server receipt time, so it would be the
 *     identical author-controlled field reached through a second endpoint. The one genuinely
 *     server-stamped event, `head_ref_force_pushed`, does not cover an ordinary push.
 *
 * COST TO THE AUTHOR. A comment-borne verdict now needs one extra line naming the sha reviewed.
 * It is the same trust level as the verdict itself — the reviewer's own attributable statement,
 * which the gate's threat model already accepts — and unlike a date it cannot be set as a
 * side-effect of committing. A verdict without the line is STALE, with a message that says so.
 * @returns {{sha:string}|{problem:string}}
 */
export function referenceSha(item, ctx) {
  if (!item.fromComment) {
    if (!item.commit_id)
      return {
        problem: 'the review carries no commit_id, so the code it judged cannot be identified',
      }
    return { sha: String(item.commit_id) }
  }
  const stated = statedCommit(item.body)
  if (!stated)
    return {
      problem:
        'a PR comment carries no commit_id, and this one has no `Commit: <sha>` line naming the commit it judged',
      // The common case is a verdict that WAS given on current code and simply does not say so,
      // and telling the author to re-review would be wrong as often as not.
      fix: 'Add a `Commit: <sha>` line to that comment naming the commit you judged, or post the verdict as a review (a review records the sha itself)',
    }
  // An abbreviated sha is resolved against the PR's own commits. Ambiguity is refused rather than
  // guessed; a sha that matches none falls through to the "no longer part of the PR" branch below,
  // which is the right answer for both a force-pushed commit and a typo.
  const hits = ctx.commits.filter((c) => String(c.sha).startsWith(stated))
  if (hits.length > 1)
    return { problem: `the \`Commit: ${stated}\` line matches ${hits.length} commits in this PR` }
  return { sha: hits.length ? String(hits[0].sha) : stated }
}

/**
 * Does a positive verdict still describe the head?
 * @returns {{fresh:true, note?:string}|{fresh:false, why:string}}
 */
export function verdictFreshness(item, ctx) {
  const ref = referenceSha(item, ctx)
  if (ref.problem) return { fresh: false, why: ref.problem, fix: ref.fix }
  const how = item.fromComment ? " (stated by the comment's own `Commit:` line)" : ''
  // Sound for both channels because `ref.sha` is now always STATED — a server-recorded
  // `commit_id`, or a sha the verdict's author wrote down — and never derived from a date or any
  // other field the PR author sets in passing. The equality is the same one the review path uses.
  if (ref.sha === ctx.headSha) return { fresh: true }
  const where = `it was given on ${short(ref.sha)}, not on the head ${short(ctx.headSha)}`
  if (!ctx.shas.has(ref.sha))
    return {
      fresh: false,
      why: `${where}, which is no longer part of the PR (force-push or rebase)${how}`,
    }
  const m = ctx.compares.find((c) => c.base === ref.sha)
  // SR-M-1 / CR-M-5: `ownedAt` EMPTY is treated as "not measured", not as "the PR owned nothing".
  // A PR always changes a file — `validate` rejects an empty `files` list for exactly that reason —
  // so an empty owned set can only mean the read did not happen. This is the second layer; the
  // first is `flow-gate-compare.jq`, which emits `unavailable` for a response that succeeded
  // carrying no file list. The shape is the one this repository records most: exit 0 without the
  // artifact. An empty `paths` is NOT suspicious the same way — a merge whose tree equals V's
  // genuinely moves nothing — so only the owned side is asserted here.
  if (
    !m ||
    m.unavailable ||
    !Array.isArray(m.paths) ||
    !Array.isArray(m.ownedAt) ||
    m.ownedAt.length === 0
  )
    return { fresh: false, why: `${where}, and the drift between them could not be measured${how}` }
  if (m.truncated || m.paths.length >= MAX_COMPARE_FILES || m.ownedAt.length >= MAX_COMPARE_FILES)
    return {
      fresh: false,
      why: `${where}, and the drift between them was too large to list in full${how}`,
    }
  // SEC-2, 2026-10-24: the owned set is what the PR owns NOW **union** what it owned at the
  // reviewed commit. `pulls/files` is the PR's NET diff against the current base, so a file the PR
  // reverted or deleted AFTER the verdict has dropped out of it — and judging drift against the
  // net set alone exempted a change to a file the reviewer had actually read, under the clause
  // meant for base-branch movement. `ownedAt` is the file list of `compare/{base}...{V}`, which is
  // that same net diff taken at the reviewed commit, so the union restores it.
  const owned = new Set([...ctx.own, ...m.ownedAt])
  const drifted = m.paths.filter((p) => owned.has(p))
  if (drifted.length === 0)
    return {
      fresh: true,
      note: `given on ${short(ref.sha)}; everything since touches base-branch files only, none this PR owns`,
    }
  const nonDoc = drifted.filter((p) => !isInertDoc(p))
  if (nonDoc.length === 0)
    return {
      fresh: true,
      note: `given on ${short(ref.sha)}; docs-only since (${drifted.join(', ')})`,
    }
  return {
    fresh: false,
    why: `${where}, and ${nonDoc.length} file(s) this PR owns changed since: ${nonDoc.slice(0, 5).join(', ')}${nonDoc.length > 5 ? ', …' : ''}${how}`,
  }
}

// ---------------------------------------------------------------------------------------------
// The flow

const verdictStep = (key, kind, sources, agent, required, whenText) => ({
  key,
  whenText,
  required,
  evidenceText: `a ${sources === 'reviews' ? 'review' : 'review or PR comment'} whose verdict line is \`${MARKERS[kind].prefix}: ${MARKERS[kind].pos[0]}\`, with no negative verdict after it, given on the head commit — or on an earlier one since which only markdown, or only files this PR does not own, changed`,
  check: (ctx) => {
    const items = sources === 'reviews' ? ctx.reviews : [...ctx.reviews, ...ctx.comments]
    const v = standingVerdict(items, kind)
    if (v.state === 'pos') {
      for (const p of v.positives) {
        const f = verdictFreshness(p.item, ctx)
        if (f.fresh)
          return {
            ok: true,
            evidence: `\`${MARKERS[kind].prefix}\` positive by @${p.item.author}${f.note ? ` — ${f.note}` : ''}`,
          }
      }
      const f = verdictFreshness(v.item, ctx)
      return {
        ok: false,
        stale: true,
        why: `the standing \`${MARKERS[kind].prefix}:\` verdict (by @${v.item.author}, ${v.item.at}) no longer describes the head — ${f.why}`,
        fix:
          f.fix ??
          `Get a fresh \`${MARKERS[kind].prefix}: ${MARKERS[kind].pos[0]}\` on the current head`,
      }
    }
    if (v.state === 'neg')
      return {
        ok: false,
        why: `the latest \`${MARKERS[kind].prefix}:\` verdict (by @${v.item.author}, ${v.item.at}) is negative`,
        fix: `Address it and get a new \`${MARKERS[kind].prefix}: ${MARKERS[kind].pos[0]}\``,
      }
    return {
      ok: false,
      why: `no "${MARKERS[kind].prefix}: ${MARKERS[kind].pos[0]}" ${sources === 'reviews' ? 'review' : 'review or comment'}`,
      fix: `Run ${agent}`,
    }
  },
})

/** The step table. Order = the order of the flow. */
export const STEPS = Object.freeze([
  {
    key: 'Task',
    whenText: 'always',
    required: () => true,
    evidenceText:
      'a PR-body line `Task: <path or issue link>` (declared, not verified — task files are gitignored)',
    check: (ctx) =>
      ctx.task
        ? { ok: true, evidence: `Task: ${ctx.task}` }
        : {
            ok: false,
            why: 'no "Task: <path or issue link>" line in the PR body',
            fix: 'Add "Task: <path or issue link>"',
          },
  },
  {
    key: 'Plan',
    whenText: 'always',
    required: () => true,
    evidenceText: 'a PR-body line `Plan: <where the plan is>`',
    check: (ctx) => {
      const plan = bodyLine(ctx.body, 'Plan')
      return plan
        ? { ok: true, evidence: `Plan: ${plan}` }
        : {
            ok: false,
            why: 'no "Plan: <where>" line in the PR body',
            fix: 'Add "Plan: <where the plan is>"',
          }
    },
  },
  {
    key: 'Tests',
    whenText:
      'the diff changes non-test code (`.ts/.tsx/.js/.jsx/.mjs/.cjs`) under `apps/` or `packages/`',
    required: (ctx) => ctx.files.some(isProductCode),
    evidenceText:
      'the diff also changes a test file (`*.spec|test.*`, `__tests__/`, `__test-helpers__/`, `apps/e2e/**`)',
    check: (ctx) => {
      const t = ctx.files.filter(isTestFile)
      return t.length
        ? { ok: true, evidence: `${t.length} test file(s) changed` }
        : {
            ok: false,
            why: 'product code changed but no test file did',
            fix: 'Add or update a test',
          }
    },
  },
  verdictStep('Review', 'review', 'reviews', 'code-reviewer', () => true, 'always'),
  verdictStep(
    'Security-Review',
    'security',
    'reviews',
    'security-reviewer',
    (ctx) => ctx.files.some(isCritical),
    'the diff touches a critical-path zone (`contracts.md` §2.1)',
  ),
  verdictStep(
    'Spec-Review',
    'spec',
    'reviews',
    'spec-reviewer',
    (ctx) => Boolean(ctx.task),
    'a `Task:` line is declared',
  ),
  verdictStep(
    'Copy-Review',
    'copy',
    // copy-reviewer.md posts its verdict as a PR comment, not only as a review — read both.
    'both',
    'copy-reviewer',
    (ctx) => ctx.files.some(isCopy),
    'the diff touches i18n catalogs or landing dictionaries',
  ),
  verdictStep(
    'QA',
    'qa',
    'both',
    'manual-qa',
    (ctx) => ctx.files.some(isUiCode),
    'the diff touches non-test UI code (`apps/web/`, `apps/landing/`)',
  ),
  verdictStep(
    'Design-Review',
    'design',
    'both',
    'ui-ux-designer (Mode B)',
    (ctx) => ctx.files.some(isUiCode),
    'the diff touches non-test UI code (`apps/web/`, `apps/landing/`)',
  ),
  {
    key: 'AC',
    whenText: 'always',
    required: () => true,
    evidenceText: 'the last non-`wip:`, non-merge commit carries an `ac_verified:` line',
    check: (ctx) => {
      const c = lastWorkCommit(ctx.commits)
      if (!c)
        return {
          ok: false,
          why: 'every commit is `wip:` or a merge — there is no final commit',
          fix: 'Make a final commit with "ac_verified: <AC numbers>"',
        }
      return /^ac_verified:/m.test(c.message)
        ? {
            ok: true,
            evidence: `\`ac_verified:\` in ${String(c.sha ?? '').slice(0, 7) || 'the last commit'}`,
          }
        : {
            ok: false,
            why: `the last non-wip commit (${String(c.sha ?? '').slice(0, 7)} "${firstLine(c.message)}") has no \`ac_verified:\` line`,
            fix: 'Amend or add a final commit with "ac_verified: <AC numbers>"',
          }
    },
  },
])

const firstLine = (m) =>
  String(m ?? '')
    .split('\n')[0]
    .slice(0, 72)

/** Commits are in PR order (oldest first). Merge commits and `wip` commits are not final work. */
export function lastWorkCommit(commits) {
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]
    if ((c.parents ?? 1) > 1) continue
    if (/^wip\b/i.test(firstLine(c.message))) continue
    return c
  }
  return null
}

/**
 * Evaluate the gate. Pure.
 * @param {object} pr
 * @param {Array<string|{filename:string,previous_filename?:string|null,status?:string}>} pr.files
 *        changed files as the pulls/files API returns them (a bare path is accepted)
 * @param {{changedFiles:number, commits:number}} pr.counts  the PR's own counts (completeness)
 * @param {string}   pr.body      PR description ('' when empty)
 * @param {string}   pr.headSha   the PR head sha — freshness is judged against it
 * @param {Array<{author:string,association:string,state:string,body:string,at:string,commit_id:?string}>} pr.reviews
 * @param {Array<{author:string,association:string,body:string,at:string}>} pr.comments  PR comments
 * @param {Array<{sha:string,message:string,parents?:number}>} pr.commits  oldest first
 * @param {Array<{base:string,paths?:string[],ownedAt?:string[],truncated?:boolean,unavailable?:boolean}>} [pr.compares]
 *        the paths differing between each reference sha and the head (`comparePlan` names them)
 */
export function evaluate(pr) {
  throwIfMalformed(pr)
  const { entries, paths } = normalizeFiles(pr.files)
  const incomplete = completenessProblem(pr, entries)
  if (incomplete) {
    return { pass: false, docsOnly: false, steps: [], failures: [incomplete], skips: [] }
  }
  if (isDocsOnly(paths)) {
    return { pass: true, docsOnly: true, steps: [], failures: [], skips: [] }
  }
  const ctx = buildCtx(pr, paths)
  const steps = []
  for (const s of STEPS) {
    if (!s.required(ctx)) {
      steps.push({ key: s.key, status: 'not-required', detail: `required when ${s.whenText}` })
      continue
    }
    const r = s.check(ctx)
    if (r.ok) {
      steps.push({ key: s.key, status: 'satisfied', detail: r.evidence })
      continue
    }
    const skip = bodyLine(pr.body, `Skip-${s.key}`)
    if (skip !== null && !isPlaceholder(skip) && skip.length >= MIN_REASON_LENGTH) {
      steps.push({ key: s.key, status: 'skipped', detail: skip })
      continue
    }
    const shortNote =
      skip === null
        ? ''
        : isPlaceholder(skip)
          ? ` (a "Skip-${s.key}:" line is present, but its reason is the template placeholder)`
          : ` (a "Skip-${s.key}:" line is present, but its reason is shorter than ${MIN_REASON_LENGTH} characters)`
    steps.push({
      key: s.key,
      // `stale` fails exactly as `missing` does; it is a separate status because the remedy is a
      // different action — "get a fresh pass on the new code" rather than "run a reviewer" — and
      // the author should not have to read the detail text to tell which one they need.
      status: r.stale ? 'stale' : 'missing',
      detail: `${s.key} — ${r.why}${shortNote}. ${r.fix}, or add "Skip-${s.key}: <why>" to the PR body.`,
    })
  }
  const failures = steps
    .filter((s) => s.status === 'missing' || s.status === 'stale')
    .map((s) => s.detail)
  const skips = steps
    .filter((s) => s.status === 'skipped')
    .map((s) => ({ step: s.key, reason: s.detail }))
  return { pass: failures.length === 0, docsOnly: false, steps, failures, skips }
}

/** The evaluation context. Shared by `evaluate` and `comparePlan` so both read one shape. */
function buildCtx(pr, paths = normalizeFiles(pr.files).paths) {
  return {
    ...pr,
    files: paths,
    // Every path the PR owns, rename sources included — the set a verdict's drift is judged
    // against. Rename sources are in deliberately: they make the set wider, hence the judgement
    // stricter.
    own: new Set(paths),
    shas: new Set(pr.commits.map((c) => String(c.sha))),
    compares: Array.isArray(pr.compares) ? pr.compares : [],
    reviews: pr.reviews.map((r) => ({ ...r, fromComment: false })),
    // `fromComment` is what `referenceSha` keys on: a review's own state can be `COMMENTED` too,
    // so the state field cannot tell the two channels apart.
    comments: pr.comments.map((c) => ({ ...c, state: 'COMMENTED', fromComment: true })),
    task: bodyLine(pr.body, 'Task') || null,
  }
}

/**
 * The reference shas whose drift to the head must be measured before the gate can judge
 * freshness. Printed by `--compare-plan`, one per line, for the workflow to fetch; the gate then
 * reads the results back as `pr.compares`. Keeping the selection here rather than in the
 * workflow's shell keeps it under the unit tests, and leaves the bash a dumb loop.
 *
 * Distinct, never the head, only shas actually in the PR, and hex-only — the workflow puts each
 * one into an API path, so a sha that is not 7-40 hex characters is not emitted at all. Capped at
 * MAX_COMPARES: a verdict whose sha is not in the plan has no measurement, and no measurement is
 * STALE, so the cap errs closed.
 *
 * Reviews and comments are pooled for every marker kind, even though `Review` / `Security-Review`
 * / `Spec-Review` read reviews only. A comment carrying one of those markers can therefore add a
 * sha nothing will consult; that costs one API call and keeps this function from having to
 * duplicate the step table's `sources` column.
 */
export function comparePlan(pr) {
  throwIfMalformed(pr)
  const ctx = buildCtx(pr)
  const items = [...ctx.reviews, ...ctx.comments]
  const out = []
  for (const kind of Object.keys(MARKERS)) {
    for (const p of standingVerdict(items, kind).positives) {
      const ref = referenceSha(p.item, ctx)
      if (ref.problem || ref.sha === ctx.headSha || !ctx.shas.has(ref.sha)) continue
      if (!/^[0-9a-f]{7,40}$/.test(ref.sha) || out.includes(ref.sha)) continue
      out.push(ref.sha)
    }
  }
  return out.slice(0, MAX_COMPARES)
}

function throwIfMalformed(pr) {
  const problems = validate(pr)
  if (problems.length) {
    const err = new Error(`malformed input: ${problems.join('; ')}`)
    err.code = 'MALFORMED'
    throw err
  }
}

function validate(pr) {
  if (!pr || typeof pr !== 'object') return ['input is not an object']
  const p = []
  for (const k of ['files', 'reviews', 'comments', 'commits'])
    if (!Array.isArray(pr[k])) p.push(`${k} must be an array`)
  if (typeof pr.body !== 'string') p.push('body must be a string (empty when the PR has none)')
  // No head sha, no freshness judgement — and a freshness judgement that defaults to "fresh" is
  // the defect this file was changed to fix. Refuse the input instead (exit 2).
  if (typeof pr.headSha !== 'string' || !pr.headSha)
    p.push('headSha must be a non-empty string (the PR head sha)')
  if (pr.compares !== undefined && !Array.isArray(pr.compares))
    p.push('compares must be an array when present')
  // A PR always changes a file and has a commit. An empty list means the fetch did not happen —
  // and an instrument that did not look must not report "docs-only" or "nothing to check".
  if (Array.isArray(pr.files) && pr.files.length === 0)
    p.push('files is empty — the changed-file fetch returned nothing')
  if (Array.isArray(pr.commits) && pr.commits.length === 0)
    p.push('commits is empty — the commit fetch returned nothing')
  return p
}

// ---------------------------------------------------------------------------------------------
// CLI

const ICON = {
  satisfied: 'done',
  skipped: 'SKIPPED',
  'not-required': 'n/a',
  missing: 'MISSING',
  stale: 'STALE',
}

export function render(result, pr) {
  const lines = [`## Flow Gate: ${result.pass ? 'PASS' : 'FAIL'}`, '']
  lines.push(
    `changed files: ${pr.files.length} · reviews: ${pr.reviews.length} · comments: ${pr.comments.length} · commits: ${pr.commits.length} · head: \`${short(pr.headSha)}\``,
    '',
  )
  if (result.docsOnly) {
    lines.push(
      'Docs-only diff (every changed path, rename sources included, ends in `.md`) — exempt, light-track.',
    )
  } else {
    lines.push('| Step | Status | Detail |', '| --- | --- | --- |')
    for (const s of result.steps)
      lines.push(`| ${s.key} | ${ICON[s.status]} | ${String(s.detail).replace(/\|/g, '\\|')} |`)
    if (result.skips.length) {
      lines.push('', '### Skipped on purpose')
      for (const s of result.skips) lines.push(`- **${s.step}** — ${s.reason}`)
    }
    if (result.failures.length) {
      lines.push('', '### Missing')
      for (const f of result.failures) lines.push(`- ${f}`)
    }
    if (result.steps.some((s) => s.status === 'stale')) {
      lines.push(
        '',
        '### About STALE',
        '',
        `A **STALE** step was reviewed and then the code changed, so the verdict describes a commit that is not the head (\`${short(pr.headSha)}\`). It needs **a fresh pass on the new code** — unlike **MISSING**, which is a step nobody has looked at yet.`,
        '',
        'Two kinds of follow-up commit do NOT make a verdict stale: one touching only **inert** paths — a dated `docs/architecture/<date>-*.md` record, `docs/business/**`, or the root `README.md` — and a merge from the base branch that leaves every file this PR owns untouched. Keeping a branch current therefore costs no review round; resolving a conflict in a file the PR changed does.',
        '',
        'Other markdown is NOT inert: `CLAUDE.md`, `CONTEXT.md`, `.claude/**`, `docs/runbooks/**`, `docs/architecture/rules-rationale/**` and the vendored agent prompts are read as behaviour here, so changing one asks for a fresh pass like any other change.',
      )
    }
  }
  lines.push(
    '',
    'Re-runs on push, label changes and PR-body edits. After a review lands, re-run it with a body edit or a label change.',
  )
  return lines.join('\n') + '\n'
}

function main(argv) {
  const arg = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined)
  const input = arg('--input')
  if (!input) {
    console.error(
      'usage: flow-gate.mjs --input <pr-data.json> [--summary <file>] | --compare-plan --input <pr-data.json>',
    )
    return 2
  }
  let pr, result
  // `--compare-plan` is the first of the two passes the workflow makes: it prints the shas whose
  // drift to the head has to be measured, the workflow fetches each one, and the second pass
  // evaluates with the measurements in hand.
  if (argv.includes('--compare-plan')) {
    try {
      const shas = comparePlan(JSON.parse(readFileSync(input, 'utf8')))
      if (shas.length) process.stdout.write(shas.join('\n') + '\n')
    } catch (e) {
      console.log(`::error title=Flow Gate::could not plan the drift measurements — ${e.message}`)
      return 2
    }
    return 0
  }
  try {
    pr = JSON.parse(readFileSync(input, 'utf8'))
    result = evaluate(pr)
  } catch (e) {
    console.log(`::error title=Flow Gate::could not evaluate — ${e.message}`)
    return 2
  }
  const text = render(result, pr)
  process.stdout.write(text)
  const summary = arg('--summary')
  if (summary) appendFileSync(summary, text)
  for (const f of result.failures) console.log(`::error title=Flow Gate::${f}`)
  for (const s of result.skips)
    console.log(`::notice title=Flow Gate skip::${s.step} — ${s.reason}`)
  return result.pass ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
