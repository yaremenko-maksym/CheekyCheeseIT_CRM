# Phase 7 — Namespace Cleanup: `.claude/` для AI, `docs/` для project documentation

**Дата:** 2026-06-03
**Автор:** Architect agent
**Статус:** Implemented (rolling PR pending)
**Предшественники:** ECC migration Phase 6 (ADR § ECC migration design 2026-05-31, PR #94)
**Цель:** строгое разделение AI-инфраструктуры и project documentation после завершения ECC миграции.

---

## 1. Контекст и rationale

После Phase 6 ECC migration все агенты, хуки, правила и task state продолжали жить в `docs/agents/`, `docs/specs/`, `rules/` и `docs/legal/`. Это работало, но создавало смешение двух разных уровней документации:

- **AI infrastructure** (agent prompts, hooks, skills, rules, state, task files, legal KB) — то что Claude Code и custom agents читают/пишут как часть operational workflow.
- **Project documentation** (architecture decisions, business modules, README) — то что человек читает чтобы понять проект.

USER явно запросил это разделение:

> «Перенеси всех агентов в `.claude/agents` так максимально нативно»
> «В папке `docs/` только описание проекта и документациях»
> «Всё что относится к АИ должно быть в папке `.claude/`»

Дополнительно: native Claude Code convention требует чтобы project-level subagents лежали в `.claude/agents/<name>.md` для discoverability через `Agent(subagent_type="...")` matching. До Phase 7 наши агенты не были activable таким способом.

---

## 2. Mapping table (что куда переехало)

### 2.1. Старый → новый путь

| Старый путь                                        | Новый путь                                            | Категория                                                                 |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/agents/<agent>.md`                           | `.claude/agents/<agent>.md`                           | Agent system prompts                                                      |
| `docs/agents/CLAUDE-<agent>.md`                    | `.claude/agents/CLAUDE-<agent>.md`                    | Agent stubs (legacy compat)                                               |
| `docs/agents/memory/<agent>/lessons{,.archive}.md` | `.claude/agents/memory/<agent>/lessons{,.archive}.md` | Per-agent memory                                                          |
| `docs/agents/pm-snippets.md`                       | `.claude/agents/pm-snippets.md`                       | PM on-demand snippets                                                     |
| `docs/agents/RULES.md`                             | `.claude/RULES.md`                                    | Cross-agent rules (top-level в `.claude/`)                                |
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
| `.claude/hooks-ecc/`                               | `.claude/hooks/`                                      | Active ECC hooks (rename, старая `.claude/hooks/` была удалена в Phase 6) |
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

### 2.2. Convention для PM briefs

Generic PM brief path (раньше `docs/specs/pm-brief.md`, генерируемый BA workflow) теперь конвенционально:

```
.claude/briefs/pm-brief.md                 — current PM brief from BA
.claude/briefs/pm-brief-legal-check.md     — Legal agent Mode C output
.claude/briefs/pm-brief-<topic>.md         — topic-specific briefs
.claude/briefs/<feature>-brief.md          — feature briefs (e.g. onboarding-brief)
```

---

## 3. Что осталось в `docs/`

После Phase 7 `docs/` содержит ИСКЛЮЧИТЕЛЬНО project documentation:

```
docs/
├── README.md                          — project doc tree
├── architecture/                      — ADRs, deliverables, retrospectives
│   ├── 2026-05-31-architect-discovery-report.md
│   ├── 2026-05-31-ecc-migration-design.md
│   ├── 2026-06-03-phase{2..6}-deliverable.md
│   └── 2026-06-03-phase7-namespace-cleanup.md  ← this doc
├── business/                          — business modules + roles
│   └── roles/ba.md                    — BA role doc (human, not LLM agent)
├── escalations/                       — escalation tracking (project ops)
├── runbooks/                          — ops runbooks (s3, user-testing-tunnel)
├── superpowers/                       — implementation plans
├── test-cases/                        — E2E test scenarios
└── verify/                            — verification screenshots
```

`docs/runbooks/`, `docs/superpowers/`, `docs/test-cases/`, `docs/verify/`, `docs/escalations/` — это операционные артефакты проекта (плэны, скриншоты, runbooks). Они не являются AI infrastructure, поэтому остаются в `docs/`.

---

## 4. Новая `.claude/` структура

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

`.claude/settings.json` после Phase 2.5 содержал хуки с абсолютными путями на `/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/hooks-ecc/`. После rename `hooks-ecc → hooks` обновлены 5 references:

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

Hook scripts сами не содержат references на `hooks-ecc/` (проверено `grep -l "hooks-ecc" .claude/hooks/*.sh` — нет совпадений).

---

## 6. Internal refs update

Run в 2 прохода:

**Pass 1** — 42 файла updated, 457 строк изменено. Правила:

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

**Pass 2** — 12 файлов updated, 31 строка. Правила для остаточных briefs convention:

- `docs/specs/pm-brief.md` → `.claude/briefs/pm-brief.md`
- `docs/specs/pm-brief-<slug>.md` → `.claude/briefs/pm-brief-<slug>.md`
- regex fallback на `docs/specs/<file>.md` → `.claude/briefs/<file>.md`
- bare `docs/specs/` (без следующего символа) → `.claude/briefs/`

**Итого:** 54 уникальных файла, 488 строк refs обновлено.

### Файлы, ref-ы в которых НЕ трогали:

- `.claude/agents/CHANGES.md` — historical changelog (Phase 1-6 entries описывают прошлое)
- `.claude/agents/archive/qa.md` — архивированный QA агент (deprecated)
- `.claude/agents/specs/2026-05-20-productive-pipeline-design.md` — historical design spec
- `.claude/briefs/onboarding-brief.md` и др. briefs — signed-off historical
- `.claude/knowledge/legal-consultations/*.md` — finalized Legal outputs
- `.claude/state/events.md` — historical event log
- `.claude/agents/memory/<X>/lessons.archive.md` — archived lessons
- `docs/architecture/2026-XX-XX-*.md` — ADRs описывают past state (refs на старые пути legitimate)

---

## 7. Activation impact

После Phase 7 native Claude Code subagent discovery работает: harness ищет project-level agents в `.claude/agents/<name>.md`. Это значит:

- `Agent(subagent_type="code-reviewer", ...)` — теперь резолвится напрямую в `.claude/agents/code-reviewer.md`
- `Agent(subagent_type="security-reviewer", ...)` — `.claude/agents/security-reviewer.md`
- `Agent(subagent_type="legal", ...)` — `.claude/agents/legal.md`
- ... и так далее для всех 9 активных агентов

Ранее эти агенты были discoverable только через `general-purpose` + manual prompt с указанием путей к `docs/agents/<X>.md`. Phase 7 включает native flow.

ECC catalog в `agents/` (root, 62 reference agents from ECC v2.0.0-rc.1) остаётся отдельно — это upstream reference catalog, не наши project agents. PM/Coder/AutoTest/etc по-прежнему могут invoke ECC catalog agents (planner, tdd-guide, typescript-reviewer) через `Agent(subagent_type="<ecc-name>")` — Claude Code harness matchает оба namespace (project + ECC catalog в `agents/`).

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
# Each hook fed test JSON, should exit 0 (allow) for benign tool-call
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
# expected: empty (rename complete) or только historical ADR docs

git grep -E "^(rules/|  rules/)" .
# expected: empty (all moved to .claude/rules/)
```

### 8.4. pm-state.json LIVE content preserved

```bash
git log -p .claude/state/pm-state.json
# expected: shows only rename from docs/specs/pm-state.json; no content diff
```

---

## 9. Risks & mitigations

| Risk                                                                              | Likelihood | Impact                                          | Mitigation                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ---------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook scripts перестали работать после rename                                      | Low        | High (CI blocks/ no zone-of-write enforcement)  | Smoke tests § 8.2 после каждого hook                                                                                                                                                      |
| Stale refs в historical docs ломают tooling                                       | Low        | Low (historical docs не consumed автоматически) | Не трогаем historical, документируем в § 6                                                                                                                                                |
| PM не находит pm-state.json в новом месте                                         | Medium     | High (orchestration breaks)                     | pm-snippets.md обновлён, pm.md обновлён, schema events.md обновлён                                                                                                                        |
| GHA workflows ссылаются на старые пути                                            | Low        | Medium (workflow fail)                          | Только `.github/workflows/ecc-code-review.yml` имел ref → updated                                                                                                                         |
| Subagent discovery всё ещё matches ECC catalog `agents/` вместо `.claude/agents/` | Low        | Low (overlap имен — minimal)                    | Имена project agents (pm, coder, autotest, devops, legal, code-reviewer, security-reviewer, architect, reviewer) различаются с ECC catalog (planner, tdd-guide, typescript-reviewer, etc) |

---

## 10. Что дальше

Phase 7 завершает крупную ECC migration. Дальнейшие шаги (out of scope):

- **Continuous improvement**: lessons rotation, skill viability re-audit
- **Phase 8**: Smart-contract Phase (USDT ERC-20) — не AI infrastructure, проектная работа
- **Phase 9**: Dashboard — проектная работа

ECC migration tracking (`docs/architecture/ecc-reference/`) остаётся в `docs/` — это upstream reference материал, не наша operational AI infrastructure.

---

## Ссылки

- Phase 6 retrospective: `docs/architecture/2026-06-03-ecc-migration-retrospective.md`
- Phase 6 deliverable: `docs/architecture/2026-06-03-phase6-deliverable.md`
- ECC migration design: `docs/architecture/2026-05-31-ecc-migration-design.md`
- Architect audit: `.claude/agents/architect-audit.md`
- ECC user guide: `docs/architecture/2026-05-31-ecc-user-guide.md`
