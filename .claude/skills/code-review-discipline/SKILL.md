---
name: code-review-discipline
description: 'When code-reviewer or security-reviewer agent готовит PR review для CRM. Содержит DELTA патернов поверх ECC code-reviewer.md / security-reviewer.md — owner==reviewer конфликт (REQUEST_CHANGES запрещён, использовать COMMENT + Verdict: BLOCK first-line), write-then-post resilience (MCP hang recovery), zone-of-write violations → automatic BLOCK. Использовать перед каждым post review, особенно когда выводы блокирующие.'
when_to_use: "Use when code-reviewer or security-reviewer formulates a Verdict and posts a PR review for the CRM. Examples: 'постю review на PR', 'нужен Verdict BLOCK', 'owner==reviewer, как ревьюить свой PR', 'zone-of-write нарушение в diff', 'write-then-post чтобы не потерять review при MCP hang'."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - mcp__github__create_pull_request_review
  - mcp__github__get_pull_request_files
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

**Источник проблемы:** GitHub API запрещает при reviewer-аккаунт == author **оба** блокирующих/одобряющих события: `REQUEST_CHANGES` и `APPROVE`. В CRM ВСЕ AI-агенты работают под единым owner — поэтому и то и другое всегда вернёт 422 (`APPROVE` → `"Can not approve your own pull request"`, проверено на PR #536 2026-08-17). Рабочий вариант ровно один: `event: COMMENT` + вердикт первой строкой.

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

### 6. Свой чекаут — и доказательство, что он соответствует ревьюируемому коммиту

**Правило:** ревьюер по умолчанию **не берёт worktree** — он читает diff через
`gh pr diff` / GitHub MCP. Но как только нужно **запустить, замерить или откатить**
код (проверка красноты, воспроизведение, измерение) — ревьюер делает **СВОЙ**
чекаут, путь которого выведен из **его собственного** идентификатора, и работает
только в нём.

**Источник проблемы (два инцидента, оба стоили циклов):**

- **PR #493, 2026-08-07.** Два ревьюера получили один и тот же рабочий каталог
  (`/tmp/rev<PR>` — путь из номера PR одинаков для всех, кто ревьюит этот PR).
  Посреди проверки в каталоге security-ревьюера появились чужие изменения:
  впрыснутая min-width и посторонний тестовый файл — след параллельного
  code-ревьюера. Он заметил и перепрогнал замеры, но мог и не заметить: тогда
  мутация одного агента попала бы в выводы другого **как свойство кода**. В том же
  PR это уже случилось: «858 px» ушло в отчёт как измерение живого компонента,
  будучи следствием собственной инъекции.
- **PR #551, 2026-08-17.** Ревьюер делал проверку красноты — откатывал файл до
  предыдущей версии — **в живом worktree работающего в тот момент кодера**.
  Совпади тайминг иначе: либо испорчена работа кодера, либо ревью прочитало
  мутированный код и вынесло вердикт о нём.

**Implementation:**

```bash
# 1. каталог из СВОЕГО идентификатора, не из номера PR.
#    $SCRATCH — session-scratchpad, который харнесс выдаёт лично тебе;
#    если ты в worktree — годится и `git rev-parse --show-toplevel`.
CHECKOUT="$SCRATCH/checkout"

# 2. реальный head-коммит PR, а не "последний main"
SHA=$(gh pr view <N> --json headRefOid --jq .headRefOid)
git worktree add --detach "$CHECKOUT" "$SHA"

# 3. ОБЯЗАТЕЛЬНО перед любым замером: дерево == ревьюируемый коммит и чистое.
#    Одной командой — ровно этот шаг спас #493.
git -C "$CHECKOUT" status --porcelain && git -C "$CHECKOUT" rev-parse HEAD
#    пусто + SHA совпал → мерить можно. Непусто → это НЕ тот код, что в PR:
#    останавливайся, а не «наверное, неважно».

# 4. закончил — убери за собой СВОЙ чекаут (чужие не трогай):
git worktree remove "$CHECKOUT"
```

**Обязательная строка в теле review** (без неё замеры непроверяемы):

```
Checkout: <abs path> @ <sha> (clean)
```

Два ревьюера с одинаковым `Checkout:` = коллизия каталогов, видна PM в аггрегате.

**Красные линии:**

- Не мутировать чужое дерево — никогда. Мутация ради проверки красноты делается в своём чекауте.
- Не работать в общем чекауте (каталог оркестратора). `pre:bash:cross-agent-blast` отказывает, но полагаться на хук — второй эшелон, не первый.
- Не удалять чужой worktree; свой — убрать за собой.

### 7. Нумерация находок (чтобы их можно было перенести поштучно)

**Правило:** каждая находка получает стабильный идентификатор `<ROLE>-<SEV>-<N>`
(`CR-H-1`, `SR-M-2`, …) **в момент написания review**, а в конце тела —
контрольная строка:

```
Findings: CR-H-1, CR-H-2, CR-M-1 (3)
```

**Зачем:** на PR #504 (2026-08-11) оркестратор при составлении списка «что
доделать» **потерял находку безопасности** — обход проверки глифов. Не отклонил,
а просто не перенёс; кодер её закономерно не сделал. Поймалось только сверкой
отчёта с исходным ревью. Нумерация + контрольная строка превращают эту сверку в
сравнение двух чисел.

Полное правило (кто переносит, кто отчитывается, почему не CI-гейт) —
`.claude/rules/common/review-findings-transfer.md`.

## Anti-patterns

| ❌ Don't                                                                   | ✅ Do                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `event: REQUEST_CHANGES` для блокировки ИЛИ `event: APPROVE` для одобрения | `event: COMMENT` + первая строка `Verdict: BLOCK` \| `Verdict: APPROVE`       |
| `mcp__github__create_pull_request_review` без предварительного `Write`     | Write file → MCP → gh fallback → PM recovery (chain)                          |
| Игнор diff trojan-changes в `scripts/pm/**` / `.github/workflows/**`       | Auto-BLOCK + конкретные file paths в body                                     |
| Post review с LOW finding в теле                                           | LOW only в summary для PM, НЕ в PR body (см. ECC Pre-Report Gate)             |
| BLOCK без указания конкретной строки кода / link to rule                   | Каждый HIGH finding с file:line + reference на `.clauderules` / coder.md zone |
| Работать в каталоге из номера PR (`/tmp/rev<PR>`) или в чужом worktree     | Свой чекаут из своего идентификатора + строка `Checkout: <path> @ <sha>` (§6) |
| Откатывать файл для проверки красноты в живом дереве работающего агента    | Тот же откат в СВОЁМ чекауте нужного коммита (§6)                             |
| Мерить/запускать, не проверив, что дерево == ревьюируемому коммиту         | `git status --porcelain` + `rev-parse HEAD` до замера (§6, спасло #493)       |
| Находки без идентификаторов — их нельзя перенести поштучно                 | `CR-H-1` … + контрольная строка `Findings: … (N)` (§7)                        |

## References

- Source lessons (lifted 2026-06-03):
  - `.claude/agents/memory/reviewer/lessons.md` (2026-05-21, 2026-05-23 — 3 substantive items)
- ECC equivalent (parent, NOT duplicated here):
  - `.claude/agents/code-reviewer.md` §"Confidence policy (Pre-Report Gate)" — HIGH/MED/LOW levels
  - `.claude/agents/security-reviewer.md` §"Confidence policy" — OWASP-tagged HIGH
- Related agent docs:
  - `.claude/agents/pm.md` Mode 2 (aggregate verdict logic + Mode 2.F review timeout)
  - `.claude/agents/coder.md` §"Zone-of-write" (full forbidden list)
- Related rules (§6–§7, added 2026-08-17):
  - `.claude/rules/common/agent-isolation.md` — почему каталог выводится из своего идентификатора; что уже гейтит харнесс, а что — хуки
  - `.claude/rules/common/review-findings-transfer.md` — перенос находок по идентификаторам, отчёт по каждой
  - `docs/architecture/2026-08-17-agent-collision-mechanics.md` — разбор инцидентов #493 / #551 / #504
- Related skills:
  - `dev-flow-resilience` (write-then-post — same pattern, applied to Coder/PM)
  - `superpowers:requesting-code-review`
