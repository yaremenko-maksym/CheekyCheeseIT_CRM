# Skills — CheekyCheeseIT CRM

## Структура

```
skills/
├── ecc/               — 36 ECC first-party skills (Phase 1, selective subset)
│   ├── nestjs-patterns/
│   ├── frontend-patterns/
│   ├── tdd-workflow/
│   ├── e2e-testing/
│   ├── defi-amm-security/   (Q4 security additions)
│   ├── evm-token-decimals/  (Q4 security additions)
│   └── ...
└── (custom skills appear here in Phase 4+)
```

## ECC skills (Phase 1)

Selectively imported из ECC v2.0.0-rc.1 `developer` + `security` profile relevant subset (36 skills total). Перечень см. `ls skills/ecc/`.

Каждая ECC skill:

- Имеет `SKILL.md` с YAML frontmatter (`name`, `description`, `origin: ECC`)
- Не редактируется напрямую — это upstream reference
- Активируется автоматически когда Claude видит триггер из `When to Activate` секции

## Custom skills (Phase 4+)

Phase 4 миграции создаст custom skills из существующих `docs/agents/memory/<role>/lessons.md`:

- `pm-mode-orchestration/SKILL.md` — PM Mode 1-5 decision tree
- `cross-session-orchestration/SKILL.md` — Layer 2 ScheduleWakeup pattern
- `user-testing-tunnel/SKILL.md` — prep-user-testing.sh + Serveo
- `dev-flow-resilience/SKILL.md` — D1-D4 fixes documentation
- `recruiting-domain-rules/SKILL.md` — business invariants (max 1 active junior, RBAC matrix)
- `code-review-discipline/SKILL.md` — write-then-post, BLOCK verdict (delta vs ECC code-reviewer)
- UA-legal stubs (5 skills): `ua-tax-compliance`, `ua-cfc-rules`, `ua-crypto-regulation`, `ua-banking-caps`, `legal-escalation-patterns`

`origin: custom` в frontmatter всех project skills.

## Lessons.md coexistence

`docs/agents/memory/<role>/lessons.md` **сохраняются** даже после Phase 4 conversion:

- Lessons.md = append-log для новых observations
- skills/ = canonical workflow surface (per ECC RULES.md)
- Periodic Phase 6+ consolidation: новые atomic lessons → existing skill OR new skill

## Workflow Surface Policy (per ECC AGENTS.md)

- `skills/` — canonical workflow surface (адопт в Phase 4)
- `commands/` — legacy slash-entry, **НЕ адаптируем** в этой миграции (low priority per ADR Section 1.1)

## Источники

- ADR Section 2.4 — per-lessons.md migration plan
- ADR Section 6 Phase 4 — full skill creation plan
- ECC Skill format spec: `RULES.md` "Skill Format" section
