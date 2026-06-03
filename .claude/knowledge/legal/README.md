# Legal Knowledge Base

Корпус юридической информации для Legal-агента (Юрист). Используется как primary source при ответах на консультации.

## Принципы

1. **Git-versioned.** История изменений видна, можно откатиться.
2. **Доступна всем агентам.** Coder при работе над finance может посмотреть compliance rules, Reviewer — проверить соответствие в PR. Не private для Legal.
3. **Citation source.** Каждый файл — потенциальный источник, который Legal цитирует в ответах. Должен быть verifiable (ссылки на авторитетные внешние источники в самом файле).
4. **Update через PR.** Изменения как любой код — через PR с review. Не правит Legal-агент напрямую (он consumer, не maintainer).

## Структура

```
.claude/knowledge/legal/
  README.md                               # этот файл
  ua-fop/                                 # Украина — ФОП-режимы, единый налог, валютные операции
  crypto-usdt/                            # Crypto/USDT — UA закон про віртуальні активи, AML, smart contract
  gdpr/                                   # GDPR / data privacy — personal data, processor/controller, breach
  it-contracts/                           # IT-договоры — NDA, services agreement, IP rights, юрисдикция
  cross-cutting/
    escalation-zones.md                   # Когда Legal обязан эскалировать к human-юристу
    citation-rules.md                     # Формат цитации в ответах
```

## Текущий статус

**Phase 0** (текущая): только `cross-cutting/` files. Topic folders (ua-fop, crypto-usdt, gdpr, it-contracts) **пустые**. Legal использует WebSearch как primary source + general legal principles. Каждый ответ помечен Confidence: LOW при отсутствии static покрытия.

**Phase 1** (будущая, после первых реальных консультаций): User дополнит topic folders по мере накопления вопросов. Не делаем upfront comprehensive seeding — какие topics реально нужны определит practice.

## Как добавлять контент

Новый topic-файл должен содержать:

1. **Заголовок темы** — конкретный (не «ФОП», а «ФОП 3-я группа — лимиты дохода 2026»)
2. **Authoritative source** — ссылка на zakon.rada.gov.ua / gdpr-info.eu / etc.
3. **Last verified date** — когда content проверен на актуальность
4. **Body** — суть + примеры применимости к нашему бизнесу (CRM Cheeky Cheese IT, outsource UA)
5. **Related** — ссылки на related файлы в `.claude/knowledge/legal/` или `docs/business/`

Пример:

```markdown
# ФОП 3-я группа — лимит дохода

**Authoritative source:** [Стаття 291.4 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17#n4877)
**Last verified:** 2026-05-31

## Краткое

На 2026 год лимит дохода для ФОП 3-я группа — **7M грн** (1167 минимальных зарплат на 1 січня). Превышение требует перехода на общую систему / 4-у группу.

## Применимость к нашему бизнесу

SENIOR работают как ФОП 3-я группа (5% ставка). Превышение лимита возможно при ставке > $5800/месяц год пo year. Контроль — ежемесячно в Finance dashboard.

## Related

- `.claude/knowledge/legal/ua-fop/fop-currency-ops.md` — валютные операции внутри лимита
- `docs/business/modules/finance.md` — финансовый flow
```

## Не делаем

- Не дублировать законы целиком — давать ссылку на zakon.rada
- Не публиковать confidential данные (договоры клиентов, internal procedures)
- Не редактировать через Legal-агента — это maintenance обязанность User/PM
