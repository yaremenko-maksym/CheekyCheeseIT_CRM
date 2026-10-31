# Rule: Zone-of-write contract per agent

**Status:** Always-on (enforced by hook + Reviewer)
**Applies to:** All write-agents (Coder, AutoTest, DevOps, Architect, ui-ux-designer, manual-qa, legal) + Master (orchestrator). `code-reviewer` / `security-reviewer` — read-only to code.

> Rationale: `docs/architecture/rules-rationale/zone-of-write.md`

---

## The rule

Each agent may write ONLY in its own zone. The reviewer issues `Verdict: BLOCK` on a diff where an agent trampled someone else's files.

Each entry below is one zone row: **may** / **may NOT**.

**Coder**

- may: `apps/api/**`, `apps/web/**`, `apps/landing/**`, `apps/e2e/**`, `packages/**`, `.claude/tasks/<my-task>.progress.md`, `.claude/tasks/<my-task>.blocked.md`
- may NOT: `scripts/pm/**`, `scripts/devops/**`, `.claude/agents/**`, `docs/business/**`, `.github/workflows/**`, `.claude/hooks/**`, `.claude/settings*.json`, `.gitmessage`, others' task files

**AutoTest**

- may: **any test file in the repository**, wherever it lies: `**/*.spec.ts(x)`, `**/*.test.ts(x)`, `__tests__/` directories, `__test-helpers__/`, all of `apps/e2e/**` (including `fixtures/`), test configs (`playwright.config.ts`, `vitest.config.*`), `.claude/tasks/<my-task>.blocked.md`
- may NOT: **product code** — any non-test file in `apps/**` / `packages/**`. Also `docs/business/**`, `.claude/agents/**`, `.github/workflows/**`, `scripts/**`

**DevOps**

- may: `.github/workflows/`, `docker-compose.yml`, `.env.example`, root `package.json` scripts (`dev:start`, etc.), `scripts/devops/**`
- may NOT: `apps/**`, `packages/**`, `docs/business/**`, `.claude/agents/**`, `scripts/pm/**`

**code-reviewer** / **security-reviewer**

- may: `mcp__github__create_pull_request_review` / inline comments (read-only to code)
- may NOT: any files in the repo

**spec-reviewer**

- may: `mcp__github__create_pull_request_review` / inline comments (read-only to code)
- may NOT: any files in the repo — the second review axis edits neither the diff nor the task

**copy-reviewer**

- may: `mcp__github__create_pull_request_review` / inline comments (read-only to code)
- may NOT: any files in the repo — text edits are made by the task author, not the reviewer

**Master (orchestrator)**

- may: `.claude/tasks/`, `.claude/briefs/`, `docs/business/` (when resolving blockers), `.claude/agents/memory/<agent>/lessons.md` (append), `scripts/pm/**`
- may NOT: `apps/**`, `packages/**`, `apps/e2e/**`, `.github/workflows/**`, `.claude/agents/<X>.md` (except memory)

**Architect**

- may: `docs/architecture/**`, `.claude/rules/**`, `.claude/hooks/**`, `.claude/skills/**`, `.claude/agents/<agent>.md` (frontmatter + golden rules), `.claude/RULES.md`, `.claude/settings*.json` (hook registration), `scripts/architect/**`, `.github/workflows/**` (additive process gates), `scripts/devops/check-guard-tests-exist.sh` + `scripts/devops/tests/test-pre-*.sh` + `scripts/devops/tests/lib/command-corpus.txt` (tests on hooks, and the corpus they read — see below)
- may NOT: `apps/**`, `packages/**`, `docs/business/**`, `.claude/briefs/**`, `.claude/knowledge/legal/**`, `.claude/tasks/<others' active>` (Master owns)

**ui-ux-designer**

- may: `apps/web/**` + `apps/landing/**` (cosmetic: classNames / tokens / layout / motion), `docs/design/**`, `.claude/tasks/<my-task>.blocked.md`
- may NOT: `apps/api/**`, `packages/**`, business logic in `.tsx`, `.github/workflows/**`, `.claude/agents/**`

