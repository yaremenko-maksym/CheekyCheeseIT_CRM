# Rule: Skills invocation policy (mandatory triggers)

**Status:** Always-on
**Applies to:** All agents (Coder, AutoTest, Reviewer, DevOps, Legal, Architect, plus ECC-imported agents) + Master (orchestrator)

> Rationale: `docs/architecture/rules-rationale/skills-invocation.md`

---

## The rule

If a **trigger applies** — the agent **must** invoke the skill via the `Skill` tool, not "remember"
the pattern. If the skill is absent from the environment — the `Skill` tool fails with an error, that
is an explicit failure (better than a silent skip).

In the final report — state which skills you invoked. Master checks.

**The mapping below is the source of truth for triggers**: it alone states trigger, skill and which agents it binds. `when_to_use` in each `SKILL.md` and the listing `description` mirror it — change a trigger in BOTH places. A `description` over `skillListingMaxDescChars` (300) is silently cut, so the listing cannot carry a full trigger.

Each entry reads `trigger → skill · agents it applies to`.

## Trigger → Skill mapping

- A session begins (any) → `superpowers:using-superpowers` · All
- A task starts; before a large read, long command output, or new code → `token-economy` · All
- Any creative task (feature / UI / behavior change) → `superpowers:brainstorming` · Master, Coder
- Multi-step task — before implementation → `superpowers:writing-plans` · Coder, DevOps
- Any feature / fix — before implementation → `superpowers:test-driven-development` · Coder
- Bug / test failure / unexpected behavior → `superpowers:systematic-debugging` · All
- Before PR / completion claim → `superpowers:verification-before-completion` · Coder, AutoTest, DevOps
- PR touches auth / finance / wallets / transactions / company-account → `security-review` · Coder, Reviewer
- The start of every review → `superpowers:requesting-code-review` · Reviewer
- Receiving review feedback → `superpowers:receiving-code-review` · Coder
- After writing code (cleanup) → `simplify` · Coder
- New page / complex UI component → `frontend-design:frontend-design` · Coder
- You write / edit text visible to a client or candidate → `copywriting` · Coder, ui-ux-designer, copy-reviewer
- Need isolated workspace (parallel work) → `superpowers:using-git-worktrees` · Master (Coder dispatch)
- Implementation plan execution → `superpowers:executing-plans` · Master, Coder
- Multi-task dispatch → `superpowers:dispatching-parallel-agents` · Master
- Branch ready to merge (a PR is being prepared) → `superpowers:finishing-a-development-branch` · Coder, Master
- Memory consolidation / dedup (after a merged PR) → `anthropic-skills:consolidate-memory` · Master
- A fork unsolvable from the task file (before `.blocked.md` / an owner question) → `decision-frontier` · All
- A bug resists / E2E flakes / a regression / "it's slow" → `diagnosing-bugs` · All
- Designing a module interface / choosing a seam / "no seam for a test" → `codebase-design` · Coder, Architect, code-reviewer
- Safely split a giant file/module (>800 lines, god file) — the seam is already chosen → `decomposing-large-code` · Coder, Architect
- A merge/rebase with a conflict is underway; a stack on a squashed base → `resolving-merge-conflicts` · Coder, Master, DevOps
- A design question is not settled on paper (how it looks / how it behaves) → `prototype` · Coder, ui-ux-designer
- The answer lies OUTSIDE the repository (a library / someone's API / a spec / a law) → `external-research` · All
- You write or clean a rule / an agent prompt / a SKILL.md / CLAUDE.md → `writing-for-agents` · Architect, Master
- UI work: WCAG 2.2 AA — ARIA / focus / contrast / target size → `accessibility` · ui-ux-designer, Coder
- UI polish pass (radius / tabular-nums / motion / hit areas) → `make-interfaces-feel-better` · ui-ux-designer (Mode D), Coder
- Visual audit (Mode B / C), AI-slop detection → `design-system` · ui-ux-designer
- Pre-feature design direction (Mode A) → `frontend-design-direction` · ui-ux-designer
- Driving Claude Design for a UI task / handoff artifact (design-gate Tier 1/2) → `claude-design-workflow` · Master, ui-ux-designer
- Read-only breadth-first audit of ≥3 independent modules → `codebase-audit` · Master

## Project-local skills catalog

The catalog of project-local skills (name → trigger) and the procedure that reconciles this file with
the plugins on disk live in `.claude/skills/README.md`. **Read it when you add, rename or remove a
skill, change a trigger above, or update plugins.** CI (`check-skill-registry.yml`) fails when that
catalog and `.claude/skills/` disagree.

## Workflow surface policy

`commands/` is NOT used in this repo. Workflow knowledge lives in `.claude/skills/<name>/SKILL.md` (invocable), `.claude/agents/<agent>.md` (workflow / golden rules) and `.claude/rules/common/*.md` (cross-cutting standards).

## Anti-patterns

- A mandatory table in `<agent>.md` needs an up-to-date trigger: check with `grep skill-name .claude/agents/*.md`.
- Invoke `Skill(name)` rather than "remembering" a pattern; skill content evolves.
- Create a SKILL.md only with ≥ 3 substantive patterns.

## Related rules

- `.claude/rules/common/mcp-first.md` — MCP catalog (some skills use MCP tools).
- `.claude/rules/common/zone-of-write.md` — which skills are available to whom (per-agent invocation).
