# CODEOWNERS and the Owner Verdict gate: what is protected and why

Owner decision 2026-11-28 (manager role, plan PR 11). Two layers protect `main`:

1. **`.github/CODEOWNERS`** decides **which files** need the owner's review once "Require review from Code Owners" is
   on (see "Before enabling" below).
2. **The `Owner Verdict` required check** decides **which PRs** need the owner's explicit verdict. It looks at
   behaviour, not only paths. It exists because CODEOWNERS cannot see what a file does, and because agents share the
   owner's GitHub account.

## Layer 1: CODEOWNERS (last matching line wins)

| Lines                                                                                                                                                                   | Owner | Why                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*`                                                                                                                                                                     | owner | Default: everything the owner did not open stays his.                                                                                                      |
| `apps/web/**`, `apps/landing/**`, `apps/e2e/**`, `docs/**`                                                                                                              | none  | The open zones (owner decision): UI, landing, E2E and documentation, where a manager may merge without him.                                                |
| `docs/business/`                                                                                                                                                        | owner | Business documents (pricing, terms) are owner decisions, not documentation.                                                                                |
| `apps/api/src/database/`                                                                                                                                                | owner | Already owned by `*`; listed so that a later open line cannot reopen it by accident.                                                                       |
| `**/package.json`, `**/tsconfig*.json`, `**/jsconfig*.json`, `**/.babelrc*`                                                                                             | owner | Dependency and module-alias wiring. An `npm:` / `workspace:` alias or a `paths` entry can point an innocent import at the API or a DB driver.              |
| `**/vite.config.*`, `**/vitest.config.*`, `**/playwright.config.*`                                                                                                      | owner | Bundler and runner config: aliases, plugins and dev-server proxies run code at build time.                                                                 |
| `**/.npmrc`, `**/pnpm-workspace.yaml`, `**/pnpm-lock.yaml`                                                                                                              | owner | Registry, workspace and lockfile: what actually gets installed.                                                                                            |
| `**/index.html`                                                                                                                                                         | owner | The SPA entry documents: a `<script>` there runs before the bundle, outside every import check.                                                            |
| `apps/web/Dockerfile`, `apps/landing/Dockerfile`                                                                                                                        | owner | Production images are deploy surface.                                                                                                                      |
| Web auth: `route-access.ts`, `context/auth.tsx`, `login.tsx`, `_authenticated/route.tsx`, `admin/login-as.tsx`, `lib/axios.ts`, `lib/use-logout.ts`, `lib/persister.ts` | owner | Client-side route access, session, impersonation, the authenticated HTTP client, logout and the query persister (which must never persist auth / finance). |
| Web finance: `_authenticated/finance/`, wallet, invoice, project transactions, archive pending transactions, finance chart / tab / sections, requisites                 | owner | Money and payment details: what is shown, to whom, and what is sent back.                                                                                  |

`scripts/devops/tests/test-check-owner-approval.sh` asserts the owner of real paths on both sides of each line, and
that every re-protect line names a path that exists. A rename that silently unprotects a file fails the test.

## Layer 2: the Owner Verdict gate

**When it is required.** The PR author is not the owner (`yaremenko-maksym`) and the PR does at least one of:

- touches a **critical zone** in `scripts/devops/owner-verdict-zones.json`. This covers the contracts.md §2.1 zones
  (a test asserts it is a superset of the Flow Gate's `CRITICAL_PATH_GLOBS`), `.github/workflows/**`,
  `.claude/hooks/**`, `.claude/settings*.json`, the gate's own files, and every web auth / finance re-protect line
  above. A rename counts by both its names. The gate's own files are all of `scripts/devops/**` (every script the
  two gate workflows run or source; a test parses both workflows and fails if one falls outside a zone) plus the
  scanner's alias inputs `tsconfig.base.json` and `apps/*/tsconfig.json`.
- has, in an **unowned** file, a trigger of `scripts/devops/check-owner-approval.mjs`.

**The scanner is fail-closed.** Every non-removed unowned file is either inert or parsed with the TypeScript compiler
API. Inert files are markdown, images, css, `.po`, snapshots, fonts and plain data `.json`. The parser reads the
file's full head content, fetched through the REST API as text and never executed. Each of these is a trigger:

- an import that resolves into `apps/api/**`, a DB client package or path, or a finance service / repository.
  Resolution covers relative paths, the package's tsconfig `paths` read from main, and `@crm/*`.
- a specifier that cannot be resolved.
- any loader other than a literal ESM import: `require`, `module`, `exports`, `createRequire`, `import.meta.glob`, a
  computed member of a global object, or a global object passed as a value (also through `=` / `??=` / `||=` / `&&=`).
- a denied name, wherever it appears: an identifier, a property or binding name, a string literal or a template chunk
  (compared on the cooked text) equal to `constructor`, `Reflect`, `Function`, `eval`, `globalThis`,
  `getOwnPropertyDescriptor(s)`, `getOwnPropertyNames`, `getPrototypeOf`, `setPrototypeOf`, `__proto__`,
  `defineProperty`, `defineProperties`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`,
  `__lookupSetter__` or `process`. This token-level denylist (addendum 8, extended addendum 10) replaces the per-call
  special cases: aliasing (`const R = Reflect`, `const { constructor: F } = f`) and prototype reflection cannot reach
  `Function` without naming one of them. A class's own `constructor() {}` and JSX text are not triggers.
- any computed access whose key is neither a string nor a numeric literal (`x[k]`), whatever `x` is, and such a key
  in a destructuring or assignment pattern (`const { [k]: v } = o`; building `{ [k]: v }` is not a trigger). Receiver
  locality is not provable statically: members of locals (`o.toString[k]`), a computed key earlier in the chain
  (`a[k].call[k]`), aliases and mutation through a property or a call argument all reach `constructor`.
  Decision (addendum 7d, measured 2026-11-28 on the 1058 open-zone code files of main): this blanket rule triggers
  on 227 files (the receiver-locality rule it replaces: 181, with three rounds of bypasses), under the 300 limit.
  Addendum 8 (denied names + pattern keys, measured 2026-11-28 on the same 1058 files): 238 trigger, under the 300
  limit; `process` alone adds no file (the old reference rule already caught all 14).
  Addendum 10 (four more reflection names, `as`/`!` pattern unwrapping, dead private arm dropped): 238 trigger of 1058
  (0 new triggers), under the 300 limit.
  Re-measure with `findingsForFile` over `fetchPlan(git ls-files)` before changing it.
- a Node built-in in browser code. `apps/e2e` may import only `fs`, `path`, `url`, `os`, `crypto`.
- a new `*.controller.*` file or an `@Controller(...)` decorator.
- a rename or copy out of an owned path.
- a file that does not parse, or whose content could not be fetched.
- a file type that is neither inert nor code: `.html`, `.mdx`, `.vue`, unknown extensions.

A trigger is not an accusation. It means "the owner looks". On main (2026-11-28) 238 of 1058 open-zone code files
(about 22%) carry a trigger: E2E helpers using `process` / `node:*`, `Object.defineProperty` in test setup, design
tooling, and code indexing with a non-literal key (`record[key]`, `rows[i]`). Editing one of them needs a verdict.

**The verdict.** Only a **PR review** by the owner counts (state Comment or Approve, not an issue comment, not
Dismissed):

```
Owner Verdict: APPROVE
Commit: <full 40-hex head sha>
```

- The first non-empty line must be the marker.
- `Commit:` must equal the head exactly, and the review's own `commit_id` (set by GitHub) must equal it too.
- A push after the verdict makes it stale.
- A newer `Owner Verdict: BLOCK` turns it red. A later APPROVE turns it green again.
- Owner reviews without the marker change nothing.
- An owner review **edited** after it was posted (any editor, any body) resets the verdict: nothing approves until
  a newer, unedited verdict review follows. Edited reviews never count as approval; post a new review. A write collaborator may be able to edit a review body while its author
  and `commit_id` stay fixed, so an edit is never trusted. Reviews are read through GraphQL for the edit flag.
- A **dismissed** APPROVE does not count; a dismissed BLOCK still blocks.

**Merge.** `.github/workflows/owner-verdict-merge.yml` re-evaluates the verdict on the completion of Flow Gate Relay
(the owner's review), Flow Gate, CI and E2E Tests. When the status is `approved`, it waits, bounded, for the re-run
`Owner Verdict` check and every required context, then re-reads the reviews and re-evaluates the verdict before
each merge attempt, retries included (a BLOCK posted during the wait or between retries stops it), then
squash-merges pinned to the verified head. Its merge path is the one in `auto-merge-on-label.yml`. It posts one comment per head and kind: checks pending (the
completion of the pending workflow merges it), a required check failed (no auto-merge on this head), or the merge
step stopped. The TypeScript parser it loads is pinned by the pnpm-lock.yaml integrity. PRs touching `.github/workflows/**` are still merged by hand.
Owner-authored and not-required PRs keep the `merge-approved` label path.

## Residual risks (known, accepted or open)

- **Accepted risk: E2E code execution.** E2E code can run arbitrary programs on dev, agent and CI machines through
  routes that no denylist covers (`tsImport` with a runtime specifier, fs-write-then-import, Playwright
  `executablePath`, environment reads without `process`); owner decision 2026-11-28. `apps/e2e/**` stays open;
  no e2e-specific triggers are added. Consequently, (a) a PR touching only `apps/e2e/**` needs no owner verdict and
  can auto-merge after the normal reviews, and (b) a machine running E2E may hold credentials beyond the repo (for
  example a developer machine), so E2E code reaches whatever that machine can reach.
- **Agents can post the marker.** Agents use the owner's account, so the gate rests on a hook that refuses a
  `gh` command carrying `Owner Verdict:`. That hook is in the Architect's zone and is **not built yet**. It is
  reported in PR 11 with its exact specification. Until it lands, the verdict is a convention for agents, not a lock.
- **Owner-authored = exempt.** Every agent PR is authored by the owner's account, so it passes as `owner-authored`.
  The gate binds only PRs by other accounts (colleagues, a separate manager account). A manager pushing into an
  owner-authored PR also passes.
- **A same-named check from a PR branch.** A PR can add a workflow whose job is named `Owner Verdict`. The required
  context must be bound to the GitHub Actions app (app_id 15368) **and** `.github/workflows/**` is a critical zone,
  so such a PR is red on the real check. The binding alone does not distinguish two Actions jobs, though: review
  any PR that adds a workflow.
- **Static analysis cannot prove the absence of dynamic loading.** The scanner is a tripwire. Owner review of a
  triggered PR is the backstop. A plain `window.x` / `globalThis.x` read is deliberately not a trigger (it is all
  over browser code). A global passed as a value is.

## Before enabling "Require review from Code Owners"

Today (verified 2026-11-28, `gh api repos/{owner}/{repo}/branches/main/protection`) `main` has
`enforce_admins: true` and no required reviews. Turning the code-owner review on blocks every PR that touches an
owner path and is authored from the owner's account: GitHub never lets an author approve his own PR, and the
GitHub Actions token cannot bypass. That is every agent PR, including all PRs outside the open zones. The setting
needs one of these first:

- a bypass allowance for the owner,
- a separate account for agents, or
- leaving the setting off and relying on Layer 2 alone.

This is an owner decision: `docs/runbooks/human-only.md` item 13.
