# Citation Rules

Каждый существенный claim в ответе Legal-агента обязан иметь источник. Это hard rule (см. `docs/agents/legal.md` → секция «Hard rules»).

## Что считается «существенный claim»

- Утверждение о норме закона («ФОП 3-я группа лимит 7M грн»)
- Утверждение о сроке / процедуре («податкова декларація подається до 1 травня»)
- Утверждение о ставке / размере / лимите (любая цифра)
- Утверждение о праве / обязанности subject'а («GDPR требует получения consent»)
- Утверждение о практике госоргана («ДПС обычно считает X как Y»)

**Не требуют отдельной цитации:**

- General principles («контракты лучше иметь письменными»)
- Best practices без специфического regulatory base
- Логические выводы из уже-цитированного источника

## Форматы цитации

### 1. Статья закона (UA)

```
[Стаття 24 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17#n139)
```

- Гиперлинк на zakon.rada.gov.ua
- Прямая ссылка на статью через якорь `#n<number>`
- Сокращение нормативного акта общепринятое: ПКУ (Податковий кодекс), ЦКУ (Цивільний кодекс), КЗпП (Кодекс законів про працю), Закон про віртуальні активи

### 2. GDPR и EU regulation

```
[GDPR Art.6(1)(b)](https://gdpr-info.eu/art-6-gdpr/)
[Regulation (EU) 2022/2554 (DORA)](https://eur-lex.europa.eu/eli/reg/2022/2554/oj)
```

- gdpr-info.eu — community-maintained но точное соответствие официальному
- eur-lex.europa.eu — официальный портал EU

### 3. Внутренняя knowledge base

```
docs/legal/ua-fop/fop-3-group.md
docs/legal/gdpr/personal-data-categories.md
```

- Relative path от repo root
- Обязательно указать конкретный файл (не «см. docs/legal/»)

### 4. WebSearch результат

```
WebSearch: https://tax.gov.ua/.../razyasnennya-123.html (дата сбора: 2026-05-31)
```

- Прямой URL
- **Обязательно дата сбора** — закон / разъяснение может измениться, дата signals читателю «verify recency»

### 5. Прецедент / разъяснение ДПС / лист

```
[Лист ДПС № 1234/6/12-34-15-25 від 15.03.2026](https://tax.gov.ua/...)
[Постанова ВС № 320/12345/22 від 10.04.2026](https://reyestr.court.gov.ua/...)
```

- Полный номер документа
- Дата
- Гиперлинк на reyestr.court.gov.ua (для судебных решений) или tax.gov.ua (для разъяснений)

### 6. Reputable commentary (secondary)

```
Commentary: [Practice note Sayenko Kharenko](https://...) (дата сбора: 2026-05-31)
```

- Префикс «Commentary:» чтобы отличать от primary source
- Используется только для background или когда primary source отсутствует
- Не считается достаточным для HIGH Confidence (max MED)

## Inline vs section цитация

**Inline (предпочтительно для коротких claim'ов):**

> ФОП 3-я группа имеет лимит дохода 7M грн ([Стаття 291.4 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17#n4877)) — превышение требует переход.

**В секции «Источники» (для аггрегированных claim'ов):**

> ФОП 3-я группа имеет лимит дохода 7M грн на 2026, превышение требует перехода на общую систему. Декларация подается ежеквартально.
>
> ### Источники
>
> - [Стаття 291.4 ПКУ](https://zakon.rada.gov.ua/laws/show/2755-17#n4877) — лимит дохода
> - [Стаття 296 ПКУ](https://zakon.rada.gov.ua/...) — порядок декларации

Inline удобнее для reader (источник рядом с claim), но удлиняет prose. Mix is OK.

## Что НЕ считается валидным источником

- ❌ **AI-generated articles** (medium.com posts от ChatGPT-генератора, Reddit threads с AI summaries)
- ❌ **Random forums без identifiable expert author** (форуми бухгалтерів, без specifics)
- ❌ **Wikipedia как primary source** (можно как background для общих понятий, не для конкретных норм)
- ❌ **Outdated сайты** (последний update до 2023 без проверки актуальности)
- ❌ **Перевод статьи без ссылки на оригинал** (translator может ошибиться)
- ❌ **Цитата по памяти без verification** (hallucination risk)
- ❌ **«Кажется, я где-то читал что»** — если не помнишь точно → не пиши

## Если источника нет

Это критическая ситуация. Действия:

1. **WebSearch обязателен.** Поищи в zakon.rada / GDPR portal / разъяснения ДПС
2. **Если WebSearch не дал чёткого источника:**
   - Явно обозначь «based on general principles, not specific statute»
   - Confidence: LOW
   - В Disclaimer: «нужна verification у practicing юриста, конкретная норма не найдена в общедоступных источниках»
3. **Не выдумывай номера статей.** Лучше «не знаю с уверенностью» чем галлюцинированный citation.

## Stale citation check

При использовании внутреннего файла `docs/legal/<topic>/<file>.md` — проверь поле `Last verified` в шапке файла:

- Если `Last verified` старше 6 месяцев → понизь Confidence (HIGH → MED) и упомяни «база docs/legal/... last verified YYYY-MM-DD, возможны изменения; перепроверь через WebSearch для critical action»
- Если старше 12 месяцев → MED → LOW, обязательный WebSearch

## Update policy

Citation rules обновляются когда:

- Появляются новые типы источников (новые офиц. порталы, formats)
- Найден промах в существующей практике (lesson записан с tag `#citation`)

Update через PR.
