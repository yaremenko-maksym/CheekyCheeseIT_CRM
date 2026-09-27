# CRM i18n — этап 3, волна (d) «web-finance» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести на `uk`/`en` всё, что в CRM касается денег на вебе: реестр транзакций и его строки, детальный диалог транзакции, финансы дропа, диалоги создания/редактирования/валидации транзакции, диалоги заявок на выплату и расчётов, каскад-предпросмотр, статистику приходов (`stats.tsx`) и веб-часть счетов (`invoices`). Сюда же входят финанс-компоненты, которые волна (c) намеренно оставила нетронутыми (`TransactionRow`, `TransactionDetailDialog`, `fmtUsd`, `ExchangeRates`) — они живут в `finance/**` и здесь родные, а не подтягиваются из чужого среза. Четыре PR, мержатся **последовательно** (общий `.po` + общий хаб `finance/constants.ts`), в мигрированных файлах не остаётся русского текста, а две карты ярлыков среза (`TYPE_LABELS` 22 ключа, `STATUS_LABELS` 7) и две локальные `ROLE_LABEL` (`stats.tsx`, `invoice.v.$transactionId.tsx`) переводятся в каталог, потому что после волны у русских литералов в них не остаётся места.

**Architecture:** Тот же единственный каталог `packages/shared/src/i18n/locales/{uk,en}/messages.po` и те же шаблоны A–F, что в волнах (a)/(b)/(c). Нового в этой волне пять вещей. Первое — **`finance/constants.ts` — хаб, потребляемый всем срезом плюс одним файлом чужого среза** (`user-profile/tabs/FinanceTab.tsx`, web-people, уже смёржен). Его карты `TYPE_LABELS`/`STATUS_LABELS` меняют форму на `Record<enum, MessageDescriptor>`, поэтому конверсия карт и миграция ВСЕХ их потребителей связаны: старые строковые карты живут до PR4, где удаляются, ровно как `PAYMENT_TYPE_LABELS` жил PR3→PR4 в волне (c). Второе — **данные-в-БД: `EXPENSE_CATEGORIES`** пишутся в `transactions.receiver_label` как есть, это не чистый UI-перевод, а миграция данных + коды (см. «Спорное решение 1»). Третье — **форматирование денег и дат** сведено к общему слою (`@crm/shared` `format.ts`), но его корень `apps/web/app/lib/format-amount.ts` (`ru-RU`/`en-US` захардкожены) — кросс-срезовый, трогается согласованно (см. «Спорное решение 3»). Четвёртое — **сырое `Error.message` на денежном экране** (COPY-H-fin-3) закрывается разбором по статусу через уже существующий `getApiErrorMessage`/паттерн `cascade-preview.ts`, без заведения новых кодов (серверные коды finance/invoices мигрированы #704). Пятое — **деньги/RBAC на поверхности каждого PR → `security-reviewer` обязателен на всех четырёх** (маскировка сумм `mapTx(viewer)`, доля дропа/сеньора, счёт компании, дивиденды).

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`), уже настроен этапом 2. React 18, Vite 6, Vitest 4, TanStack Router, Tailwind v4, shadcn/ui, `eslint-plugin-lingui` 0.16.0 (`warn`), Playwright, Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §5 (гейты), §7 (порядок волн), §8 (тесты). Аудит: `docs/architecture/2026-09-19-crm-i18n-audit.md`, срез `web-finance` (21 находка, `Findings:` в конце среза) и сквозные темы §1–§2. Образцы формата, качества и шаблонов: планы волн (a) `docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md` (шаблоны A–F), (b) `docs/superpowers/plans/2026-09-24-crm-i18n-stage3b-web-people.md`, (c) `docs/superpowers/plans/2026-09-26-crm-i18n-stage3c-web-projects.md` (структура волны, шаблоны G–L, уроки #700–#728).

**Замер:** все числа ниже сняты командами на `origin/main` `5c477321f` (#728, i18n 3c PR4) 2026-09-27, в чистом worktree (`git status` пуст). Числа привязаны к **символам** (`TYPE_LABELS`, `EXPENSE_CATEGORIES`, `fmtUsd`, …) и **счётчикам по файлам**, не к номерам строк (`doc-durability.md`). Перед стартом каждого PR исполнитель повторяет замер (шаг 0 каждой задачи): между планом и исполнением в `main` могут смёржиться другие ветки.

## Global Constraints

Действуют на каждую задачу. Пункты с пометкой «урок» взяты из разборов PR #700–#728 (волны a/b/c) и уже однажды стоили отдельного раунда ревью.

**Версии и механика Lingui**

- `@lingui/*` — **5.9.5 EXACT**, одной версией (`version-pins.md`). Этот план ничего не апгрейдит.
- Исходный текст в коде — **украинский** (`sourceLocale: 'uk'`). Английский пишет тот же кодер в том же PR как второй оригинал (скилл `copywriting` §5, решение владельца №7). Интерфейс по умолчанию `uk`, второй язык `en`.
- На уровне модуля — только `msg`. `t`, `plural` и `select` на уровне модуля запрещены: строка замёрзнет при импорте. В компоненте `t`/`i18n` берутся из `useLingui()` (`@lingui/react/macro`).
- **Урок (#700): макрос `plural()` несовместим со Stryker.** Под инструментированием `#` не подставляется. Для чисел в JSX — компонент `<Plural>`; вне JSX — `msg` с ICU-строкой и `i18n._(descriptor, { count })`. В этой волне это касается прежде всего `finance/utils/company-share.ts` (`pluralizeProjects`/`pluralizeIncomes`) и четырёх тернарников `=== 1 ? … : …` в `stats.tsx` (COPY-H-fin-4).
- **Урок (#707): `as const satisfies Record<…, MessageDescriptor>` на карте `msg`-шаблонов отключает Stryker для всего блока** (0 мутантов). Пишется `satisfies Record<…>` без `as const` и без `as const satisfies`. Если гейт показывает 0 мутантов в файле, где точно есть `msg`, причина в этом. В этой волне `TYPE_LABELS`→`TYPE_LABEL_MESSAGES` (22 ключа), `STATUS_LABELS`→`STATUS_LABEL_MESSAGES` (7), два `ROLE_LABEL`, `SIG_METHOD_LABEL`/`SIG_ROLE_LABEL`/`STATUS_LABEL` в счетах, `CASCADE_BLOCKED_REASON_MESSAGES` — все `satisfies` без `as const`.
- `i18n._()` принимает только **выражение**: `i18n._(TYPE_LABEL_MESSAGES[tx.type])` или `i18n._(MAP[key])`. Объектный литерал со spread роняет `lingui extract`. Триарг — `i18n._(id, values, options)`, не spread.
- **Урок (#707): у записей с явным id (`api-error.*`, `zod-error.*`) `msgstr` правится руками в обоих `.po`.** `i18n:extract` существующий `msgstr` не перезаписывает. Эта волна тексты с явным id не меняет, только использует (см. «Серверные коды #704»). Если такая правка понадобится — отдельная строка в «Допущениях» PR и ручная правка обоих `.po`.

**Серверные коды ошибок (#704) — потреблять, не дублировать**

- Коды ошибок API для finance/invoices и Zod-сообщения **уже мигрированы** (этап 4, #704): реестр в `packages/shared/src/schemas/api-errors.ts`, клиентские резолверы `getApiErrorMessage`, `translateZodCode`, `translateZodMessage` в `apps/web/app/lib/axios-utils.ts`. Волна их **потребляет**, а не заводит новых.
- **COPY-H-fin-3 (сырое `Error.message` в теле диалога)** закрывается разбором по статусу через `getApiErrorMessage` или локальный статус-разбор по образцу `finance/cascade-preview.ts` → `cascadeSaveErrorMessage` (403 → «недостатньо прав», ≥500 → «помилка на нашому боці, спробуйте пізніше», нет ответа → «перевірте з’єднання»). Сырое `.message` наружу не отдавать. Тест `apps/web/app/lib/axios-utils.spec.ts` фиксирует текущее поведение резолвера — не ломать его контракт; менять только те пять диалогов и `ReceiptInput`, что печатают `.message` напрямую.
- **COPY-M-fin-15 (ошибки загрузки без причины/действия)** — тем же приёмом: хвост по статусу + кнопка «Повторити». Новых кодов не заводить.

**Тексты (`CONTEXT.md` → «Формы `uk`/`en`» + таблица канона ниже)**

- Апостроф — `’` (U+2019), не `'` и не `ʼ`. Многоточие — `…` (U+2026), не `...`. Кавычки: в `uk` ёлочки `«…»`, в `en` типографские `“…”`.
- **Термины денег берутся из глоссария `CONTEXT.md` дословно** (он для этого среза особенно строг):
  - **`PAYOUT` = «Виплата»** (сеньор платит компании) — единственный смысл. «Отдать деньги человеку» — это **розрахунок** (settle). `CONTEXT.md` §«Помеченные неоднозначности» это прямо решил. Отсюда COPY-H-fin-1: `SENIOR_PAID`/`SENIOR_PENDING_PAYOUT`/`DROP_PENDING_PAYOUT`/`PAYOUT_CONFIRMED` — «розрахунок», не «виплата».
  - **Роль `DROP` = «дроп»** (`_Избегать_`: посередник, підставна особа, номінал, проксі). Отсюда COPY-H-fin-2: `stats.tsx` `ROLE_LABEL.DROP: 'Посредник'` — четвёртый синоним, которого нет в глоссарии.
  - **Единица учёта — «транзакція»** (`_Избегать_`: платіж). Отсюда COPY-L-fin-20 («Факт платежу» → «Факт переказу», «Немає історії платежів» → «Переказів ще не було»).
  - **Сущность счёта — «Рахунок»** (`_Избегать_`: інвойс, акт, платіжка). Отсюда COPY-L-fin-16 («Інвойс» ×11 → «Рахунок»).
  - **`dropShare`/`seniorShare` — «частка»** (`_Избегать_`: комісія, ставка, процент). Отсюда COPY-L-fin-17 (`EXPENSE_CATEGORIES` «Комиссия» → «Банківський збір», а не «комісія»).
- **Урок (#702, п.13): сырой enum роли/статуса/типа в видимом тексте — находка.** После замены литерала сканировать **весь** файл на сырой enum по JSX-тексту, `aria-label`, `title`, `placeholder`. На каждый экран со статусом/типом — тест «в отрендеренном экране нет сырого enum». Исключение: `USDT`, `USD`, `UAH`, `EUR`, `TX Hash`→«Хеш транзакції», `Etherscan`, `HR` — proper nouns/валюты/бренды (оставляются как есть; латиница внутри русского ярлыка — наоборот находка, COPY-M-fin-11: «Приход Admin» → «Прихід адміна»).
- **Урок (#702, п.9): подстановка в косвенный падеж ломает `uk`.** Имя/роль подставляется только в именительном. Конструкция выбирается не требующая падежа (шаблон K). Касается склеек `CascadeImpactPanel.tsx` (`` `Синьору ${name}` ``), `cascade-preview.ts` (lead-in + « — » + хвост), `CompanySharePayoutModal.tsx` (сводка из фрагментов через `{' '}`).
- Тост и отказ — **одно предложение, без точки в конце**, с глаголом; там, где есть действие, сказано «что делать» (COPY-M-fin-5/6/7/12/13/15: тупики без следующего шага — находка). Телеграфный стиль и усечения («актив. проєкта», «N прих.», «Откл.») запрещены (COPY-L-fin-18). Одна ситуация — один текст: одинаковые пустые состояния берут ключ дословно (для «фільтр нічого не знайшов» — уже существующий ключ каталога волны b «Нічого не знайдено — скиньте фільтри»).
- Жаргон разработки наружу запрещён (COPY-M-fin-10): «click + audit», «dev», «нал» — человеческим языком; эмодзи (`🔗`) выносится из переводимой строки в компонент.
- **Урок (#701, п.5): русизмы проверять по юникоду, не байтовым `grep`.** Перед каждым push:

```bash
python3 -c "import re,sys,subprocess;fs=subprocess.run(['git','diff','--name-only','origin/main','--','apps/web/app'],capture_output=True,text=True).stdout.split();[print(f,i,l.strip()) for f in fs if f.endswith(('.ts','.tsx')) for i,l in enumerate(open(f,encoding='utf8'),1) if re.search('[ыЫэЭъЪёЁ]',l) and not re.match(r'\s*(//|\*|\{/\*)',l)]"
```

Строки из этого вывода в файлах **своего** PR — недоделка. Исключения — тестовые фикстуры с русскими данными (имена людей из сида) и комментарии. Буквы `і ї є ґ` — уже украинский, не русизм; guard целит на `ы э ъ ё`. **Отдельно для этой волны:** старые русские значения в `EXPENSE_CATEGORIES`, оставшиеся в БД как данные, — не текст кода; их судьбу решает «Спорное решение 1», а не guard.

**Тесты**

- Якоря — `data-testid` и роли. Текст в ассертах берётся из **каталога `uk`**, не литералом:
  - Vitest — `loadCatalog(locale)` и `I18nTestProvider` из `apps/web/app/test/i18n.tsx` (уже в `main`);
  - E2E — `loadMessages('uk')` и `assertInCatalog(uk, '<текст>')` из `apps/e2e/fixtures/catalog.ts` (уже в `main`).
- **Урок аудита (COPY-B «тесты дублируют литералы»): перевести якоря на `data-testid` ДО перевода текста.** В срезе 24 unit-файла с 112 утверждениями по видимому русскому тексту и 24+ финансовых E2E-спеки. Тестиды уже есть (`compliance-row-*`, `delete-tx-confirm-button` и др.) — где ассерт по тексту не является предметом проверки, якорь по testid.
- **Урок (#700, п.2): E2E-свип по всему `apps/e2e`, а не по спекам из диффа.** Регрессия — любой литерал мигрированного компонента в любой спеке. Процедура и скрипт — «Общий шаг: E2E-свип» ниже. «Pre-existing» допустимо только если CI на `origin/main` красный на той же спеке.
- **Урок (#700, п.3): мутационный гейт на полном диффе — обязательный AC**, `survived 0`. Если у `NoCoverage` нет integration-hint, его закрывает unit-тест (`mutation-gate-integration-specs.md`). Локальный SKIP по таймауту — не PASS: тогда `stryker run` напрямую с `dryRunTimeoutMinutes: 20` и тем же конфигом, что у гейта.
- **Урок (#699, п.12): каждое подавление Stryker — с причиной на той же строке директивы**, не короче 12 символов (`// Stryker disable next-line <Mutator>: <причина>`). Перед push — `node scripts/devops/check-mutation-suppressions.mjs`: локальный `pnpm mutation:changed` его не вызывает, а CI с ним валит все Mutation Gate джобы ещё до старта.
- Тесты правит тот же кодер в том же PR (правка ассертов внутри мигрируемого модуля — часть той же задачи, как в волнах a/b/c). Новых `*.spec.ts`-сценариев E2E волна не заводит; новые unit-кейсы (тест на тип/статус без сырого enum, тест на плюрализацию проектов/приходов на 1/2/5, тест на разбор ошибки по статусу) — внутри существующих тест-файлов.

**Процесс**

- `git add` явным списком (в каждой задаче он есть). Push — `DATABASE_URL= git push`, без `--no-verify`. Каждый коммит несёт `ac_verified:` с номерами из раздела «Acceptance criteria» своей задачи.
- **Урок (#700, п.6): каденс для 20+ файлов** — `wip:`-коммиты локально, в конце **один** push. Pre-push под нагрузкой флакает, каждый push занимает 5–12 минут. `CreateTransactionDialog.tsx` (80 строк, PR3) и `stats.tsx` (62 строки, PR4) — по секциям, `wip:` после каждой.
- **Урок (#700, п.5): скриншоты и живые проходы делаются скриптом `npx playwright` в своём scratchpad**, не через `mcp__playwright__*`: браузер MCP общий у всех параллельных агентов.
- **Урок (#704/#707): конфликт `.po` при последовательных PR аддитивен.** Берутся обе стороны, затем `pnpm i18n:extract` дважды, второй прогон даёт пустой дифф. Проверка числами: число `msgid` равно `main` плюс новые записи PR, а fuzzy, `#-#-#` и пустых `msgstr` в `en` — 0. Merge `.po` не отдаётся haiku.
- **Урок (#700, п.9): task-файл — единственный канал требований.** В промпт кодера оркестратор пишет: «все разделы "Дополнение оркестратора" в task-файле — часть задания».
- После каждого Edit/Write `.ts`/`.tsx` — `mcp__eslint__lint-files`. На строках, которые волна трогает, новых warning `lingui/no-unlocalized-strings` быть не должно.
- `pnpm i18n:extract` идемпотентен: второй прогон подряд не меняет `.po`. CI-гейт «i18n catalogs are in sync» это проверяет, перед push то же воспроизводится локально.
- **Урок (#705): FM-5 guard-test gate.** Волна `apps/web` **не трогает** `apps/api`. Исключение — «Спорное решение 1» (`EXPENSE_CATEGORIES` коды+миграция), которое **выносится отдельным api+shared-PR вне этой волны** именно чтобы не тащить guard-test-gate и prod-DDL в web-PR. Если исполнитель всё же правит контроллер из списка `guard-test-gate.yml`, в том же PR нужен изменённый `apps/api/**/*.spec.ts` с ассертом 403 (или строка `guard-test-na: <причина>` в теле PR).
- Каждый PR проходит design-gate **Tier 2** (правка существующих экранов: conformance-проверка ui-ux-designer, без генерации в Claude Design) и fidelity Mode B на всех классах устройств. Вердикт `copy-reviewer` — по `uk` и по `en` **отдельно**. **`security-reviewer` ОБЯЗАТЕЛЕН для ВСЕХ четырёх PR** — весь срез в critical-path zones `pm.md` (транзакции, выплаты, доля дропа/сеньора, счёт компании, дивиденды, маскировка сумм). Логика в PR не меняется — проверить это должен ревьюер, а не автор.
- **Responsive AC для каждого PR:** экраны из задачи проверяются на 320 и 375 (мобайл), 768 (планшет), 1024 и 1280 (ноутбук), 1440 и 1920 (большой) на **обоих** языках. Нет горизонтального скролла (`document.scrollWidth <= clientWidth`), ни одна подпись не обрезана без `truncate` с `title`, тач-таргеты на мобайле не меньше 44×44. Скриншоты 320 и 1440 × `uk` и `en` прикладываются к PR. **Особый риск волны — реестр транзакций** (`ActiveTransactionsTable`/`TransactionRow`): украинские ярлыки типов длиннее русских, а таблица плотная; перемерить перенос строк на 320/375/768.

---

## Тестовый доступ к каталогу (хелперы уже в `main`)

Реализовано волной (a) и смёржено. Здесь — как пользоваться.

```tsx
// Vitest (apps/web) — реальный каталог через тот же путь, что в продакшене
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

await loadCatalog('uk')
render(<TransactionRow tx={tx} />, { wrapper: I18nTestProvider })
expect(screen.getByText('Розрахунок із сеньйором')).toBeInTheDocument()
```

```ts
// E2E (apps/e2e) — перед прогоном обязателен `pnpm i18n:compile`
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

const uk = await loadMessages('uk')
await expect(page.getByText(assertInCatalog(uk, 'Розрахунок із сеньйором'))).toBeVisible()
```

`assertInCatalog` падает с понятной ошибкой, если текста нет в каталоге: так устаревший литерал не превращается в таймаут Playwright. Относительный путь импорта зависит от глубины спеки: `'../fixtures/catalog'` для `tests/*.spec.ts`.

---

## Периметр волны (d) — как получен

Команды (границы среза аудита `web-finance` + финанс-компоненты, оставленные волной c):

```bash
# срез web-finance
find apps/web/app/routes/_authenticated/finance \
     apps/web/app/components/finance apps/web/app/components/invoices \
     -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*__tests__*' ! -name '*.spec.*' ! -name '*.test.*'
ls apps/web/app/routes/_authenticated/stats.tsx 'apps/web/app/routes/invoice.v.$transactionId.tsx'
# счётчик кириллицы вне комментариев (по каждому файлу)
git grep -c -P '[А-Яа-яЁё]' origin/main -- <файл>
```

Результат на `5c477321f`: в периметре **30 продуктовых файлов с кириллицей вне комментариев, 744 строки** (аудит насчитал 34 файла / 569 видимых фрагментов + 174 строки комментариев — совпадает: разница в том, что `KpiCards.tsx`, `api.ts`, `sort.ts`, `usePaginatedFilter.ts` кириллицы вне комментариев не содержат, а метрика «строк» шире метрики «фрагментов»). Самые тяжёлые: `dialogs/CreateTransactionDialog.tsx` 80 · `stats.tsx` 62 · `finance/index.tsx` 55 · `dialogs/TransactionDetailDialog.tsx` 52 · `dialogs/PayoutPaymentForm.tsx` 52 · `invoices/invoice-detail-dialog.tsx` 42 · `components/DropFinancePage.tsx` 37 · `components/TransactionRow.tsx` 33 · `dialogs/CompanySharePayoutModal.tsx` 32 · `finance/constants.ts` 31.

**Уже частично мигрированы** (импортируют Lingui-макрос, но русский текст остался — их надо ДОДЕЛАТЬ, а не начинать заново): `dialogs/AdminEditTransactionDialog.tsx` (`useLingui`/`t`, 19 строк русского) и `dialogs/CascadeImpactPanel.tsx` (`<Trans>`, 25 строк русского). Проверено `git grep -l "@lingui/.*/macro"` по продуктовым файлам периметра — только эти два.

Дальше периметр корректируется. Каждое отклонение — строка в «Допущениях» ниже.

| Что                                                                                                           | Решение                       | Почему                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Финанс-компоненты `TransactionRow`, `TransactionDetailDialog` + форматтеры `fmtUsd`/`ExchangeRates`           | **включить**                  | Живут в `finance/**`, здесь родные. Волна (c) оставила их русский текст осознанно (её «Находки вне периметра»). Здесь их родная волна                                                                                          |
| `finance/constants.ts` → `TYPE_LABELS`, `STATUS_LABELS`                                                       | **PR1 владеет + PR4 удаляет** | Хаб, потребляемый всем срезом + `FinanceTab.tsx` (web-people). PR1 вводит `*_MESSAGES`, старые строковые карты живут до PR4 (там удаляются) — как `PAYMENT_TYPE_LABELS` жил PR3→PR4 в волне (c). Handoff одного файла, серия   |
| `components/user-profile/tabs/FinanceTab.tsx` (web-people)                                                    | **PR1 (только lookup)**       | Единственный чужой потребитель `TYPE_LABELS`/`STATUS_LABELS` (проверено `git grep`). Уже Lingui-aware; его `Object.entries(TYPE_LABELS)` переводится на `i18n._()`. Остальной его текст — волны b, не трогать                  |
| `routes/_authenticated/projects/$projectId.tsx` (web-projects), вызов `fmtUsd(project.rate, currency, rates)` | **не трогать**                | `fmtUsd` сохраняет сигнатуру `(amount, currency, rates)` — меняется только его внутренний источник локали. `$projectId` при этом не редактируется. Проверено: единственный внешний потребитель `fmtUsd`                        |
| `apps/web/app/lib/format-amount.ts` (`formatAmount` `ru-RU`, `formatAmountUsd` `en-US`)                       | **см. «Спорное решение 3»**   | Кросс-срезовый корень (счета, уведомления, `fmtAmount`). Локале-осознанность — согласованно с web-core, не сигнатурным breaking-change внутри этой волны                                                                       |
| `finance/constants.ts` → `EXPENSE_CATEGORIES`                                                                 | **см. «Спорное решение 1»**   | Данные-в-БД (`receiver_label`), не чистый UI-перевод. Коды + миграция — отдельный api+shared+DDL-PROD-PR, предусловие PR3                                                                                                      |
| `localeCompare('ru')` в сортировках финанс-списков                                                            | **не входит (уже сделано)**   | Проверено `git grep localeCompare -- apps/web/app`: в finance его НЕТ. Единственный `localeCompare('ru')` — комментарий в `lib/documents-filter-sort.ts`, что он **заменён на `Intl.Collator`** ещё этапом 2 (web-docs-notify) |
| `KpiCards.tsx`, `api.ts`, `sort.ts`, `hooks/usePaginatedFilter.ts`, `receipt-permissions.ts`                  | **не мигрировать**            | Кириллицы вне комментариев 0 (проверено). `receipt-permissions.ts` — pure-логика, входит в PR2 только если правка его теста нужна                                                                                              |
| `apps/api/**`, серверные коды ошибок finance/invoices                                                         | **не трогать (#704)**         | Коды и Zod-сообщения мигрированы этапом 4. Волна потребляет `getApiErrorMessage`/`translateZodCode`, новых кодов не заводит                                                                                                    |
| `CONTEXT.md`                                                                                                  | **добавить (PR1)**            | Урок #700, п.1: формы терминов волны заводятся в глоссарий до миграции файлов. PR1 стартует первым — он и заносит канон волны (d)                                                                                              |

Итог по PR (последовательный мерж; сумма мигрируемых строк — 744):

| PR      | Что                                                                                                                                                                                                                                                                                                                                            | Продуктовых файлов | Строк кириллицы вне комм. |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------- |
| **PR1** | Хаб `constants.ts` (карты→messages, форматтеры) + реестр транзакций: `index`, `TransactionRow`, таблица, пагинация, каскад-строка, `company-share`, `cascade-preview` + консьюмер `FinanceTab`                                                                                                                                                 | 10                 | ~154                      |
| **PR2** | Детальный диалог транзакции, финансы дропа, валидация, чеки: `TransactionDetailDialog`, `DropFinancePage`, `ValidateDialog`, `ReceiptInput`, `AttachReceiptSheet`, `receipt-panel`, `PayoutDetailDialog`, `EditSeniorIncomeDialog`                                                                                                             | 8                  | ~161                      |
| **PR3** | Создание/редактирование транзакции + `EXPENSE_CATEGORIES`: `CreateTransactionDialog` (по секциям), `AdminEditTransactionDialog` (доделать), `FundingSourceFields`, `PaySalaryDialog`                                                                                                                                                           | 4                  | ~125                      |
| **PR4** | Выплаты/расчёты/каскад-панель/подтверждение + статистика + счета + удаление старых карт: `PayoutPaymentForm`, `SettleSeniorPayoutDialog`, `CompanySharePayoutModal`, `CascadeImpactPanel` (доделать), `ConfirmPayoutDialog`, `usePayoutPaymentForm`, `stats` (по секциям), `invoice-card`, `invoice-detail-dialog`, `invoice.v.$transactionId` | 10                 | ~304                      |

PR4 крупнее (мирит два файла-гиганта `stats.tsx` 62 и `invoice-detail-dialog.tsx` 42 плюс кластер выплат); делается по секциям с `wip:`, как `$projectId` (287 строк) в волне (c). Разбить его на 5-й PR — законная альтернатива (см. «Допущение 2»).

---

## Дисциплина последовательности

Волна **последовательная**, не параллельная: общий `.po` и общий хаб `finance/constants.ts`. Каждый следующий PR стартует после мержа предыдущего и ребейзится на него.

| Шаг | Что     | Ждёт                                                                | Почему                                                                                                                                                                                                                                                                                              |
| --- | ------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PR1** | —                                                                   | Вводит `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` и локале-осознанные форматтеры в `constants.ts`. **Старые `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` НЕ удаляет** — их ещё потребляют файлы PR2/PR3/PR4. Помечает их `@deprecated`. Мигрирует свои файлы + `FinanceTab` на новые карты |
| 2   | **PR2** | мерж **PR1**                                                        | Потребляет новые карты/форматтеры. Ребейз на PR1                                                                                                                                                                                                                                                    |
| 3   | **PR3** | мерж **PR2** + предусловие `EXPENSE_CATEGORIES` (Спорное решение 1) | Потребляет новые карты. Владеет диалогами создания/редактирования. `EXPENSE_CATEGORIES` — по «Спорному решению 1»                                                                                                                                                                                   |
| 4   | **PR4** | мерж **PR3**                                                        | Мигрирует **последних** потребителей `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` и **удаляет** старые карты/форматтеры из `constants.ts`. Финальная сверка `git grep -nP '\bTYPE_LABELS\b' -- apps/web/app/routes/_authenticated/finance` → пусто                                            |

**Распределение E2E-спек** (чей текст ассертит строка, тот PR её и правит; ориентир — снять точный список скриптом свипа на шаге push каждого PR). Финансовых E2E-спек в `apps/e2e/tests` (по имени: `finance*`, `drop*`, `payout*`, `invoice*`, `senior-*payout`, `transaction-*`, `company-share*`, `phase8-payout*`) — **53**; с кириллицей по свипу — подмножество. Основные ориентиры:

| PR  | Спеки (ориентир — уточнить свипом)                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 | `finance.spec.ts`, `finance-smoke-regressions.spec.ts`, `drop-income-ui.spec.ts`, `drop-balances-panel.spec.ts`, `transaction-receipts.spec.ts` (реестр/строки)                                                           |
| PR2 | `transaction-receipts.spec.ts`, `drop-*` (finance дропа), `phase8-payout-company.spec.ts` (детали/валидация)                                                                                                              |
| PR3 | `finance-funding-source.spec.ts`, `drop-share-usdt-income.spec.ts`, `drop-create.spec.ts` (создание транзакций), `finance.spec.ts` (create)                                                                               |
| PR4 | `finance-payout-simulate.spec.ts`, `finance-senior-*flow.spec.ts`, `senior-confirm-payout.spec.ts`, `drop-confirm-payout*.spec.ts`, `payout-*`, `company-share-cta.spec.ts`, `invoice-*`, `invoices-signing-flow.spec.ts` |

---

## Канон терминов волны (d) — `uk`/`en`

PR1 переносит эту таблицу в `CONTEXT.md` (раздел «Формы `uk`/`en`», продолжение волн a/b/c) первым коммитом. PR2, PR3, PR4 берут слова отсюда дословно. Колонка «Откуда» ссылается на находку аудита или глоссарий, который выбор предопределил. Формы `uk` ниже — черновик; окончательный текст утверждает `copy-reviewer` («два оригинала»).

| Термин (рус., для справки)              | `uk`                                                                                        | `en`                                                                             | `_Избегать_` в продукте (`uk`/`en`)                             | Откуда                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| Транзакция (`transactions`)             | транзакція                                                                                  | transaction                                                                      | «платіж» / payment                                              | глоссарий **Транзакция**; COPY-L-fin-20 |
| `TYPE_LABELS.PAYOUT`                    | Виплата                                                                                     | Payout                                                                           | —                                                               | глоссарий §Помеченные неоднозначности   |
| `TYPE_LABELS.SENIOR_PAID`               | Розрахунок із сеньйором                                                                     | Senior settlement                                                                | «Виплата синьору»                                               | COPY-H-fin-1                            |
| `TYPE_LABELS.SENIOR_PENDING_PAYOUT`     | Очікуваний розрахунок із сеньйором                                                          | Pending senior settlement                                                        | «Очікувана виплата синьору»                                     | COPY-H-fin-1                            |
| `TYPE_LABELS.DROP_PENDING_PAYOUT`       | Очікуваний розрахунок із дропом                                                             | Pending drop settlement                                                          | «Очікувана виплата дропу»                                       | COPY-H-fin-1                            |
| `TYPE_LABELS.PAYOUT_CONFIRMED`          | Підтверджений розрахунок                                                                    | Confirmed settlement                                                             | «Підтверджена виплата»                                          | COPY-H-fin-1                            |
| `TYPE_DESCRIPTIONS.SALARY`              | Зарплата співробітнику                                                                      | Employee salary                                                                  | —                                                               | COPY-H-fin-1                            |
| `TYPE_LABELS.ADMIN_INCOME`              | Прихід адміна                                                                               | Admin income                                                                     | «Прихід Admin» (латиниця)                                       | COPY-M-fin-11                           |
| `TYPE_LABELS.ADMIN_INCOME_CASH`         | Прихід адміна (готівка)                                                                     | Admin income (cash)                                                              | «Прихід Admin (наличные)»                                       | COPY-M-fin-11                           |
| `TYPE_LABELS.ADMIN_INCOME_CRYPTO`       | Прихід адміна (USDT)                                                                        | Admin income (USDT)                                                              | «крипто» як синонім USDT                                        | COPY-M-fin-11                           |
| `TYPE_LABELS.DIVIDEND_TO_ADMIN`         | Дивіденди адміну                                                                            | Dividend to admin                                                                | «Дивіденди Admin»                                               | COPY-M-fin-11; глоссарий **Дивиденды**  |
| `TYPE_LABELS.TOV_INCOME`                | Прихід (архів)                                                                              | Income (archived)                                                                | «Прихід ТОВ» (легасі-значення, `_Избегать_` «кошелёк ТОВ»)      | COPY-M-fin-11                           |
| `TYPE_DESCRIPTIONS.DROP_INCOME`         | Дохід дропа з проєкту                                                                       | Drop income from a project                                                       | «дохід дропа з drop-проєкту» (латиниця)                         | COPY-M-fin-11                           |
| `STATUS_LABELS.PENDING`                 | Очікує валідації                                                                            | Awaiting validation                                                              | «Очікує» без об’єкта                                            | COPY-M-fin-13                           |
| `STATUS_LABELS.PENDING_CASH_CONFIRM`    | Очікує підтвердження бухгалтером (готівка)                                                  | Awaiting accountant confirmation (cash)                                          | «Очікує підтвердження нала» («нал» — сленг)                     | COPY-M-fin-13                           |
| Роль `DROP` (в статистике)              | Дроп                                                                                        | Drop                                                                             | «Посередник», «підставна особа», «номінал», «проксі»            | COPY-H-fin-2; глоссарий **Дроп**        |
| Роль `SENIOR` / `ADMIN_SENIOR`          | Сеньйор / Адмін-сеньйор                                                                     | Senior / Admin-senior                                                            | «Senior»/«Admin-Senior» латиницею в `uk`                        | COPY-H-fin-2                            |
| Расчёт (settle)                         | розрахунок                                                                                  | settlement                                                                       | «виплата» у сенсі «віддати гроші людині»                        | глоссарий **Расчёт**                    |
| Заявка на выплату                       | заявка на виплату                                                                           | payout request                                                                   | —                                                               | глоссарий                               |
| Счёт (`invoices`)                       | рахунок                                                                                     | invoice                                                                          | «інвойс», «акт», «платіжка»                                     | глоссарий **Счёт**; COPY-L-fin-16       |
| Открыть счёт №…                         | Відкрити рахунок №…                                                                         | Open invoice #…                                                                  | «Відкрити інвойс»                                               | COPY-L-fin-16                           |
| `SIG_METHOD_LABEL.MANUAL_CLICK`         | Підписано контрагентом вручну                                                               | Signed manually by counterparty                                                  | «Підписано вручну (click + audit)»                              | COPY-M-fin-10                           |
| Проверка в блокчейне (недоступна в dev) | Перевірка в блокчейні (недоступна в тестовому середовищі)                                   | Blockchain check (unavailable in the test environment)                           | «Реальна перевірка (недоступно в dev)»; емодзі в рядку          | COPY-M-fin-10                           |
| Хеш транзакции                          | Хеш транзакції                                                                              | Transaction hash                                                                 | «TX Hash» як заголовок колонки                                  | COPY-L-fin-19                           |
| Etherscan                               | Etherscan                                                                                   | Etherscan                                                                        | «etherscan» з малої                                             | COPY-L-fin-19                           |
| Факт перевода                           | Факт переказу                                                                               | Transfer record                                                                  | «Факт платежу»                                                  | COPY-L-fin-20; глоссарий **Транзакция** |
| Нет истории платежей                    | Переказів ще не було                                                                        | No transfers yet                                                                 | «Немає історії платежів»                                        | COPY-L-fin-20                           |
| Расход-категория «Комиссия»             | Банківський збір                                                                            | Bank fee                                                                         | «Комісія» (зайнято глоссарієм під частку дропа)                 | COPY-L-fin-17; глоссарий **Доля дропа** |
| Статус платежа дропа `failed`           | Не пройшов                                                                                  | Failed                                                                           | «Помилка» без пояснення                                         | COPY-M-fin-12                           |
| Пустое: транзакций нет                  | Транзакцій ще немає — створіть першу кнопкою «Нова транзакція»                              | No transactions yet — create the first one with “New transaction”                | «Немає даних»                                                   | COPY-M-fin-6                            |
| Фильтр ничего не нашёл                  | Нічого не знайдено — скиньте фільтри                                                        | No matches — clear the filters                                                   | «Немає даних», «Порожньо»                                       | каталог волны b (ключ уже есть)         |
| Неизвестная ошибка (фолбэк)             | Не вдалося виконати операцію — спробуйте ще раз; якщо повториться, повідомте адміністратора | Could not complete the action — try again; if it persists, tell an administrator | «Невідома помилка»                                              | COPY-M-fin-7                            |
| «за {месяц}» (compliance)               | за {месяц через `fmtMonth`}                                                                 | for {month via `fmtMonth`}                                                       | «за 2026-09» (сирий `YYYY-MM`)                                  | COPY-M-fin-9                            |
| Покрытие                                | покриття {n} %                                                                              | {n}% coverage                                                                    | «{n}% покриття» (неузгоджено)                                   | COPY-M-fin-9                            |
| Активных проектов / приходов (plural)   | ICU `one/few/many`                                                                          | ICU `one/other`                                                                  | тернарник `=== 1 ? … : …`; усічення «актив. проєкта», «N прих.» | COPY-H-fin-4, COPY-L-fin-18             |
| Не меньше 3 символов (причина удаления) | Не менше 3 символів                                                                         | At least 3 characters                                                            | мовчазна заблокована кнопка                                     | COPY-M-fin-5                            |

Апостроф, многоточие, кавычки, `en`-отказы «Could not …» — по общему разделу `CONTEXT.md` «Формы `uk`/`en`», не переписывается. Роль DROP/SENIOR в `stats.tsx` и роли `COMPANY`/`COUNTERPARTY` в `invoice.v.$transactionId.tsx` — это **собственные enum'ы этих экранов**, а не app-`Role`; они переводятся своими картами (шаблон G), **не** через `ROLE_LABEL_MESSAGES` (у него другой набор ключей).

---

## Шаблоны миграции

**A–L — те же, что в волнах (a)/(b)/(c)** (см. `docs/superpowers/plans/2026-09-26-crm-i18n-stage3c-web-projects.md`, раздел «Шаблоны миграции»): A — модульная константа → `msg` + `i18n._()`; B — JSX-текст → `<Trans>`; C — атрибут/императивная строка → `t` из `useLingui()`; D — число → `<Plural>` (только компонент, урок Stryker); E — родовая/падежная форма → `select`; F — дата/деньги/число → `@crm/shared` `format.ts`; G — карта enum→`Record<…, MessageDescriptor>` (`satisfies` без `as const`); H — локальная карта ролей → канон (в этой волне **не применяется** — enum'ы `stats`/`invoice` не app-`Role`, для них шаблон G); I — E2E-ассерт → `assertInCatalog`; J — ручная плюрализация → `<Plural>`/`i18n._(msg,{count})`; K — склейка с падежом → `<Trans>`-слоты/`select`; L — дата/деньги с фиксированной локалью → `format.ts`.

Уточнения этой волны:

**G-fin. `TYPE_LABELS`/`STATUS_LABELS` → message-карты, служебные карты рядом не трогать.**

```ts
// было (finance/constants.ts)
export const TYPE_LABELS: Record<TransactionType, string> = {
  PAYOUT: 'Выплата',
  SENIOR_PAID: 'Выплата синьору' /* … 22 ключа */,
}
// стало — satisfies без as const; старую карту НЕ удалять в PR1 (потребители в PR2-4), пометить @deprecated
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
export const TYPE_LABEL_MESSAGES = {
  PAYOUT: msg`Виплата`, // en: Payout
  SENIOR_PAID: msg`Розрахунок із сеньйором`, // en: Senior settlement
  // … все 22 ключа
} satisfies Record<TransactionType, MessageDescriptor>
```

Потребитель — `i18n._(TYPE_LABEL_MESSAGES[tx.type])`. Служебные `TYPE_COLORS`/`STATUS_COLORS` (CSS-классы, не текст) — **не трогать**. `FinanceTab.tsx` (`Object.entries(TYPE_LABELS).map(([value,label]) => …)`) переводится на `Object.keys(TYPE_LABEL_MESSAGES).map((value) => ({ value, label: i18n._(TYPE_LABEL_MESSAGES[value]) }))` внутри компонента (не на уровне модуля).

**J-fin. `pluralizeProjects`/`pluralizeIncomes` + тернарники `stats.tsx` → ICU.** `finance/utils/company-share.ts` держит правильные три формы (mod10/mod100), но захардкоженные; `stats.tsx` — четыре `expected === 1 ? 'проект' : 'проекта'` (врут на 2–4 и 5+). Оба → `<Plural>` (в JSX) или `msg` с ICU + `i18n._(msg,{count})` (вне JSX). Самописные функции удалить.

```tsx
// stats.tsx (в JSX) — три формы, не тернарник
<Plural
  value={receiver.expected}
  one="# активний проєкт"
  few="# активні проєкти"
  many="# активних проєктів"
  other="# активного проєкту"
/>
// en: one="# active project" other="# active projects"
```

**K-fin. Склейки денежных фраз → `<Trans>`-слоты.** `CascadeImpactPanel.tsx` (`` `Синьору ${name}` ``, `` `Дропу ${name}` ``), `cascade-preview.ts` (`CASCADE_PREVIEW_LEAD_IN` + « — » + хвост; `cascadeStaleMessage` цитирует ярлык кнопки «Обновить предпросмотр» — COPY-L-fin-21, вынести ярлык в общую константу или переформулировать без цитаты), `CompanySharePayoutModal.tsx` (сводка «№… · N {pluralizeProjects} , M {pluralizeIncomes}» из фрагментов через `{' '}`). Имя — только в именительном.

**L-fin. Форматтеры денег/дат — один слой, сигнатуры сохранить.** В срезе 25 `toLocale*` (16 `en-US`, 8 `ru-RU`, 1 `uk-UA`) + 14 локальных `fmt*` (три пары одноимённых теней: `fmtDate ×2`, `fmtUsd ×2`, `fmtUsdt ×3`, `fmtRelative ×2`) + `date-fns/locale/ru` в двух счетах.

```ts
// finance/constants.ts: fmtDate (uk-UA) / fmtMonth (ru-RU) → format.ts с locale из useLocale()
//   fmtDate(iso)            → formatDate(iso, locale, 'short')
//   fmtMonth('2026-09')     → formatDate(`2026-09-01`, locale, 'monthYear')   // COPY-M-fin-9
// DropFinancePage: локальный fmtDate (ru-RU, тень экспортируемого) — УДАЛИТЬ, импортировать из constants
// invoices/*: import { ru } from 'date-fns/locale' + formatDistanceToNow → formatRelativeTime(d, locale)
// fmtUsd(amount, currency, rates): СИГНАТУРУ СОХРАНИТЬ (внешний потребитель $projectId).
//   Внутри `$${usd.toLocaleString('en-US', …)}` → formatMoney(usd, 'USD', locale)
// fmtAmount → formatAmount (lib/format-amount.ts): см. «Спорное решение 3»
```

Функциям, которым нужен `locale`, он передаётся аргументом или берётся из `useLocale()` в компоненте (хук в `.map()` не вызывать — один `useLingui()`/`useLocale()` на компонент, `i18n._()` внутри цикла).

---

## Общий шаг: E2E-свип (выполняется в каждом PR перед push)

Скрипт собирает русские фрагменты, которые **удалил этот PR**, и ищет их во всём `apps/e2e`. Каждая находка — строка, которую надо проверить. Если фрагмент остался в другом, ещё не мигрированном компоненте и спека ассертит именно его, строку не трогают. Если спека ассертит мигрированный экран, строку переводят на шаблон I.

```bash
SCRATCH="${TMPDIR:-/tmp}/wave-d-$(git rev-parse --abbrev-ref HEAD | tr / -)"   # свой каталог: имя из своей ветки, не общий путь
mkdir -p "$SCRATCH"
git diff origin/main -- apps/web/app > "$SCRATCH/wave-d.diff"
```

```python
# $SCRATCH/e2e_sweep.py — python3 e2e_sweep.py <path-to-wave-d.diff>
import re, sys, pathlib
ru = re.compile(r'[А-Яа-яЁё]')
frag = re.compile(r"""['"`]([^'"`\n]*[А-Яа-яЁё][^'"`\n]*)['"`]|>\s*([^<>{}\n]*[А-Яа-яЁё][^<>{}\n]*?)\s*(?:<|\{|$)|^-\s+([А-Яа-яЁё][^<>{}\n]*?)\s*(?:<|\{|$)""")
removed = set()
for line in open(sys.argv[1], encoding='utf8'):
    if line.startswith('-') and not line.startswith('---') and ru.search(line) \
            and not re.match(r'^-\s*(//|\*|\{/\*)', line):
        for m in frag.finditer(line):
            text = next(g for g in m.groups() if g).strip()
            if len(text) >= 4 and ru.search(text):
                removed.add(text)
for spec in sorted(pathlib.Path('apps/e2e').rglob('*.ts')):
    for n, line in enumerate(spec.read_text(encoding='utf8').splitlines(), 1):
        if re.match(r'^\s*(//|\*)', line):
            continue
        hits = [t for t in removed if t in line]
        if hits:
            print(f'{spec}:{n}: {hits[0]!r}')
```

```bash
python3 "$SCRATCH/e2e_sweep.py" "$SCRATCH/wave-d.diff" > "$SCRATCH/sweep.txt"
cut -d: -f1 "$SCRATCH/sweep.txt" | sort -u > "$SCRATCH/sweep-specs.txt"   # список для git add
```

Вывод целиком идёт в тело PR (раздел «E2E-свип») с отметкой по каждой строке: «переведена на каталог», «testid» или «не наш текст — <какой компонент вне волны его рендерит>». Строка без отметки — незакрытая. В коммит спеки попадают через `git add $(cat "$SCRATCH/sweep-specs.txt")`.

---

## Task 1 (PR1): хаб `constants.ts` + реестр транзакций

**Files** (кириллица вне комментариев на `5c477321f`):

| Файл                                          | Кир. строк | Паттерн(ы)  | Находки аудита / примечание                                                                                                                                                           |
| --------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finance/index.tsx`                           | 55         | A,B,C,F,G,J | COPY-M-fin-5 (порог «Не менше 3 символів»), M-6 (`EmptyRow` пусті стани), M-14 (два майже однакові тексти видалення), L-19 («TX Hash» → «Хеш транзакції»)                             |
| `components/DropFinancePage.tsx`              | 37         | B,C,F,G,L   | _(перенесён в PR2 — см. ниже)_                                                                                                                                                        |
| `components/TransactionRow.tsx`               | 33         | B,C,F,G,K   | шаблонні рядки « · до доплати ${fmtAmount}»; `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` — споживач                                                                                 |
| `finance/constants.ts`                        | 31         | G,L         | COPY-H-fin-1 (`TYPE_LABELS` терміни), M-11 (латиниця в ярликах), M-13 (`STATUS_LABELS`), L-17 (`EXPENSE_CATEGORIES` — див. PR3), форматтери `fmtDate`/`fmtMonth`/`fmtUsd`/`fmtAmount` |
| `finance/cascade-preview.ts`                  | 10         | K           | COPY-L-fin-21 (цитата ярлика кнопки), lead-in-склейка                                                                                                                                 |
| `finance/utils/company-share.ts`              | 9          | J           | `pluralizeProjects`/`pluralizeIncomes` → ICU (правильні три форми, але захардкожені)                                                                                                  |
| `components/ActiveTransactionsTable.tsx`      | 7          | B,C,G       | заголовки/споживач карт                                                                                                                                                               |
| `components/Pagination.tsx`                   | 5          | C           | чотири `aria-label` навігації (шаблон C)                                                                                                                                              |
| `components/CompanySharePayoutStrip.tsx`      | 4          | B,C         | смуга CTA частки компанії                                                                                                                                                             |
| `components/user-profile/tabs/FinanceTab.tsx` | consumer   | G           | **кросс-срез (web-people)**: `Object.entries(TYPE_LABELS/STATUS_LABELS)` → `i18n._()`; лише lookup, решта тексту — волна b                                                            |

> **Правка:** `DropFinancePage.tsx` перенесён в **PR2** (детальний/дроп-кластер) для балансу; PR1 залишає його русизм до PR2 (рядок у «E2E-свіп» PR1). Тоді PR1 ≈ 154 рядки без нього.

Вне продуктовых: `CONTEXT.md` (канон волны d), `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Тесты (обновить ассерты на каталог): `finance/__tests__/sort.test.ts`, `finance/components/__tests__/ActiveTransactionsTable.test.tsx`, `finance/components/__tests__/CompanySharePayoutStrip.test.tsx`, `finance/components/__tests__/TransactionRow.*.test.tsx`, `finance/components/__tests__/transaction-row-settled.test.tsx`, `finance/utils/company-share.test.ts`, `finance/__tests__/finance-api-cascade-preview.test.ts`, `finance/cascade-preview.spec.ts`, а также unit `user-profile/tabs/__tests__/FinanceTab.*` (если ассертит ярлыки). Новые кейсы (тип/статус без сырого enum; плюрализация проектов/приходов на 1/2/5) — внутри существующих файлов.

E2E: см. «Распределение E2E-спек», строка PR1, плюс вывод свипа.

**Interfaces:**

- Consumes: `formatDate`, `formatNumber`, `formatMoney`, `formatRelativeTime` (`@crm/shared/i18n/format`), `useLocale()` (`@/lib/i18n`), `getApiErrorMessage` (`@/lib/axios-utils`), тестовые хелперы каталога.
- Produces: `TYPE_LABEL_MESSAGES: Record<TransactionType, MessageDescriptor>`, `STATUS_LABEL_MESSAGES: Record<TransactionStatus, MessageDescriptor>`, `CASCADE_BLOCKED_REASON_MESSAGES` (если ещё строковая) в `finance/constants.ts`. **Старые `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` помечаются `@deprecated`, но НЕ удаляются** (потребители в PR2–PR4). `fmtUsd`/`fmtRate`/`fmtAmount`/`toUsd` — сигнатуры без изменений (локале-осознанность внутри). Раздел канона волны (d) в `CONTEXT.md`.

### Опасность: `constants.ts` — хаб, старые карты живут до PR4

`finance/constants.ts` — единственный источник ярлыков для всего среза + `FinanceTab`. Удалить `TYPE_LABELS`/`STATUS_LABELS` в PR1 нельзя: их потребляют файлы PR2/PR3/PR4 (проверено `git grep -l TYPE_LABELS`/`STATUS_LABELS`). Поэтому PR1 **добавляет** message-карты и мигрирует своих потребителей + `FinanceTab`, а старые строковые карты живут `@deprecated` до PR4, где удаляются (как `PAYMENT_TYPE_LABELS` PR3→PR4 волны c). Из-за этого `constants.ts` в PR1 **не заявляется «0 русских»** — его старые карты ещё русские; AC «0 `[ыэъё]`» на `constants.ts` проверяется в **PR4**, после удаления.

### Опасность: маскировка сумм `mapTx(viewer)` — RBAC, не менять

Реестр транзакций и `TransactionRow` показывают суммы, замаскированные сервером по роли смотрящего (`mapTx(viewer)`, SR-инциденты finance). Перевод меняет **только текст ярлыков/статусов**, не логику маскировки и не то, какие поля рендерятся. Тест — что после перевода набор видимых полей per-role не изменился. Строка в теле PR для `security-reviewer`.

### Acceptance criteria (PR1)

1. В `CONTEXT.md` есть подраздел «Волна d — `web-finance`» с формами из таблицы канона.
2. `TYPE_LABELS`→`TYPE_LABEL_MESSAGES` (22 ключа), `STATUS_LABELS`→`STATUS_LABEL_MESSAGES` (7) — `satisfies` без `as const`; термины по канону (COPY-H-fin-1 «розрахунок», M-11 без латиницы, M-13 статусы с объектом); старые карты `@deprecated`, не удалены; тест «в отрендеренной строке/таблице нет сырого enum» зелёный.
3. `FinanceTab.tsx` (кросс-срез) переведён на `i18n._(TYPE_LABEL_MESSAGES[...])`; его тест зелёный; остальной текст `FinanceTab` не тронут.
4. `pluralizeProjects`/`pluralizeIncomes` → ICU `<Plural>`/`i18n._(msg,{count})`; тест на 1/2/5/11/21 зелёный (COPY-H-fin-4 частично, полностью — с `stats.tsx` в PR4).
5. `TransactionRow`, `index.tsx`, `ActiveTransactionsTable`, `CompanySharePayoutStrip`, `Pagination` на `uk`/`en`: пустые состояния с причиной+шагом (M-6), «Хеш транзакції» (L-19), `aria-label` пагинации через `t`; `cascade-preview` без цитаты ярлыка (L-21).
6. Форматтеры: `fmtDate`/`fmtMonth` через `format.ts` с `useLocale()`; `fmtUsd`/`fmtAmount` — сигнатуры сохранены, локаль внутри; `date-fns/locale/ru` в файлах PR1 не появляется.
7. В файлах PR1 (кроме `constants.ts`, где живут `@deprecated` карты) 0 строк `[ыэъё]` вне комментариев.
8. Unit-тесты ассертят текст из каталога; E2E-свип выполнен, таблица в теле PR; E2E спек PR1 зелёные.
9. `pnpm i18n:extract` дважды — пустой дифф; в `en` 0 пустых `msgstr`.
10. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` зелёный.
11. Design tier 2, fidelity Mode B на всех ширинах, скриншоты 320/1440 × `uk`/`en`; `copy-reviewer` PASS по `uk` и `en`; `security-reviewer` APPROVE (маскировка сумм, реестр).

- [ ] **Step 0: Замер и предусловия**

```bash
git rev-parse --show-toplevel                       # == выданный worktree
git fetch origin main && git log --oneline -1 origin/main
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/routes/_authenticated/finance/constants.ts apps/web/app/routes/_authenticated/finance/index.tsx apps/web/app/routes/_authenticated/finance/components/TransactionRow.tsx
git grep -l "TYPE_LABELS\|STATUS_LABELS" origin/main -- apps/web/app   # актуальный список потребителей
```

Если числа отличаются от таблицы больше чем на 10 %, обновить таблицу в task-файле до начала работы.

- [ ] **Step 1: Канон терминов → `CONTEXT.md`** — подраздел «Волна d — `web-finance`» после «Волна c». Отдельный коммит `docs(context): wave d uk/en term forms`, `ac_verified: 1`.
- [ ] **Step 2: Тест на карты (падает)** — `it.each` по локалям: `TYPE_LABEL_MESSAGES.SENIOR_PAID` = «Розрахунок із сеньйором»/«Senior settlement», нет сырого enum; `STATUS_LABEL_MESSAGES.PENDING` = «Очікує валідації». Run: `pnpm --filter @crm/web test -- finance` → FAIL.
- [ ] **Step 3: `constants.ts` — message-карты + форматтеры (шаблоны G, L) → PASS** — карты по G (`@deprecated` на старых); `fmtDate`/`fmtMonth` через `format.ts`; `fmtUsd`/`fmtAmount` локаль внутри, сигнатуры целы.
- [ ] **Step 4: `index.tsx` + `TransactionRow` + таблица + пагинация + strip** — потребление карт; пустые состояния (M-6), «Хеш транзакції» (L-19), `aria-label` (шаблон C); шаблонные строки TransactionRow → `<Trans>`-слоты.
- [ ] **Step 5: `company-share.ts` + `cascade-preview.ts`** — ICU-плюрализация (J-fin); lead-in-склейка и цитата ярлыка (K-fin, L-21).
- [ ] **Step 6: `FinanceTab.tsx` (кросс-срез)** — `Object.entries(TYPE_LABELS/STATUS_LABELS)` → `i18n._()`; только lookup.
- [ ] **Step 7: Проверка, тесты, E2E-свип, гейты, коммит** (скрипт руссизм-скана по файлам PR1 кроме `constants.ts`; `i18n:extract ×2`; `typecheck`/`lint`/`test`; `DATABASE_URL= pnpm --filter @crm/e2e test -- finance`; `mutation:changed`; `check-mutation-suppressions.mjs`; `git add` явным списком + `sweep-specs.txt`).

Коммит: `feat(web,i18n): stage 3d wave (d) part 1 — finance transaction ledger to uk/en` + `ac_verified: 1,2,3,4,5,6,7,8,9,10 (11 — reviews after push)`.

**Design tier 2.** Скриншоты 320/1440 × `uk`/`en`: реестр транзакций (типы, статусы, пустые состояния, пагинация), CTA частки компанії, `FinanceTab` (профиль). Fidelity Mode B — все ширины (риск — плотная таблица на 320). `copy-reviewer` — `uk`/`en` отдельно. `security-reviewer` — обязателен.

---

## Task 2 (PR2): детальный диалог, финансы дропа, валидация, чеки

**Files:**

| Файл                                             | Кир. строк | Паттерн(ы) | Находки аудита / примечание                                                                                         |
| ------------------------------------------------ | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `components/dialogs/TransactionDetailDialog.tsx` | 52         | B,C,F,G,L  | COPY-L-fin-20 («Факт платежу» → «Факт переказу»); потребитель карт; дати/суми через `format.ts`                     |
| `components/DropFinancePage.tsx`                 | 37         | B,C,F,G,L  | COPY-M-fin-12 (`PaymentStatusBadge` `failed`), L-20 («Немає історії платежів»); локальний `fmtDate` (тінь) видалити |
| `components/dialogs/ValidateDialog.tsx`          | 27         | B,C        | COPY-H-fin-3 (сире `error.message` → розбір за статусом)                                                            |
| `components/ReceiptInput.tsx`                    | 13         | C          | COPY-H-fin-3 (catch `handleFile` → без сирого `.message`)                                                           |
| `components/dialogs/AttachReceiptSheet.tsx`      | 10         | B,C,G      | потребитель карт                                                                                                    |
| `components/dialogs/receipt-panel.tsx`           | 8          | B,C        | панель чека                                                                                                         |
| `components/dialogs/EditSeniorIncomeDialog.tsx`  | 9          | B,C        | COPY-H-fin-3 (сире `error.message`)                                                                                 |
| `components/dialogs/PayoutDetailDialog.tsx`      | 5          | B,C        | деталі заявки на виплату                                                                                            |

Тесты: `finance/__tests__/DropFinancePage.test.tsx`, `finance/__tests__/ValidateQueue.test.tsx`, `finance/components/__tests__/ReceiptInput.test.tsx`, `finance/components/__tests__/receipt-permissions.test.ts`, `finance/components/dialogs/__tests__/{transaction-detail-settled,transaction-row-settled,AttachReceiptSheet,EditSeniorIncomeDialog,PayoutDetailDialog,receipt-panel}.test.tsx`. Новые кейсы (детальный диалог без сырого enum; разбор ошибки валидации по статусу) — внутри существующих файлов.

**Interfaces:** Consumes `TYPE_LABEL_MESSAGES`/`STATUS_LABEL_MESSAGES` (из PR1), `format.ts`, `useLocale`, `getApiErrorMessage`, хелперы каталога. Produces — только потребление; ничего нового не экспортирует.

### Опасность: `DropFinancePage` — данные дропа, RBAC + тень форматтера

`DropFinancePage` показывает финансы дропа (payment-routing). Локальный `fmtDate` (`ru-RU`) **затеняет** экспортируемый из `constants.ts` — удалить и импортировать (COPY-M-fin-8). Логику маршрутизации/маскировки не менять; тест — набор видимых полей per-role не изменился. Строка для `security-reviewer`.

### Acceptance criteria (PR2)

1. `TransactionDetailDialog` на `uk`/`en`: «Факт переказу» (L-20), типы/статусы из карт PR1 без сырого enum; даты/суммы через `format.ts`.
2. `DropFinancePage` на `uk`/`en`: `PaymentStatusBadge.failed` → «Не пройшов» + подсказка (M-12); «Переказів ще не було» (L-20); локальный `fmtDate` удалён, импорт из `constants`.
3. `ValidateDialog`, `ReceiptInput`, `EditSeniorIncomeDialog` не печатают сырое `Error.message`: разбор по статусу через `getApiErrorMessage`/паттерн `cascade-preview` (COPY-H-fin-3); `axios-utils.spec.ts` контракт не сломан.
4. `AttachReceiptSheet`, `receipt-panel`, `PayoutDetailDialog` на `uk`/`en`.
5. В файлах PR2 0 строк `[ыэъё]` вне комментариев.
6. Unit ассертят каталог; E2E-свип; E2E спек PR2 зелёные.
7. `i18n:extract ×2` пустой дифф; `en` 0 пустых `msgstr`.
8. `mutation:changed survived 0`; `check-mutation-suppressions.mjs` зелёный.
9. Design tier 2, fidelity Mode B; скриншоты 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (финансы дропа, валидация).

Шаги: Step 0 замер → Step 1 тесты (падают) → Step 2 `TransactionDetailDialog` → Step 3 `DropFinancePage` (удалить тень `fmtDate`) → Step 4 `ValidateDialog`/`ReceiptInput`/`EditSeniorIncomeDialog` (разбор ошибок) → Step 5 `AttachReceiptSheet`/`receipt-panel`/`PayoutDetailDialog` → Step 6 проверка/гейты/коммит. Коммит: `feat(web,i18n): stage 3d wave (d) part 2 — transaction detail, drop finance, validation to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)`.

---

## Task 3 (PR3): создание/редактирование транзакции + `EXPENSE_CATEGORIES`

**Files:**

| Файл                                                | Кир. строк | Паттерн(ы) | Находки аудита / примечание                                                                                                                                                       |
| --------------------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/dialogs/CreateTransactionDialog.tsx`    | 80         | A,B,C,F,G  | найбільший файл волни (по секціях, `wip:`); `TYPE_DESCRIPTIONS` (H-fin-1 SALARY, M-fin-11 DROP_INCOME); `EXPENSE_CATEGORIES` (L-17) споживач; JSX-склейка «буде нараховано{' '}…» |
| `components/dialogs/AdminEditTransactionDialog.tsx` | 19         | B,C,G      | **доробити** (вже `useLingui`); `EXPENSE_CATEGORIES` читає назад із `receiverLabel` (data-at-rest); склейка «перевірте з’єднання» (K)                                             |
| `components/dialogs/FundingSourceFields.tsx`        | 8          | B,C,G      | джерело фінансування                                                                                                                                                              |
| `components/dialogs/PaySalaryDialog.tsx`            | 18         | B,C,F      | діалог виплати зарплати                                                                                                                                                           |

Тесты: `finance/components/dialogs/__tests__/CreateTransactionDialog.*.test.tsx` (7 файлов), `AdminEditTransactionDialog.test.tsx`, `PaySalaryDialog*.test.tsx`, `paid-salary-amount-edit.test.tsx`. Новые кейсы — внутри существующих.

**Interfaces:** Consumes карты PR1, `EXPENSE_CATEGORY_MESSAGES` (см. ниже), `format.ts`, `useLocale`, `getApiErrorMessage`. Produces — потребление.

### Опасность/предусловие: `EXPENSE_CATEGORIES` — данные-в-БД (см. «Спорное решение 1»)

`EXPENSE_CATEGORIES = ['Оплата сервиса','Комиссия','Прочее']` пользователь выбирает в `CreateTransactionDialog`, значение отправляется в поле `category` и пишется сервером в `transactions.receiver_label varchar(255)`; `AdminEditTransactionDialog` читает его обратно (`setCategory(tx.receiverLabel ?? …)`). Перевести литерал нельзя: старые записи перестанут совпадать с пунктами, новые запишутся на языке оператора. **Предусловие PR3** — отдельный api+shared+DDL-PR (коды `SERVICE`/`BANK_FEE`/`OTHER` + миграция значений). PR3 после него отображает коды через `EXPENSE_CATEGORY_MESSAGES` (шаблон G) и «Банківський збір» вместо «Комісія» (L-17). Если предусловие не смёржено — PR3 стоп на этой части (`.blocked.md`), остальные диалоги мигрируются.

### Acceptance criteria (PR3)

1. `CreateTransactionDialog` на `uk`/`en`: `TYPE_DESCRIPTIONS.SALARY` = «Зарплата співробітнику», `DROP_INCOME` без латиницы (H-fin-1, M-fin-11); JSX-склейка «буде нараховано …» через `<Trans>`-слот; суммы через `format.ts`.
2. `AdminEditTransactionDialog` доделан (полностью на `uk`/`en`, `useLingui` расширен на весь текст); склейка «перевірте з’єднання» через `<Trans>`/константу.
3. `EXPENSE_CATEGORIES` — по «Спорному решению 1»: коды + `EXPENSE_CATEGORY_MESSAGES`, «Банківський збір» (L-17); back-compat чтения `receiverLabel` сохранён; если предусловие не смёржено — часть заблокирована с записью.
4. `FundingSourceFields`, `PaySalaryDialog` на `uk`/`en`.
5. В файлах PR3 0 строк `[ыэъё]` вне комментариев.
6. Unit ассертят каталог; E2E-свип; E2E спек PR3 зелёные.
7. `i18n:extract ×2` пустой; `en` 0 пустых `msgstr`. 8. `mutation:changed survived 0`; suppressions зелёный. 9. Design tier 2, fidelity Mode B; скриншоты 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (создание транзакций, источник финансирования, зарплата).

Шаги: Step 0 замер + `gh pr view <EXPENSE-codes-PR> --json state` → Step 1 тесты (падают) → Step 2 `CreateTransactionDialog` по секциям (`wip:`: типы/описания → категории → суммы/склейки) → Step 3 `AdminEditTransactionDialog` доделать + `EXPENSE_CATEGORY_MESSAGES` → Step 4 `FundingSourceFields`/`PaySalaryDialog` → Step 5 проверка/гейты/коммит. Коммит: `feat(web,i18n): stage 3d wave (d) part 3 — create/edit transaction dialogs to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)`.

---

## Task 4 (PR4): выплаты/расчёты, статистика, счета + удаление старых карт

**Files:**

| Файл                                              | Кир. строк | Паттерн(ы)  | Находки аудита / примечание                                                                                                                                                                      |
| ------------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes/_authenticated/stats.tsx`                 | 62         | A,B,C,F,G,J | по секціях (`wip:`); COPY-H-fin-2 (`ROLE_LABEL` «Посредник», латиниця), H-4 (тернарники → ICU), M-9 (`за {YYYY-MM}` → `fmtMonth`, «покриття {n}%»), M-15 (помилки завантаження), L-18 (усічення) |
| `components/dialogs/PayoutPaymentForm.tsx`        | 52         | B,C,G,L     | COPY-M-fin-10 (перемикач «Реальна перевірка (недоступно в dev)», емодзі), L-19 («Відкрити в Etherscan»); `toLocaleDateString('ru-RU')` інлайн                                                    |
| `components/dialogs/CompanySharePayoutModal.tsx`  | 32         | B,C,G,K     | COPY-L-fin-18 (усічення), склейка зведення з `{' '}` + `pluralize*`; `aria-label` з датою (`toLocaleDateString('ru-RU')`)                                                                        |
| `components/dialogs/SettleSeniorPayoutDialog.tsx` | 27         | B,C         | COPY-M-fin-7 (локальна копія `extractErrorMessage`, фолбэк «Невідома помилка»)                                                                                                                   |
| `components/dialogs/CascadeImpactPanel.tsx`       | 25         | B,C,K       | **доробити** (вже `<Trans>`); склейки «Синьору ${name}»/«Дропу ${name}» → `<Trans>`-слоти                                                                                                        |
| `components/finance/ConfirmPayoutDialog.tsx`      | 24         | B,C         | `onError` підставляє `response.data.message` вербатим — потребитель серверного тексту (#704), лишити коментар про залежність від `api`                                                           |
| `invoices/invoice-detail-dialog.tsx`              | 42         | B,C,G,L     | COPY-L-fin-16 («Інвойс» → «Рахунок»), M-10 (`SIG_METHOD_LABEL.MANUAL_CLICK`), M-15 (помилки завантаження документа/PDF); `date-fns/locale/ru`                                                    |
| `invoice.v.$transactionId.tsx`                    | 26         | B,C,G       | `ROLE_LABEL` (COMPANY/COUNTERPARTY — власний enum, шаблон G), заголовки таблиці підписів                                                                                                         |
| `components/dialogs/PayoutDetailDialog.tsx`       | —          | —           | _(мигрирован в PR2)_                                                                                                                                                                             |
| `invoices/invoice-card.tsx`                       | 5          | B,C,L       | COPY-L-fin-16 («Відкрити рахунок №…»); `date-fns/locale/ru` → `formatRelativeTime`                                                                                                               |
| `hooks/usePayoutPaymentForm.ts`                   | 9          | C           | COPY-M-fin-7 (`extractErrorMessage` фолбэк) — звести з копією в `SettleSeniorPayoutDialog`                                                                                                       |
| `finance/constants.ts`                            | (delete)   | —           | **удалить** `@deprecated` `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` (последние потребители мигрированы); финальная сверка `git grep TYPE_LABELS`                                        |

Тесты: `admin`-нет; `finance/components/dialogs/__tests__/{CompanySharePayoutModal,SettleSeniorPayoutDialog,cascade-impact-panel*,settle-senior-remaining,paid-salary-amount-edit}.test.tsx`, `finance/__tests__/finance-api-cascade-preview.test.ts`, `components/finance/__tests__/ConfirmPayoutDialog.test.tsx`, `invoices/__tests__/{invoice-card,invoice-detail-dialog}.test.tsx`. `stats.tsx` — тесты по `compliance-row-*` testid. Новые кейсы (ROLE_LABEL без «Посредник»/латиницы; ICU-плюрализация compliance на 1/2/5) — внутри существующих.

**Interfaces:** Consumes карты PR1, `format.ts`, `useLocale`, `getApiErrorMessage`, `translateZodCode`, хелперы каталога. Produces: **удаляет** старые `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` из `constants.ts`. После PR4 `git grep -nP '\bTYPE_LABELS\b|\bSTATUS_LABELS\b' -- apps/web/app/routes/_authenticated/finance` — пусто.

### Опасность: удаление старых карт — только когда потребителей не осталось

Перед удалением `@deprecated` карт — `git grep -nP '\bTYPE_LABELS\b' -- apps/web/app` должен вернуть только `constants.ts` (определение) и, возможно, комментарии `projects/constants.ts`. Любой живой потребитель = стоп, доделать его в PR4.

### Опасность: выплаты/расчёты/счёт компании — critical-path

`PayoutPaymentForm`, `CompanySharePayoutModal`, `SettleSeniorPayoutDialog`, `ConfirmPayoutDialog` — заявки на выплату, расчёты, счёт компании (drop-share, дивиденды). `ConfirmPayoutDialog` печатает `response.data.message` вербатим — пока `api` не локализован полностью, экран смешанный (известное ограничение, отметить в теле PR; логику не менять). Строка для `security-reviewer`.

### Acceptance criteria (PR4)

1. `stats.tsx` на `uk`/`en`: `ROLE_LABEL` = «Дроп»/«Сеньйор»/«Адмін-сеньйор» без «Посредник»/латиницы (H-fin-2); четыре тернарника → ICU `<Plural>` (H-fin-4); «за {месяц}» через `fmtMonth`, «покриття {n} %» (M-9); ошибки загрузки с причиной+кнопкой (M-15); усечения раскрыты (L-18).
2. `PayoutPaymentForm`, `CompanySharePayoutModal`, `SettleSeniorPayoutDialog`, `CascadeImpactPanel` (доделан), `ConfirmPayoutDialog`, `usePayoutPaymentForm` на `uk`/`en`: жаргон убран (M-10), «Відкрити в Etherscan» (L-19), склейки через `<Trans>`-слоты/ICU (K-fin), фолбэк ошибки с действием (M-7), даты через `format.ts`.
3. Счета на `uk`/`en`: «Рахунок» вместо «Інвойс» (L-16, 11 мест), `SIG_METHOD_LABEL` человеческим языком (M-10), ошибки загрузки документа/PDF с хвостом по статусу (M-15), `ROLE_LABEL` счёта (шаблон G), `date-fns/locale/ru` заменён на `formatRelativeTime`.
4. Старые `TYPE_LABELS`/`STATUS_LABELS`/`fmtDate`/`fmtMonth` удалены из `constants.ts`; `git grep` в finance пуст; `constants.ts` — 0 строк `[ыэъё]` вне комментариев.
5. В файлах PR4 0 строк `[ыэъё]` вне комментариев; строки с сырым enum разобраны.
6. Unit ассертят каталог; E2E-свип; E2E спек PR4 зелёные.
7. `i18n:extract ×2` пустой; `en` 0 пустых `msgstr`. 8. `mutation:changed survived 0`; suppressions зелёный. 9. Финальная сверка волны (d) (скрипт ниже) — `violations: 0`, `git grep TYPE_LABELS/STATUS_LABELS` в finance пуст. 10. Design tier 2, fidelity Mode B; скриншоты 320/1440 × `uk`/`en`; `copy-reviewer` PASS `uk`/`en`; `security-reviewer` APPROVE (выплаты, расчёты, счёт компании, счета).

Финальная сверка волны (d) — в PR4, в тело PR:

```bash
python3 - <<'EOF'
import re, pathlib, subprocess
out = subprocess.run(['git','ls-files',
  'apps/web/app/routes/_authenticated/finance','apps/web/app/components/finance',
  'apps/web/app/components/invoices','apps/web/app/routes/_authenticated/stats.tsx',
  'apps/web/app/routes/invoice.v.$transactionId.tsx'], capture_output=True, text=True).stdout.split()
bad=0
for f in out:
    if re.search(r'__tests__|\.(spec|test)\.', f): continue
    for n,l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(),1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f,n,l.strip()); bad+=1
print('violations:', bad)
EOF
git grep -nP '\bTYPE_LABELS\b|\bSTATUS_LABELS\b' -- apps/web/app/routes/_authenticated/finance   # ожидается: пусто
```

Шаги: Step 0 замер → Step 1 тесты (падают) → Step 2 `stats.tsx` по секциям (`wip:`: ROLE_LABEL → compliance-плюрализация → месяц/покрытие → ошибки/усечения) → Step 3 кластер выплат/расчётов → Step 4 счета (invoice-card, invoice-detail-dialog, invoice.v) → Step 5 **удаление** старых карт из `constants.ts` + финальная сверка → Step 6 гейты/коммит. Коммит: `feat(web,i18n): stage 3d wave (d) part 4 — payouts, stats, invoices to uk/en`, `ac_verified: 1,2,3,4,5,6,7,8,9 (10 — reviews after push)`.

---

## Трассировка находок аудита `web-finance`

`Findings:` среза — 21. Каждый идентификатор ниже.

| Находка       | Статус на `5c477321f`                  | Где закрывается                                                                              |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| COPY-H-fin-1  | открыта (термины `TYPE_LABELS`)        | PR1 Step 3 (карта), PR3 Step 2 (`TYPE_DESCRIPTIONS.SALARY`)                                  |
| COPY-H-fin-2  | открыта («Посредник», латиница)        | PR4 Step 2 (`stats.ROLE_LABEL`)                                                              |
| COPY-H-fin-3  | открыта (сырое `Error.message`)        | PR2 Step 4 (`ValidateDialog`/`ReceiptInput`/`EditSeniorIncome`), PR4 Step 3 (`SettleSenior`) |
| COPY-H-fin-4  | открыта (тернарники plural)            | PR1 Step 5 (`company-share`), PR4 Step 2 (`stats`)                                           |
| COPY-M-fin-5  | открыта (порог 3 символа не назван)    | PR1 Step 4 (`index.tsx`)                                                                     |
| COPY-M-fin-6  | открыта (`EmptyRow` «Нет данных»)      | PR1 Step 4                                                                                   |
| COPY-M-fin-7  | открыта («Неизвестная ошибка»)         | PR4 Step 3 (`usePayoutPaymentForm` + `SettleSenior`)                                         |
| COPY-M-fin-8  | открыта (четыре формата даты, тень)    | PR1 Step 3 (форматтеры), PR2 Step 3 (тень в `DropFinancePage`)                               |
| COPY-M-fin-9  | открыта (`за {YYYY-MM}`, «% покрытие») | PR4 Step 2 (`stats`)                                                                         |
| COPY-M-fin-10 | открыта (жаргон, эмодзи)               | PR4 Step 2 (`PayoutPaymentForm`), Step 4 (`invoice-detail`)                                  |
| COPY-M-fin-11 | открыта (латиница в ярлыках)           | PR1 Step 3 (`TYPE_LABELS`), PR3 Step 2 (`TYPE_DESCRIPTIONS.DROP_INCOME`)                     |
| COPY-M-fin-12 | открыта (`PaymentStatusBadge.failed`)  | PR2 Step 3                                                                                   |
| COPY-M-fin-13 | открыта (`STATUS_LABELS` неоднозначны) | PR1 Step 3                                                                                   |
| COPY-M-fin-14 | открыта (два похожих текста удаления)  | PR1 Step 4 (`index.tsx`)                                                                     |
| COPY-M-fin-15 | открыта (ошибки загрузки без действия) | PR4 Step 2 (`stats`), Step 4 (`invoice-detail`)                                              |
| COPY-L-fin-16 | открыта («Инвойс» ×11)                 | PR4 Step 4 (счета)                                                                           |
| COPY-L-fin-17 | открыта («Комиссия» в расходах)        | PR3 Step 3 (`EXPENSE_CATEGORIES`)                                                            |
| COPY-L-fin-18 | открыта (усечения)                     | PR4 Step 2 (`stats`), Step 3 (`CompanySharePayoutModal`)                                     |
| COPY-L-fin-19 | открыта («TX Hash», etherscan)         | PR1 Step 4 (`index.tsx`), PR4 Step 2 (`PayoutPaymentForm`)                                   |
| COPY-L-fin-20 | открыта («Факт платежа», «платёж»)     | PR2 Step 2 (`TransactionDetailDialog`), Step 3 (`DropFinancePage`)                           |
| COPY-L-fin-21 | открыта (цитата ярлыка кнопки)         | PR1 Step 5 (`cascade-preview`)                                                               |

Findings: COPY-H-fin-1 … COPY-H-fin-4, COPY-M-fin-5 … COPY-M-fin-15, COPY-L-fin-16 … COPY-L-fin-21 (21) — строк в таблице 21.

---

## Находки вне периметра (не расширяем, записываем)

| Что                                                                                                                   | Чья волна / куда                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/web/app/lib/format-amount.ts` (`formatAmount` `ru-RU`, `formatAmountUsd` `en-US`) — корень форматирования денег | Кросс-срез (счета, уведомления, web-core). См. «Спорное решение 3» — отдельная согласованная правка |
| `EXPENSE_CATEGORIES` коды + миграция `receiver_label` (api + shared + prod-DDL)                                       | Отдельный api+shared+DDL-PR, предусловие PR3. См. «Спорное решение 1»                               |
| `ConfirmPayoutDialog.onError` / `cascade-preview.extractBackendMessage` — вербатим серверный текст                    | Пока `api` не локализован полностью, экран смешанный. Зависимость от среза `api`; логику не менять  |
| Серверные коды ошибок finance/invoices                                                                                | Мигрированы #704 — потреблять, не дублировать                                                       |

---

## Что НЕ входит

- **`apps/api`** — волна `apps/web` его не трогает (кроме предусловия `EXPENSE_CATEGORIES`, вынесенного отдельным PR).
- **Этап 6**: ESLint `lingui/no-unlocalized-strings` в режиме error, guard на русские буквы, `extract --clean` как хард-гейт.
- Тексты с явным id (`api-error.*`, `zod-error.*`) волна не меняет, а только использует (#704).
- Валюты/бренды (`USDT`, `USD`, `UAH`, `EUR`, `Etherscan`, `HR`) — не переводятся.
- `localeCompare('ru')` — в finance его нет (проверено); в `documents-filter-sort.ts` уже заменён на `Intl.Collator` этапом 2 (web-docs-notify).

---

## Допущения (A1 — обратимые, записаны)

1. **Периметр = срез аудита `web-finance` + финанс-компоненты, оставленные волной c** (`TransactionRow`, `TransactionDetailDialog`, `fmtUsd`, `ExchangeRates` — они в `finance/**`, здесь родные). Исключены: файлы без кириллицы (`KpiCards`, `api.ts`, `sort.ts`, `usePaginatedFilter`), `apps/api`, format-amount-корень (кросс-срез), EXPENSE-миграция (отдельный PR). Каждое отклонение — строка в таблице «Периметр».
2. **4 PR, последовательный мерж.** Срез 744 строки / 30 файлов ≈ волна c (786/33 → 4 PR). PR4 крупнее (~304) из-за `stats.tsx` + счетов + удаления карт — делается по секциям (`stats` и `CreateTransactionDialog` — `wip:` по секциям), как `$projectId` в волне c. **Альтернатива:** выделить статистику+счета в 5-й PR — без изменения остального плана; выбор за оркестратором/владельцем, если ревью PR4 окажется тяжёлым.
3. **`security-reviewer` обязателен на ВСЕХ четырёх PR** (весь срез — деньги/RBAC/critical-path), а не только на «финансовых»: даже реестр показывает суммы с маскировкой `mapTx(viewer)`.
4. **`fmtUsd`/`fmtAmount`/`toUsd` сохраняют сигнатуры** — локале-осознанность делается внутри, чтобы `$projectId` (web-projects) и другие внешние потребители не редактировались этой волной.
5. **Старые `TYPE_LABELS`/`STATUS_LABELS` живут `@deprecated` PR1→PR4**, удаляются в PR4 (как `PAYMENT_TYPE_LABELS` PR3→PR4 волны c). Из-за этого `constants.ts` «0 русских» проверяется в PR4, не PR1.
6. **Черновики `uk`/`en` в каноне** — ориентир; окончательный текст утверждает `copy-reviewer` («два оригинала»); расхождение с черновиком — не нарушение плана.
7. **Роли `stats`/`invoice` — свои enum'ы**, переводятся шаблоном G, не через `ROLE_LABEL_MESSAGES` (у него другой набор ключей).

## Вопросы владельцу (A2 — необратимо/дорого, копятся в decision brief)

1. **`EXPENSE_CATEGORIES` — миграция данных `receiver_label` на проде.** Ввод стабильных кодов (`SERVICE`/`BANK_FEE`/`OTHER`) требует миграции существующих русских значений в проде (finance-данные, prod-DDL через `deploy.yml`, без SSH). Это **необратимо** и **критический путь** → A3-по-cost-of-error, но не блокирует остальную волну. **Рекомендация:** отдельным api+shared-PR ДО PR3, с идемпотентным SQL в `deploy.yml`, security+DDL-review. Если владелец предпочтёт минимум — интерим: отображение по коду + back-compat resolver старых русских значений, реальная миграция данных отложена (тогда data-at-rest остаётся русским до отдельной задачи; guard этапа 6 это позже отметит). Нужно решение владельца по сроку миграции.
2. **`lib/format-amount.ts` локале-осознанность.** Корень форматирования денег (`ru-RU`/`en-US`) используют счета, уведомления, `fmtAmount`. Сделать локале-осознанным можно (а) без смены сигнатуры — читать текущую локаль из i18n-контекста, или (б) добавить параметр `locale` — breaking для всех вызовов (web-core, api). **Рекомендация:** вариант (а) в рамках этой волны для finance-вызовов, полное сведение — согласованная задача с web-core; уточнить у владельца, делать ли (б) сейчас или отложить. Не блокирует PR1–PR4 (finance-суммы форматируются через `formatMoney`/`fmtUsd` с локалью).

---

## Проверка готовности волны (d)

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — зелёные после каждого PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test` на спеках из «Распределения» и вывода свипа — зелёные; CI на всех шардах зелёный.
- `pnpm i18n:extract` дважды подряд — второй прогон не меняет `.po`; в `en` 0 пустых `msgstr`.
- `pnpm mutation:changed` — `survived 0`; `NoCoverage` без integration-hint закрыт unit-тестом; `node scripts/devops/check-mutation-suppressions.mjs` — зелёный.
- Финальная сверка PR4: 0 строк с `[ыэъё]` вне комментариев в периметре; `git grep TYPE_LABELS/STATUS_LABELS` в finance пуст; старые форматтеры-тени удалены.
- В `CONTEXT.md` есть подраздел «Волна d — `web-finance`».
- `copy-reviewer`: `PASS` на `uk` и на `en` для каждого из 4 PR.
- `security-reviewer`: `APPROVE` для ВСЕХ четырёх PR (маскировка сумм, доля дропа/сеньора, счёт компании, дивиденды, выплаты/расчёты, счета).
- Скриншоты 320/1440 × `uk`/`en` для каждого мигрированного экрана — в теле каждого PR; fidelity Mode B — все ширины.
- Трассировка: 21 идентификатор аудита `web-finance` — у каждого строка в теле того PR, который его закрывает (`review-findings-transfer.md`).
