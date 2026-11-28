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
  above. A rename counts by both its names.
- has, in an **unowned** file, a trigger of `scripts/devops/check-owner-approval.mjs`.

**The scanner is fail-closed.** Every non-removed unowned file is either inert or parsed with the TypeScript compiler
API. Inert files are markdown, images, css, `.po`, snapshots, fonts and plain data `.json`. The parser reads the
file's full head content, fetched through the REST API as text and never executed. Each of these is a trigger:

- an import that resolves into `apps/api/**`, a DB client package or path, or a finance service / repository.
  Resolution covers relative paths, the package's tsconfig `paths` read from main, and `@crm/*`.
- a specifier that cannot be resolved.
- any loader other than a literal ESM import: `require`, `module`, `process`, `exports`, `createRequire`,
  `eval`, `Function`, `.constructor(...)`, `Reflect.get/apply/construct`, `import.meta.glob`, a computed member of a
  global object, or a global object passed as a value.
- a Node built-in in browser code. `apps/e2e` may import only `fs`, `path`, `url`, `os`, `crypto`.
- a new `*.controller.*` file or an `@Controller(...)` decorator.
- a rename or copy out of an owned path.
- a file that does not parse, or whose content could not be fetched.
- a file type that is neither inert nor code: `.html`, `.mdx`, `.vue`, unknown extensions.

A trigger is not an accusation. It means "the owner looks". On main today about 6% of the open-zone code files carry
a trigger, mostly E2E helpers using `process` / `node:*` and design tooling. Editing one of them needs a verdict.

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

**Merge.** `.github/workflows/owner-verdict-merge.yml` re-evaluates the verdict on the completion of Flow Gate Relay
(the owner's review), Flow Gate, CI and E2E Tests. When the status is `approved`, it waits, bounded, for the re-run
`Owner Verdict` check and every required context, then squash-merges. Its merge path is the one in
`auto-merge-on-label.yml`. If checks are still pending, it posts one comment per head saying what is pending, and
the completion of the pending workflow merges it. PRs touching `.github/workflows/**` are still merged by hand.
Owner-authored and not-required PRs keep the `merge-approved` label path.

## Residual risks (known, accepted or open)

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

This is an owner decision: `docs/runbooks/human-only.md` item 12.
