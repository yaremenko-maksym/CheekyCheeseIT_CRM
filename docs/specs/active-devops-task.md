# Fix AI Review — allow bot-created PRs

## Контекст

AI Review workflow завершается с ошибкой на PR-ах созданных `claude[bot]` (Coder, AutoTest агенты):

```
Workflow initiated by non-human actor: claude (type: Bot).
Add bot to allowed_bots list or use '*' to allow all bots.
```

`mode: tag` в `anthropics/claude-code-action@beta` по умолчанию блокирует bot-акторов как security measure.
Нам нужно разрешить `claude[bot]` запускать AI Review, так как весь цикл Coder → AI Review → AutoTest автоматизирован.

Пример PR где это сломано: PR #8 (`fix(ba): fix business logic inconsistencies`).

---

## Задача

Добавить `allowed_bots: 'claude'` в step **Claude Code Review** в `.github/workflows/ai-review.yml`.

### Что нужно изменить

- [ ] `.github/workflows/ai-review.yml` — в job `reviewer`, step `Claude Code Review`: добавить `allowed_bots: 'claude'`

### Acceptance Criteria

- [ ] Step `Claude Code Review` в `ai-review.yml` содержит `allowed_bots: 'claude'`
- [ ] Workflow больше не падает с ошибкой "non-human actor" на PR-ах от `claude[bot]`

---

## Файлы для изменения

```
.github/workflows/ai-review.yml
```

## Конкретное изменение

В блоке:
```yaml
- name: Claude Code Review
  uses: anthropics/claude-code-action@beta
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    direct_prompt: |
      ...
```

Добавить строку:
```yaml
    allowed_bots: 'claude'
```
