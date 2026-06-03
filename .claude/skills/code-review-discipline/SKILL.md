---
name: code-review-discipline
description: When code-reviewer or security-reviewer agent готовит PR review для CRM. Содержит DELTA патернов поверх ECC code-reviewer.md / security-reviewer.md — owner==reviewer конфликт (REQUEST_CHANGES запрещён, использовать COMMENT + Verdict: BLOCK first-line), write-then-post resilience (MCP hang recovery), zone-of-write violations → automatic BLOCK. Использовать перед каждым post review, особенно когда выводы блокирующие.
---

# Code Review Discipline (delta vs ECC)

Project-specific дополнения к ECC `code-reviewer.md` Pre-Report Gate. **НЕ дублирует** ECC — лифтит только delta, которая не покрыта upstream.

## When to invoke

- Перед `mcp__github__create_pull_request_review` (любым review event)
- При формулировании Verdict для PR (BLOCK / APPROVE)
- Когда diff PR содержит файлы вне zone-of-write Coder'а
- При исследовании MCP hang во время post review
- Если предыдущий review «провисел» > 2× expected duration без появления на PR

## Patterns

### 1. Verdict: BLOCK first-line (owner==reviewer constraint)

**Правило:** Для блокировки PR использовать `event: COMMENT` + первая строка тела `Verdict: BLOCK`. **НЕ** использовать `event: REQUEST_CHANGES`.

**Источник проблемы:** GitHub API запрещает `REQUEST_CHANGES` когда reviewer-аккаунт == author. В CRM ВСЕ AI-агенты работают под единым owner — поэтому REQUEST_CHANGES всегда вернёт 422.

**Implementation:**

```ts
mcp__github__create_pull_request_review({
  pull_number: N,
  event: 'COMMENT',
  body: `Verdict: BLOCK\n\n<rationale + HIGH findings>`,
})
```

**Decision rule для PM:**

- PM парсит `Verdict: BLOCK` в первой строке → снимает `awaiting-pm-review` → ставит `do-not-merge` → создаёт fix-task для Coder.
- `Verdict: APPROVE` (или отсутствие BLOCK marker) → продолжает Mode 2 aggregate verdict logic.

### 2. Write-then-post pattern (MCP hang recovery)

**Правило:** Сохранить body review в `/tmp/<role>-output/pr-<N>-<TS>.md` **ДО** `mcp__github__create_pull_request_review`. MCP может зависать > 10 мин (real incident 2026-05-23) → watchdog crash → review теряется. Файл выживает crash, доступен для manual recovery.

**Implementation order:**

1. Сформировал body string.
2. `Write` файл `/tmp/reviewer-output/pr-<N>-<TS>.md` с body.
3. `mcp__github__create_pull_request_review` — Attempt #1.
4. Если MCP hangs / fails → `gh api repos/.../pulls/<N>/reviews -X POST -F event=COMMENT -F body=@/tmp/reviewer-output/pr-<N>-<TS>.md` — Attempt #2 (Bash fallback).
5. Если оба провалились → PM Mode 2.F recovery: PM читает файл и постит вручную.

**Для security-reviewer:** Аналогично, путь `/tmp/security-reviewer-output/pr-<N>-<TS>.md`.

### 3. Zone-of-write violation → automatic BLOCK

**Правило:** Если diff PR содержит изменения вне zone-of-write Coder'а — Verdict: BLOCK с указанием конкретного файла.

**Coder forbidden zones (от 2026-05-23 D1-D4 RCA):**

- `scripts/pm/**` (PM-only)
- `scripts/devops/**` (DevOps-only)
- `.claude/agents/**` (Architect-only)
- `docs/business/**` (BA-only)
- `.github/workflows/**` (DevOps-only)
- `.claude/hooks/**` (DevOps + Architect)
- Чужие task-файлы

**Implementation:**

```bash
gh pr view <N> --json files --jq '.files[].path' | grep -E '^(scripts/pm/|scripts/devops/|.claude/agents/|docs/business/|\.github/workflows/|\.claude/hooks/)'
```

Если есть match → Verdict: BLOCK + body содержит конкретные file paths и ссылку на `coder.md` "Zone-of-write" секцию.

### 4. Confidence-tagged findings (cross-reference ECC)

**Уже в ECC code-reviewer.md** — этот skill **НЕ дублирует** HIGH/MED/LOW gate. Reference: `.claude/agents/code-reviewer.md` §"Confidence policy (Pre-Report Gate)".

**Delta поверх ECC:**

- HIGH с zone-of-write violation = automatic BLOCK (этот файл §3).
- MED finding на `--no-verify` push (Coder обошёл pre-push hook) = BLOCK (это P0 invariant для CRM, см. coder/lessons.md 2026-06-02).
- LOW finding на «pre-existing flake» rationalization (Coder списал E2E на flake без isolated rerun proof) = MED escalation (см. coder/lessons.md 2026-06-02).

### 5. Owner==reviewer also affects approve flow

**Правило:** В CRM единый AI-owner — это значит `event: APPROVE` тоже не может прийти от того же account что author. Когда code-reviewer/security-reviewer хочет APPROVE — использовать `event: COMMENT` + первая строка `Verdict: APPROVE`. PM парсит так же как BLOCK.

**Real impact:** GitHub UI на PR покажет review как "comment" с emoji, но aggregate verdict logic в PM Mode 2 работает корректно (парсит Verdict: line, не event type).

## Anti-patterns

| ❌ Don't                                                               | ✅ Do                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `event: REQUEST_CHANGES` для блокировки                                | `event: COMMENT` + первая строка `Verdict: BLOCK`                             |
| `mcp__github__create_pull_request_review` без предварительного `Write` | Write file → MCP → gh fallback → PM recovery (chain)                          |
| Игнор diff trojan-changes в `scripts/pm/**` / `.github/workflows/**`   | Auto-BLOCK + конкретные file paths в body                                     |
| Post review с LOW finding в теле                                       | LOW only в summary для PM, НЕ в PR body (см. ECC Pre-Report Gate)             |
| BLOCK без указания конкретной строки кода / link to rule               | Каждый HIGH finding с file:line + reference на `.clauderules` / coder.md zone |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/reviewer/lessons.md` (2026-05-21, 2026-05-23 — 3 substantive items)
- ECC equivalent (parent, NOT duplicated here):
  - `.claude/agents/code-reviewer.md` §"Confidence policy (Pre-Report Gate)" — HIGH/MED/LOW levels
  - `.claude/agents/security-reviewer.md` §"Confidence policy" — OWASP-tagged HIGH
- Related agent docs:
  - `.claude/agents/pm.md` Mode 2 (aggregate verdict logic + Mode 2.F review timeout)
  - `.claude/agents/coder.md` §"Zone-of-write" (full forbidden list)
- Related skills:
  - `dev-flow-resilience` (write-then-post — same pattern, applied to Coder/PM)
  - `superpowers:requesting-code-review`
