# Phase 7 — Namespace Cleanup: `.claude/` for AI, `docs/` for project documentation

**Date:** 2026-06-03
**Author:** Architect agent
**Status:** Implemented (rolling PR pending)
**Predecessors:** ECC migration Phase 6 (ADR § ECC migration design 2026-05-31, PR #94)
**Goal:** a strict separation of AI infrastructure and project documentation after the ECC migration is complete.

---

## 1. Context and rationale

After Phase 6 of the ECC migration, all agents, hooks, rules and task state continued to live in `docs/agents/`, `docs/specs/`, `rules/` and `docs/legal/`. This worked, but created a mixing of two different documentation levels:

- **AI infrastructure** (agent prompts, hooks, skills, rules, state, task files, legal KB) — what Claude Code and custom agents read/write as part of the operational workflow.
- **Project documentation** (architecture decisions, business modules, README) — what a human reads to understand the project.

USER explicitly requested this separation:

> "Move all the agents into `.claude/agents` as natively as possible"
> "In the `docs/` folder only the description of the project and documentation"
> "Everything related to AI should be in the `.claude/` folder"

Additionally: the native Claude Code convention requires project-level subagents to live in `.claude/agents/<name>.md` for discoverability via `Agent(subagent_type="...")` matching. Before Phase 7 our agents were not activatable that way.

---

## 2. Mapping table (what moved where)

### 2.1. Old → new path

| Old path                                           | New path                                              | Category                                                                  |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/agents/<agent>.md`                           | `.claude/agents/<agent>.md`                           | Agent system prompts                                                      |
| `docs/agents/CLAUDE-<agent>.md`                    | `.claude/agents/CLAUDE-<agent>.md`                    | Agent stubs (legacy compat)                                               |
| `docs/agents/memory/<agent>/lessons{,.archive}.md` | `.claude/agents/memory/<agent>/lessons{,.archive}.md` | Per-agent memory                                                          |
| `docs/agents/pm-snippets.md`                       | `.claude/agents/pm-snippets.md`                       | PM on-demand snippets                                                     |
| `docs/agents/RULES.md`                             | `.claude/RULES.md`                                    | Cross-agent rules (top-level in `.claude/`)                               |
| `docs/agents/README.md`                            | `.claude/agents/README.md`                            | Agents directory README                                                   |
| `docs/agents/contracts.md`                         | `.claude/agents/contracts.md`                         | Cross-agent state machine                                                 |
| `docs/agents/CHANGES.md`                           | `.claude/agents/CHANGES.md`                           | Multi-agent docs changelog                                                |
| `docs/agents/CLAUDE-tools.md`                      | `.claude/agents/CLAUDE-tools.md`                      | Tools reference                                                           |
| `docs/agents/project-state.md`                     | `.claude/agents/project-state.md`                     | Phases/migrations/RBAC SSOT                                               |
| `docs/agents/architect-audit.md`                   | `.claude/agents/architect-audit.md`                   | Architecture audit doc                                                    |
| `docs/agents/architecture-v2.md`                   | `.claude/agents/architecture-v2.md`                   | Architecture v2 design                                                    |
| `docs/agents/specs/`                               | `.claude/agents/specs/`                               | Historical design specs (productive pipeline)                             |
| `docs/agents/archive/`                             | `.claude/agents/archive/`                             | Archived agent prompts (qa)                                               |
| `rules/common/`                                    | `.claude/rules/common/`                               | Cross-agent common rules                                                  |
| `rules/ecc/`                                       | `.claude/rules/ecc/`                                  | ECC catalog rules (typescript/web)                                        |
| `.claude/hooks-ecc/`                               | `.claude/hooks/`                                      | Active ECC hooks (rename, the old `.claude/hooks/` was deleted in Phase 6) |
| `docs/specs/pm-state.json`                         | `.claude/state/pm-state.json`                         | LIVE PM state                                                             |
| `docs/specs/pm-state-events.md`                    | `.claude/state/events.md`                             | Event schema docs                                                         |
| `docs/specs/tasks/`                                | `.claude/tasks/`                                      | PM task files                                                             |
| `docs/specs/onboarding-brief.md`                   | `.claude/briefs/onboarding-brief.md`                  | Active brief                                                              |
| `docs/specs/pm-brief-invoice-signing.md`           | `.claude/briefs/pm-brief-invoice-signing.md`          | Brief epic spec                                                           |
| `docs/specs/drop-role-and-finance-spec.md`         | `.claude/briefs/drop-role-and-finance-spec.md`        | Drop-role epic spec                                                       |
| `docs/specs/2026-05-2{0,1}-*.md`                   | `.claude/briefs/2026-05-2{0,1}-*.md`                  | Historical design briefs                                                  |
| `docs/specs/legal-consultations/`                  | `.claude/knowledge/legal-consultations/`              | Legal agent KB outputs                                                    |
| `docs/specs/archive/`                              | `.claude/state/archive/`                              | Historical PM active-task snapshots                                       |
| `docs/legal/`                                      | `.claude/knowledge/legal/`                            | UA jurisdictional KB (Legal agent)                                        |
| `.claude/skills/`                                  | `.claude/skills/`                                     | UNCHANGED (already there)                                                 |
| `.claude/settings.json`                            | `.claude/settings.json`                               | UNCHANGED location, hook paths updated                                    |

### 2.2. Convention for PM briefs

The generic PM brief path (formerly `docs/specs/pm-brief.md`, generated by the BA workflow) is now, by convention:

```
.claude/briefs/pm-brief.md                 — current PM brief from BA
.claude/briefs/pm-brief-legal-check.md     — Legal agent Mode C output
.claude/briefs/pm-brief-<topic>.md         — topic-specific briefs
.claude/briefs/<feature>-brief.md          — feature briefs (e.g. onboarding-brief)
```

---

## 3. What remained in `docs/`

After Phase 7, `docs/` contains EXCLUSIVELY project documentation:

```
docs/
├── README.md                          — project doc tree
├── architecture/                      — ADRs, deliverables, retrospectives
│   ├── 2026-05-31-architect-discovery-report.md
│   ├── 2026-05-31-ecc-migration-design.md
│   ├── 2026-06-03-phase{2..6}-deliverable.md
│   └── 2026-06-03-phase7-namespace-cleanup.md  ← this doc
├── business/                          — business modules + roles
│   └── roles/ba.md                    — BA role doc (human, not an LLM agent)
├── escalations/                       — escalation tracking (project ops)
├── runbooks/                          — ops runbooks (s3, user-testing-tunnel)
├── superpowers/                       — implementation plans
├── test-cases/                        — E2E test scenarios
└── verify/                            — verification screenshots
```

`docs/runbooks/`, `docs/superpowers/`, `docs/test-cases/`, `docs/verify/`, `docs/escalations/` — these are operational project artifacts (plans, screenshots, runbooks). They are not AI infrastructure, so they remain in `docs/`.

---

## 4. New `.claude/` structure

```
.claude/
├── RULES.md                           ← cross-agent rules (was docs/agents/RULES.md)
├── settings.json                      ← hook paths now point to .claude/hooks/
├── agents/                            ← 9 active agents + memory + archives
│   ├── architect.md
│   ├── autotest.md
│   ├── code-reviewer.md
│   ├── coder.md
│   ├── devops.md
│   ├── legal.md
│   ├── pm.md
│   ├── reviewer.md                    ← deprecated shim (Phase 3b)
│   ├── security-reviewer.md
│   ├── CLAUDE-<agent>.md              ← legacy stubs
│   ├── pm-snippets.md
│   ├── contracts.md
│   ├── README.md
│   ├── CHANGES.md
│   ├── architecture-v2.md
│   ├── architect-audit.md
│   ├── project-state.md
│   ├── memory/<agent>/lessons{,.archive}.md
│   ├── specs/                         ← historical design specs
│   └── archive/                       ← retired agents (qa)
├── briefs/                            ← BA→PM briefs, epic specs
│   ├── onboarding-brief.md
│   ├── pm-brief-invoice-signing.md
│   └── ...
├── hooks/                             ← active ECC hooks (renamed from hooks-ecc)
│   ├── pre-bash-safety.sh
│   ├── pre-bash-coder-push-gate.sh
│   ├── pre-edit-write-zone-of-write.sh
│   ├── pre-edit-write-suggest-compact.sh
│   └── post-edit-write-coder-progress.sh
├── knowledge/                         ← AI-consumed reference KB
│   ├── legal/                         ← UA jurisdictional rules (was docs/legal/)
│   └── legal-consultations/           ← Legal agent outputs archive
├── rules/                             ← was rules/ at repo root
│   ├── common/                        ← cross-agent: mcp-first, git-policy, etc
│   └── ecc/                           ← ECC catalog: common/typescript/web
├── skills/                            ← UNCHANGED (8 skills, project-level)
├── state/                             ← PM live state
│   ├── pm-state.json                  ← LIVE (content preserved verbatim)
│   ├── events.md                      ← event schema documentation
│   └── archive/                       ← historical active-task snapshots
└── tasks/                             ← PM task files
    ├── task-*.md
    ├── archive/
    └── templates/
```

---

## 5. Settings.json hook paths update

`.claude/settings.json` after Phase 2.5 contained hooks with absolute paths to `/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/`. After the rename `hooks-ecc → hooks`, 5 references were updated:

```diff
- bash /.../.claude/hooks-ecc/pre-bash-safety.sh
+ bash /.../.claude/hooks/pre-bash-safety.sh
- bash /.../.claude/hooks-ecc/pre-bash-coder-push-gate.sh
+ bash /.../.claude/hooks/pre-bash-coder-push-gate.sh
- bash /.../.claude/hooks-ecc/pre-edit-write-zone-of-write.sh
+ bash /.../.claude/hooks/pre-edit-write-zone-of-write.sh
- bash /.../.claude/hooks-ecc/pre-edit-write-suggest-compact.sh
+ bash /.../.claude/hooks/pre-edit-write-suggest-compact.sh
- bash /.../.claude/hooks-ecc/post-edit-write-coder-progress.sh
+ bash /.../.claude/hooks/post-edit-write-coder-progress.sh
```

The hook scripts themselves contain no references to `hooks-ecc/` (verified with `grep -l "hooks-ecc" .claude/hooks/*.sh` — no matches).

---

## 6. Internal refs update

Run in 2 passes:

**Pass 1** — 42 files updated, 457 lines changed. Rules:

- `docs/agents/RULES.md` → `.claude/RULES.md`
- `docs/agents/<X>` → `.claude/agents/<X>`
- `docs/specs/pm-state.json` → `.claude/state/pm-state.json`
- `docs/specs/pm-state-events.md` → `.claude/state/events.md`
- `docs/specs/tasks/` → `.claude/tasks/`
- `docs/specs/legal-consultations/` → `.claude/knowledge/legal-consultations/`
- `docs/specs/archive/` → `.claude/state/archive/`
- `docs/specs/{onboarding-brief, pm-brief-invoice-signing, drop-role-and-finance-spec, 2026-05-*}` → `.claude/briefs/`
- `docs/legal/` → `.claude/knowledge/legal/`
- `.claude/hooks-ecc/` → `.claude/hooks/`
- `rules/{common,ecc}/` → `.claude/rules/{common,ecc}/`
- standalone `hooks-ecc/` → `hooks/`

**Pass 2** — 12 files updated, 31 lines. Rules for the remaining briefs convention:

- `docs/specs/pm-brief.md` → `.claude/briefs/pm-brief.md`
- `docs/specs/pm-brief-<slug>.md` → `.claude/briefs/pm-brief-<slug>.md`
- regex fallback on `docs/specs/<file>.md` → `.claude/briefs/<file>.md`
- bare `docs/specs/` (without a following character) → `.claude/briefs/`

**Total:** 54 unique files, 488 lines of refs updated.

### Files whose refs were NOT touched:

- `.claude/agents/CHANGES.md` — historical changelog (Phase 1-6 entries describe the past)
- `.claude/agents/archive/qa.md` — the archived QA agent (deprecated)
- `.claude/agents/specs/2026-05-20-productive-pipeline-design.md` — historical design spec
- `.claude/briefs/onboarding-brief.md` and other briefs — signed-off historical
- `.claude/knowledge/legal-consultations/*.md` — finalized Legal outputs
- `.claude/state/events.md` — historical event log
- `.claude/agents/memory/<X>/lessons.archive.md` — archived lessons
- `docs/architecture/2026-XX-XX-*.md` — ADRs describe past state (refs to old paths are legitimate)

---

## 7. Activation impact

After Phase 7, native Claude Code subagent discovery works: the harness looks for project-level agents in `.claude/agents/<name>.md`. This means:

- `Agent(subagent_type="code-reviewer", ...)` — now resolves directly to `.claude/agents/code-reviewer.md`
- `Agent(subagent_type="security-reviewer", ...)` — `.claude/agents/security-reviewer.md`
- `Agent(subagent_type="legal", ...)` — `.claude/agents/legal.md`
- ... and so on for all 9 active agents

Previously these agents were discoverable only via `general-purpose` + a manual prompt specifying paths to `docs/agents/<X>.md`. Phase 7 enables the native flow.

The ECC catalog in `agents/` (root, 62 reference agents from ECC v2.0.0-rc.1) remains separate — it is the upstream reference catalog, not our project agents. PM/Coder/AutoTest/etc can still invoke ECC catalog agents (planner, tdd-guide, typescript-reviewer) via `Agent(subagent_type="<ecc-name>")` — the Claude Code harness matches both namespaces (project + ECC catalog in `agents/`).

---

## 8. Verification

### 8.1. Structure verify

```bash
ls .claude/agents/ | head           # 9 agents + memory/ + archive/ + specs/ + README + ...
ls .claude/hooks/                   # 5 hooks
ls .claude/skills/                  # 8 skills (unchanged)
ls .claude/rules/                   # common/ + ecc/
ls .claude/state/                   # pm-state.json + events.md + archive/
ls .claude/tasks/                   # ~100 task files + archive/ + templates/
ls .claude/knowledge/               # legal/ + legal-consultations/
ls .claude/briefs/                  # 6 briefs
ls docs/agents 2>&1                 # No such file or directory  ← OK
ls docs/specs 2>&1                  # No such file or directory  ← OK
ls docs/legal 2>&1                  # No such file or directory  ← OK
ls rules 2>&1                       # No such file or directory  ← OK
```

### 8.2. Hook smoke tests

```bash
# Each hook fed test JSON, should exit 0 (allow) for a benign tool-call
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | bash .claude/hooks/pre-bash-safety.sh
echo "exit: $?"  # expected: 0

echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m \"ac_verified: yes\""}}' \
  | bash .claude/hooks/pre-bash-coder-push-gate.sh
echo "exit: $?"  # expected: 0 (or 2 if branch+push gate triggers — benign for `commit`)

echo '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.md"}}' \
  | bash .claude/hooks/pre-edit-write-zone-of-write.sh
echo "exit: $?"  # expected: 0

echo '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.md"}}' \
  | bash .claude/hooks/pre-edit-write-suggest-compact.sh
echo "exit: $?"  # expected: 0

echo '{"tool_name":"Edit","tool_input":{"file_path":"/tmp/foo.md"}}' \
  | bash .claude/hooks/post-edit-write-coder-progress.sh
echo "exit: $?"  # expected: 0
```

### 8.3. Refs verify (no leakage)

```bash
git grep -E "docs/(agents|specs|legal)/[a-zA-Z]" .claude/ AGENTS.md docs/README.md CLAUDE.md
# expected: empty in active operational files; matches only in historical (CHANGES.md, archive/, specs/, briefs/, knowledge/legal-consultations/, events.md, lessons.archive.md)

git grep -E "hooks-ecc/" .
# expected: empty (rename complete) or only historical ADR docs

git grep -E "^(rules/|  rules/)" .
# expected: empty (all moved to .claude/rules/)
```

### 8.4. pm-state.json LIVE content preserved

```bash
git log -p .claude/state/pm-state.json
# expected: shows only the rename from docs/specs/pm-state.json; no content diff
```

---

## 9. Risks & mitigations

| Risk                                                                              | Likelihood | Impact                                          | Mitigation                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ---------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook scripts stopped working after the rename                                     | Low        | High (CI blocks / no zone-of-write enforcement) | Smoke tests § 8.2 after each hook                                                                                                                                                        |
| Stale refs in historical docs break tooling                                       | Low        | Low (historical docs are not consumed automatically) | We do not touch historical, we document it in § 6                                                                                                                                       |
| PM does not find pm-state.json in the new location                                | Medium     | High (orchestration breaks)                     | pm-snippets.md updated, pm.md updated, the events.md schema updated                                                                                                                      |
| GHA workflows reference old paths                                                 | Low        | Medium (workflow fail)                          | Only `.github/workflows/ecc-code-review.yml` had a ref → updated                                                                                                                         |
| Subagent discovery still matches the ECC catalog `agents/` instead of `.claude/agents/` | Low        | Low (name overlap — minimal)                    | The names of the project agents (pm, coder, autotest, devops, legal, code-reviewer, security-reviewer, architect, reviewer) differ from the ECC catalog (planner, tdd-guide, typescript-reviewer, etc) |

---

## 10. What's next

Phase 7 concludes the large ECC migration. Further steps (out of scope):

- **Continuous improvement**: lessons rotation, skill viability re-audit
- **Phase 8**: Smart-contract Phase (USDT ERC-20) — not AI infrastructure, project work
- **Phase 9**: Dashboard — project work

The ECC migration tracking (`docs/architecture/ecc-reference/`) remains in `docs/` — it is upstream reference material, not our operational AI infrastructure.

---

## Links

- Phase 6 retrospective: `docs/architecture/2026-06-03-ecc-migration-retrospective.md`
- Phase 6 deliverable: `docs/architecture/2026-06-03-phase6-deliverable.md`
- ECC migration design: `docs/architecture/2026-05-31-ecc-migration-design.md`
- Architect audit: `.claude/agents/architect-audit.md`
- ECC user guide: `docs/architecture/2026-05-31-ecc-user-guide.md`