**manual-qa**

- may: `apps/web/**` + `apps/landing/**` (ONLY cosmetic fixes: text / padding / class), `.claude/tasks/<my-task>.blocked.md`
- may NOT: `apps/api/**`, `packages/**`, business logic, `apps/e2e/**`, `.github/workflows/**`, `.claude/agents/**`

**legal**

- may: `.claude/tasks/task-legal-*`, `docs/legal/**`, `.claude/knowledge/legal/**`
- may NOT: `apps/**`, `packages/**`, `.claude/agents/**`, prod code, `.github/workflows/**`

> **The AutoTest boundary runs between the test and the product code, not between directories** — editing product code to turn a test green is what is forbidden.
>
> **Overlaps that are intentional, not gaps:** `ui-ux-designer` ↔ `manual-qa` both write cosmetic in
> `apps/web/**` / `apps/landing/**` — the designer per the design spec (Mode B/D), manual-qa fixes what
> a live pass finds; delineated in `contracts.md §3.1/§3.2`. `architect` and `legal` are launched USER
> / Master ad-hoc by design.

## Enforcement

### Active hook

`.claude/hooks/pre-edit-write-zone-of-write.sh` (id `pre:edit-write:zone-of-write`) blocks a Coder
from the main repo on an attempt to `Edit` / `Write` / `MultiEdit` / `NotebookEdit` in `apps/**` /
`packages/**` if Master did not allow it.

### Worktree caveat

In a worktree the block is lifted — the Coder _technically_ can overwrite anything. But this is a zone-of-write violation → the reviewer will issue `Verdict: BLOCK`.

### Verify MAIN is clean after each Coder (MANDATORY)

A Coder in `isolation=worktree` on the first Write sometimes writes into the MAIN repo by an absolute
path (it copies main-repo paths from codegraph / the task file).
`pre-edit-write-zone-of-write.sh` does NOT catch this case. So Master MUST, after EACH finished
Coder, verify that the MAIN checkout is clean:

```bash
git -C <main-repo> status --porcelain apps/ packages/   # empty = OK; lines present = contamination, roll back
```

In the Coder's dispatch prompt — an explicit block: "ALL Edit/Write INSIDE your own worktree; after
the first edit check `git -C <worktree> status`; do NOT write to main-repo absolute paths".

### If the task requires leaving the zone

1. Create `<task>.blocked.md` describing why.
2. Do NOT do it unilaterally.
3. Exception: Master explicitly stated in the task file "update `docs/business/modules/<X>.md`" — allowed.

## Architect-specific boundaries

- **Golden rules and `RULES.md`** — the Architect edits them when inter-agent mechanics change (a new hook, an always-on rule, a mandatory startup step).
- **`.claude/settings*.json`** — **only** hook registration; `permissions`, `enabledPlugins`, `env` are not his.
- **`.github/workflows/**`** — only **additive\*\* process gates. Everything that touches deploy,
  build, or prod secrets stays DevOps.
- **The Architect still does NOT rewrite** task setup / a task's business logic (Master's zone via `.claude/tasks/`).
- The Architect's diffs still go through review.
- **Tests on hooks:** the Architect writes in `scripts/devops/` **only**
  `check-guard-tests-exist.sh` (the meta-guard over his own hooks), `tests/test-pre-*.sh` (the
  tests on the hooks he owns) and `tests/lib/command-corpus.txt`. Everything else in
  `scripts/devops/**` — DevOps. The reverse does **not** hold: DevOps does not edit
  `.claude/hooks/**`.
- Why the corpus is listed (PR #1067) and the three named readers: rationale file.

If an edit goes beyond these boundaries too — `.blocked.md`, like everyone.

> **Two descriptions of one zone.** `.claude/agents/architect.md` §Zone-of-write describes the same
> boundary. They have diverged before. **Edit one — edit the second.**

## Related rules

- `.claude/rules/common/git-policy.md` — `git add .` zero-tolerance protects against accidental cross-zone commits.
- `.claude/rules/common/skills-invocation.md` — which skills belong to whose zone.
