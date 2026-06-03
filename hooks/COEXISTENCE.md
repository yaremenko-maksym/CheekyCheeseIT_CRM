# Hooks — Coexistence Status (Phase 1)

## Текущее состояние (после Phase 1)

В этом проекте сосуществуют **два набора hooks**:

### Active (production)

**`.claude/hooks/*.sh`** + `.claude/settings.json` — наши 5 hooks работают и обслуживают daily workflow:

- `safety.sh` — блокировка dangerous commands
- `block-production-edits.sh` — zone-of-write enforcement
- `coder-pre-push.sh` — D3 AC verification gate
- `coder-progress-marker.sh` — Layer 8.1.1 intent marker
- `eslint-feedback.sh` — post-edit lint feedback

Эти hooks **продолжают работать как есть**. Не удалять до Phase 2 миграции + 1 неделя coexistence period.

### Reference (ECC catalog, не активный)

**`hooks/hooks.json`** + `hooks/memory-persistence/` + `hooks/README.md` — скопированы из ECC v2.0.0-rc.1 для:

- Format reference (JSON matcher syntax)
- Pattern reference (PreToolUse, PostToolUse, Stop, SessionStart, PreCompact, SessionEnd)
- Source для Phase 2 миграции (наши `.sh` будут переписаны в этот формат)

**ECC hooks НЕ зарегистрированы** в `.claude/settings.json` — они dormant.

## Phase 2 миграция (предстоит)

Согласно ADR Section 6 Phase 2:

1. Каждый из наших 5 `.sh` hooks портируется в ECC JSON matcher format
2. Specific matchers вместо catch-all (`tool == "Bash" && tool_input.command matches "git push"` instead of just `matcher: "Bash"`)
3. D1-D4 watchdog resilience preserved (smoke test каждый ported hook против original failure case)
4. После 1 недели stability → удаление old `.sh` files (Phase 6 cleanup)

## Что НЕ делать в этом файле / директории

- Не редактировать `hooks/hooks.json` напрямую — это ECC upstream reference
- Не регистрировать ECC hooks в `.claude/settings.json` до Phase 2
- При желании protoype новый hook — создать рядом с старым `.claude/hooks/`, не подменять

## Источники

- ADR Section 2.2 — per-hook migration decisions
- ADR Section 6 Phase 2 — full plan
- Hooks reference: `hooks/README.md` (ECC upstream copy)
- Coexistence pattern из architect.md ("Двойная работа допустима в transition period")
