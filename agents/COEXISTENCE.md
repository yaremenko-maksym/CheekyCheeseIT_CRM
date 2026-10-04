# Agents — два набора промптов

Статус на 2026-10-05. Прежняя версия описывала Phase 3 как «предстоящую» и ссылалась на
`reviewer.md` / `CLAUDE-pm.md` / `CLAUDE-coder.md` / `CLAUDE-reviewer.md` / `CLAUDE-devops.md` —
этих файлов нет (стабы удалены 2026-06-16, reviewer разделён на `code-reviewer` + `security-reviewer`).

## Active — рабочие агенты проекта

`.claude/agents/*.md`. Актуальный список и роли — `.claude/agents/README.md`; здесь не дублируется.
Из `CLAUDE-*.md` жив только `.claude/agents/CLAUDE-legal.md` (операционные заметки legal).

## Reference — каталог ECC (read-only)

`agents/*.md` — копия каталога агентов ECC v2.0.0-rc.1 (pin — `ecc-pin.txt`) как образец формата
и источник для точечного вызова. Не редактировать: это upstream-референс.
Имена в каталоге могут совпадать с нашими (`architect`, `code-reviewer`) — **наши лежат в `.claude/agents/`**.

## Источники

- `.claude/agents/README.md` — актуальный реестр агентов
- `docs/architecture/2026-05-31-ecc-migration-design.md` — ADR миграции (историческое)
