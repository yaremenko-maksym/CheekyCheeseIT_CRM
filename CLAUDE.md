# CheekyCheeseIT CRM — Memory Bank (overview)

> **Compact overview for USER sessions.** Details are NOT duplicated here — see the pointer map.
> New facts about the project (phases, migrations, RBAC, business rules, gotchas) go into
> `.claude/agents/project-state.md` — that is the single source of truth. Put something here only
> if the pointer map or the top-level status changed.
> Revision: 2026-10-05 (dated status snapshot removed; status lives only in project-state.md).

## Project

CRM for recruiting workspaces (outsource/outstaffing company: AI, EdTech, E-Commerce).
**Goal:** maximum type safety, speed, professional UX.
**Language:** everything in the repo and all agent output is **English** (reports, dispatch prompts, PR titles/bodies, review comments, commit bodies, code comments, task files, `.claude/**`, `CLAUDE.md`, `CONTEXT.md`); Russian lives **only** in the owner↔Claude direct chat (personal, out-of-repo). Product i18n is separate and unchanged: `uk` default + `en` via Lingui. See `.claude/rules/common/russian-language.md`.

- **Landing** — a separate app `apps/landing` (target domain `cheekycheese.tech`), with no links to the CRM
- **CRM** — `apps/web` (target `app.cheekycheese.tech`): a protected workspace at root `/` (the `/crm` route prefix was removed at the domain split on 2026-06-21), Google SSO only (manual OAuth, JWT HttpOnly cookie)
- 5 RBAC roles: `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT` (+ DROP payment-routing on top)

## Pointer map (where the truth lives)

- **Project language** (domain glossary; a term from `_Avoid_` = a review finding) → `CONTEXT.md` (root)
- Phases and status, RBAC matrix, business rules, migrations, schemas, auth, tech gotchas → `.claude/agents/project-state.md`
- Cross-agent rules — entry point (TOC) → `.claude/RULES.md`
- Specific rules: MCP-first, git-policy, zone-of-write, versions, language, skills triggers → `.claude/rules/common/*.md` (auto-loaded)
- **Why a rule says what it says** (incidents, precedents, rejected alternatives) → `docs/architecture/rules-rationale/<rule>.md` (NOT auto-loaded — read on demand)
- Light vs full development track → `.claude/rules/common/light-track.md`
- **How much human a decision needs** (A1 decide yourself / A2 accumulate / A3 stop) → `.claude/rules/common/autonomy-levels.md` + `.claude/skills/decision-frontier/`
- What to do with context at a phase boundary (continue / clear / handoff / subagent / compact) → `.claude/rules/common/phase-boundaries.md`
- Actions only the owner can perform (and how to kill them) → `docs/runbooks/human-only.md`
- Deliberately rejected requests (so they are not reconsidered again) → `.out-of-scope/README.md`
- Claude Design UI gate + workflow → `.claude/rules/common/design-gate.md` + `.claude/skills/claude-design-workflow/`
- Workflow/fan-out vs agent vs light-track (degree of parallelism) + codebase-audit → `.claude/rules/common/orchestration-routing.md` + `.claude/skills/codebase-audit/`
- Agent system prompts (start — README) → `.claude/agents/<agent>.md`
- Cross-agent state machine → `.claude/agents/contracts.md`
- Active task files → `.claude/tasks/`
- ADRs, deliverables, RCA → `docs/architecture/`
- Business docs → `docs/business/`
- Legal contract drafts → `docs/legal/`
- Agent lessons → `.claude/agents/memory/<agent>/lessons.md`

## Stack (summary)

Turborepo + pnpm · **web:** React + Vite SPA (NOT TanStack Start) + TanStack Router/Query/Form +
Tailwind v4 + shadcn/ui + Framer Motion · **api:** NestJS 11 + Fastify + Drizzle ORM (PostgreSQL) +
Redis · **validation:** Zod v4, all API through `.parse()`, types from `@crm/shared` ·
**tests:** Vitest (unit) + Playwright (E2E).

Exact versions, EXACT pins (the TanStack pair!) and forbidden overrides —
`.claude/rules/common/version-pins.md`. Do not bump anything outside that file.

## Monorepo structure

```
apps/web        # Vite SPA + TanStack Router (:3000), entry app/client.tsx
apps/api        # NestJS 11 + Fastify (:3001)
apps/e2e        # Playwright E2E
packages/shared # Zod schemas + types (Single Source of Truth)
```

## Commands

```bash
pnpm dev | build | typecheck | test            # all packages (turbo)
pnpm --filter @crm/web|@crm/api|@crm/e2e <cmd> # a single package
pnpm --filter @crm/api db:push | db:seed       # Drizzle: schema sync (push) / seed
docker-compose up -d                           # Postgres + Redis locally
```

## Multi-agent team

**Master (USER session) — the orchestrator.** Dispatches agents locally via the `Agent` tool
(`isolation=worktree` for writers) and runs orchestration itself. There is no separate PM agent
(removed 2026-10-05; details — `contracts.md`). The agent GHA workflows in
`.github/workflows/archive/` are stale, do not use them.

- Master (USER session) — orchestrator: decomposition into task files (`.claude/tasks/`) → dispatch in waves → monitoring → aggregate verdict → label gating → User Testing; agent infrastructure; light track
- Coder / AutoTest / DevOps — implementation / E2E specs / CI-CD, each in its own zone-of-write
- spec-reviewer — second review axis: diff ↔ task (uncovered AC / scope creep)
- code-reviewer + security-reviewer — review; security-reviewer is MANDATORY for auth/finance/RBAC
- copy-reviewer — review of client/candidate-facing text (multilingual)
- manual-qa / ui-ux-designer / legal / architect — visual QA on the real stack / design / legal / ADR (ad-hoc)

**Development flow:** Master decomposes a task → task files (`.claude/tasks/`) →
dispatch of agents (in waves) → PR → review agents (all H/M/L findings are resolved) →
ad-hoc manual-qa User Testing → an explicit "merge it" from USER →
label `merge-approved` (only Master/owner sets it) → CI squash-merge.
**Light track** (small edits without ceremony): `.claude/rules/common/light-track.md`.

## Status

Phases, current focus and open directions — **only** in `.claude/agents/project-state.md` §1. A dated
snapshot in an always-loaded file goes stale silently.

## Session minimum

Auto-loaded from `.claude/rules/common/` — here only a reminder that they exist: MCP-first ·
git-policy (no `--no-verify`, explicit `git add`, `ac_verified:`) · language-policy (English in repo +
agent output, Russian only owner-chat) · zone-of-write · skills triggers · version-pins · light-track
· autonomy-levels (gather facts yourself, decide the reversible yourself on the record) ·
phase-boundaries · model-routing (which tier for which task) · orchestration-routing (degree of
parallelism). Loaded only when UI files are touched: design-gate (any UI → designer-in-the-loop) ·
responsive-design (mobile/tablet/laptop/large — hard gate) · design-fidelity-review
(mockup↔localhost on all screens — gate before merge).

Beyond the rules: E2E locally before pushing code (docs-only diff is exempt — see light-track);
merging a PR — **only** on an explicit confirmation from USER in the chat.
