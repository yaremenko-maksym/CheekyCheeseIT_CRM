# Legal — Agent Notes

## Репо

Repo: `yaremenko-maksym/CheekyCheeseIT_CRM`
Main branch: `main`

## Типичные длительности

| Тип запроса                                             | Ожидаемое время |
| ------------------------------------------------------- | --------------- |
| Mode A consult (вопрос покрыт static база)              | 5-8 мин         |
| Mode A consult (нужен WebSearch)                        | 10-15 мин       |
| Mode B pr-review (small PR, ≤ 3 файла в critical zones) | 8-12 мин        |
| Mode B pr-review (large PR, finance/auth + S3)          | 15-25 мин       |
| Mode C brief-check                                      | 8-12 мин        |
| Mode D strategic (deep question)                        | 10-20 мин       |

## Knowledge base структура

```
.claude/knowledge/legal/
  README.md                               # master index, правила обновления
  ua-fop/                                 # ФОП-режимы, единый налог, валютные операции
    (Phase 1 seeding pending)
  crypto-usdt/                            # UA закон про віртуальні активи, USDT, AML
    (Phase 1 seeding pending)
  gdpr/                                   # personal data, processor/controller, breach
    (Phase 1 seeding pending)
  it-contracts/                           # NDA, services agreement, IP rights
    (Phase 1 seeding pending)
  cross-cutting/
    escalation-zones.md                   # ✓ Phase 0 — когда обязательно к human
    citation-rules.md                     # ✓ Phase 0 — формат цитации
```

**Phase 0 (текущая):** только cross-cutting/ + README. Topic folders пустые. WebSearch — primary source.

**Phase 1 (future):** User дополнит topic folders по мере накопления вопросов.

## Зоны записи

| Можно                                                         | Нельзя                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| `.claude/tasks/task-legal-*.md` (append `## Ответ юриста`) | `.claude/knowledge/legal/**` (knowledge base — User/PM maintenance) |
| `.claude/knowledge/legal-consultations/*.md`                         | `apps/**`, `packages/**`, `scripts/**`, `.github/**`   |
| `.claude/briefs/pm-brief-legal-check.md`                          | `.claude/agents/**`                                       |
| `/tmp/legal-output/pr-*.md`                                   | `docs/business/**`                                     |
| PR review (через MCP, event=COMMENT only)                     | Любые labels кроме `legal-noted`                       |

## События в pm-state.json

PM пишет в `pm-state.json.events[]` следующие event types при работе с Legal:

| Event                      | Поля                                       | Когда                                                                                              |
| -------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `legal_dispatched`         | `{at, type, mode, target}`                 | PM запустил Legal через Agent(). `target` = task-file / pr-number / brief-file / consultation-file |
| `legal_review_posted`      | `{at, type, pr, confidence}`               | Mode B: review запостен на PR. `confidence` = HIGH/MED/LOW                                         |
| `legal_pre_feature_done`   | `{at, type, brief, recommendations_count}` | Mode C: Legal вернул recommendations                                                               |
| `legal_escalated_to_human` | `{at, type, reason}`                       | Mode B/A: Confidence: LOW + hard zone → User informed эскалировать                                 |

## Label workflow

- **`legal-noted`** (info-blue, не блокирует merge) — Legal review posted на PR в Mode B. Visible signal что legal angle проверен.
- Никаких `legal-blocked` / `legal-approved` — Legal не gate.

## MCP/Bash особенности

### Write-then-post pattern для Mode B

```bash
mkdir -p /tmp/legal-output
REVIEW_FILE="/tmp/legal-output/pr-${PR}-$(date -u +%Y%m%dT%H%M%S).md"
cat > "$REVIEW_FILE" <<'EOF'
# Legal Review for PR #<N>

Legal Review: <CONFIDENCE>

<полное тело по структуре «Output format» в legal.md>
EOF
echo "Body saved: $REVIEW_FILE"
```

Затем `mcp__github__create_pull_request_review` с тем же body. Если MCP hangs → body выживает.

### Postить через gh CLI fallback

Если MCP не отвечает > 60 сек:

```bash
gh api repos/yaremenko-maksym/CheekyCheeseIT_CRM/pulls/<N>/reviews \
  --method POST \
  --field event=COMMENT \
  --field body="$(cat $REVIEW_FILE | tail -n +4)"  # skip header lines
```

### WebSearch источники

Предпочитать в этом порядке:

1. `zakon.rada.gov.ua` — UA законодательство (primary)
2. `gdpr-info.eu` или `eur-lex.europa.eu` — GDPR / EU
3. Официальные разъяснения ДПС (`tax.gov.ua`)
4. Reputable legal blogs / законопроекты ВРУ — secondary, обозначить как «commentary»

Не цитировать: random forums, Wikipedia как primary source (только background), AI-generated articles.

## Lessons (формат)

`.claude/agents/memory/legal/lessons.md` — формат как у других агентов:

```
YYYY-MM-DD [P0|P1|P2] [<task-id>] #topic-tag <конкретный урок>
```

Topic-tags для Legal:

- `#ua-fop`, `#gdpr`, `#usdt`, `#it-contract`, `#aml`, `#tax`, `#personal-data`
- `#citation` (когда промахнулись с источником)
- `#confidence` (когда Confidence не сошёлся с реальностью)
- `#escalation` (когда правильно/неправильно эскалировали)

## Recovery после hung

Поскольку Legal append'ит в файлы секциями — даже если обрыв на середине, secции до обрыва уже на диске. PM при recovery:

```bash
# Mode A — проверить task-файл
ls -la .claude/tasks/task-legal-<slug>.md
grep -c "^### " .claude/tasks/task-legal-<slug>.md  # сколько секций успел

# Mode B — проверить /tmp/legal-output/
ls -la /tmp/legal-output/pr-<N>-*.md
# если файл есть → review body готов, осталось post → перезапустить Legal с явным «только post existing body»
```
