# CRM i18n — этап 4 «API и shared» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести серверный и общий (сервер+клиент) текст CRM до той же схемы, что уже работает для
восьми кодов `api-errors.ts`: исключения `apps/api` отдают `code` + `params` вместо русской/английской
прозы, Zod-сообщения `packages/shared` из литералов становятся кодами того же вида, заголовки/тела
уведомлений при показе и десять писем рендерятся по типу через каталог `uk`/`en` на локали получателя.
Ни один из ~337 текущих throw-сайтов с кириллицей и ни одно из 96 Zod-сообщений не остаётся
литералом к концу этапа — они либо в реестре кодов, либо явно вынесены за периметр (см. «Что НЕ
входит»).

**Architecture:** Механизм уже выбран и работает в `origin/main` для восьми кодов — этот план его
**расширяет**, не изобретает заново. `apps/api` и `packages/shared` — CommonJS, без babel; строки там
живут как объекты `MessageDescriptor` (`{ id: 'namespace.CODE', message: '<українською>' }`,
помеченные `/* i18n */`) в реестрах-`Record`, а не как макросы `t`/`msg`. Каждый реестр читают ОБЕ
стороны (`apps/api` для рендера письма/ответа на локали получателя/запроса через `createI18n(locale)`,
`apps/web` — через общий `i18n` singleton `@lingui/react`). Ошибки API продолжают ехать конвертом
`{ statusCode, code, params?, message }`; Zod-сообщения едут тем же путём — `message` в схеме
перестаёт быть переводимым текстом и становится стабильным кодом, который резолвит новый
`ZOD_ERROR_MESSAGES`-реестр на обеих сторонах. Уведомления и письма продолжают НЕ хранить текст в
БД — рендерятся по `type` + `data` в момент показа/отправки, на локали читателя (попап/`/pending`) или
получателя (письмо, `users.locale`, крон).

**Tech Stack:** Lingui **5.9.5 EXACT** (`@lingui/core`; `@lingui/core/macro` НЕ доступен в
`apps/api`/`packages/shared` — доказательство ниже), NestJS 11 + Fastify, Drizzle, Zod 4, Vitest 4,
pnpm 7.32.4, Node 22 LTS.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.3–4.4, §7 п.4, §8. Аудит:
`docs/architecture/2026-09-19-crm-i18n-audit.md` (срезы `api`, `shared`). Соседние планы того же
семейства (формат, уже проверенные решения — не переоткрывать): `2026-09-19-crm-i18n-stage2-foundation.md`
(механизм `createI18n`, `api-errors.ts`, `request-locale.ts` — уже в `main`), `2026-09-20-crm-i18n-stage3a-web-core.md`
(раздел «Тестовый доступ к каталогу», `ROLE_LABEL_MESSAGES`/`useRoleLabel` — транзитный шим).

## Спайк: раскрываются ли babel-макросы Lingui в `nest build`?

**Вопрос из задания:** можно ли использовать `t`/`msg` из `@lingui/core/macro` в `apps/api`, учитывая
что `nest build` = `tsc`, а макросы раскрываются только babel/swc-плагином.

**Метод — только чтение конфигов, без правок в репозитории:**

```bash
cat apps/api/nest-cli.json        # compilerOptions.tsConfigPath → tsconfig.build.json, builder не указан → дефолт tsc
cat apps/api/tsconfig.json        # module: CommonJS, никакого babel-препроцессора
grep '"build"\|"test"' apps/api/package.json   # "build": "nest build && ...", "test": "vitest run"
grep -iE '"@babel|babel-plugin|lingui' apps/api/package.json packages/shared/package.json
```

**Результат (все четыре команды выполнены на `origin/main`):**

- `nest-cli.json`: `compilerOptions.tsConfigPath = "tsconfig.build.json"`, поле `builder` отсутствует →
  Nest CLI использует **дефолтный TypeScript-компилятор** (`tsc`), а не `webpack`/`swc` (единственные
  билдеры Nest CLI, которые умеют гонять babel/swc-плагины).
- `apps/api/tsconfig.json`: `"module": "CommonJS"`, `"moduleResolution": "Node"` — чистый `tsc`,
  никакого препроцессора.
- `apps/api/package.json` scripts: `"build": "nest build && node scripts/check-di-metadata.cjs"`,
  `"test": "vitest run"` — оба пути (сборка и тесты) идут мимо babel.
- `grep -iE '"@babel|babel-plugin|lingui'` на **обоих** `package.json` (`apps/api`, `packages/shared`)
  возвращает **ровно одну строку** в каждом: `"@lingui/core": "5.9.5"`. Ни `@babel/core`, ни
  `@lingui/babel-plugin-lingui-macro`, ни `@lingui/vite-plugin` в зависимостях нет.

**Вывод: макросы `t`/`msg` из `@lingui/core/macro` в `apps/api` и `packages/shared` недоступны** —
импорт виртуального macro-пакета без babel-трансформа не резолвится ни в рантайме (`ts-node`/`vitest`),
ни при `tsc`-сборке. Это подтверждает и уже смёрженный код: `packages/shared/src/schemas/api-errors.ts`
использует не макрос, а **явный объект** `MessageDescriptor` с id `api-error.<CODE>`, помеченный
комментарием `/* i18n */` (та же конвенция, которую `lingui extract`'s babel-plugin понимает и без
трансформа — сканирует литерал по комментарию, а не раскрывает вызов). Проверено и через
context7 (`/lingui/js-lingui/v5.9.5`, `i18n._(messageId, values?, options?)` и
`i18n._({id, message, values})` — обе формы документированы как штатный non-macro API, `defineMessage`/`msg`
описаны отдельно как то, что «раскрывается компилятором»).

**Решение, зафиксировано в Global Constraints:** весь новый текст `apps/api`/`packages/shared` этого
этапа — объекты `MessageDescriptor` (`{ id, message }` c `/* i18n */`) в `Record`-реестрах, вызов —
`i18n._(id, values, { message })` (форма из `axios-utils.ts`'s `translateApiError`, не
`i18n._(<object>)` — та форма падает на экстракторе при `SpreadElement`, см. комментарий в файле).
Экземпляр `i18n` — **только** через `createI18n(locale)` (`packages/shared/src/i18n/catalog.ts`, уже в
`main`), никогда глобальный `activate` на сервере.

## Global Constraints

- **Механизм строк api/shared — `MessageDescriptor` + explicit id, НЕ макросы** (спайк выше).
  Формат id: `<namespace>.<CODE>` (namespace = `api-error`, `zod-error`, `notification`, `email`).
  Каждый реестр — `Record<Code, MessageDescriptor>`, помечен `/* i18n */` на каждой записи, живёт в
  `packages/shared/src/schemas/*.ts` (читают обе стороны) или `apps/api/src/**` (только сервер — письма).
- **Lingui 5.9.5 EXACT**, языки `uk` (source/дефолт) `en`. Исходный текст в реестрах — **украинский**
  (не русский: спец §1 решение 1 — русский убирается из продукта полностью, новый текст сразу uk+en).
- **`params` — никогда PII**, компилируется в тип через `ParamsFor<C>`-паттерн (`api-errors.ts` —
  расширять ТУ ЖЕ схему, не заводить вторую). Значение параметра — либо примитив без данных пользователя
  (роль-enum, статус-enum, число), либо отсутствует; человеческое имя, email, сумма — никогда параметром
  HTTP-ошибки.
- **`i18n` — per-request/per-recipient, никогда глобальный синглтон на сервере**
  (`createI18n(locale)` из `@crm/shared`; локаль ошибки — `resolveRequestLocale`/`@RequestLocale()`
  запроса; локаль письма/уведомления — `users.locale` **получателя**, не отправителя и не крона).
- **Тестовый доступ к каталогу в `apps/api` Vitest** (нет React, нет `activateLocale`):
  ```ts
  import { createI18n } from '@crm/shared'
  const i18n = createI18n('uk')
  i18n._(SOME_DESCRIPTOR.id, params, { message: SOME_DESCRIPTOR.message })
  ```
  **Готча, подтверждена командами:** `turbo.json`'s задача `test` несёт
  `"dependsOn": ["//#i18n:compile", "^build"]`, но `apps/api/package.json`'s `"test": "vitest run"` —
  документированный в `CLAUDE.md` шорткат `pnpm --filter @crm/api test` вызывает этот скрипт
  **напрямую**, минуя граф зависимостей turbo. Если `packages/shared/src/i18n/locales/*/messages.ts`
  устарел или отсутствует — тест на реестр упадёт `MODULE_NOT_FOUND` независимо от того, что делает
  каталог. Перед `pnpm --filter @crm/api test` (или `@crm/shared test`) в этом этапе — **всегда**
  `pnpm i18n:compile` первой командой, либо `pnpm turbo run test --filter=@crm/api` вместо шортката.
- **Zod-сообщения — код, не перевод, в самой схеме** (спека §4.3, решение уже принято, не пересматривать):
  `message: 'zod.<CODE>'` в схеме — стабильная строка-ключ, а не текст на экране. Новый реестр
  `ZOD_ERROR_MESSAGES: Record<ZodErrorCode, MessageDescriptor>` (тот же shape, что `API_ERROR_MESSAGES`)
  резолвит её в текст на обеих сторонах: `ZodExceptionFilter` (сервер, 400-й ответ) и форма (клиент,
  `apps/web`, задача вне этого этапа по файлам — используется существующий рендер ошибок формы).
- **Глоссарий (`CONTEXT.md`, `_Избегать_`) — фиксится ПОПУТНО с переносом кода, не отдельным проходом:**
  «инвойс» → «рахунок»/«invoice» **только** как имя объекта, не термин (глоссарий: «Счёт», `_Избегать_`:
  инвойс/акт/платёжка); «платёж» для `transactions` → «транзакція»/«transaction» (`_Избегать_`: платёж,
  проводка); «IOU»/«obligation» в леджере → «зобов'язання»/«obligation» по глоссарию (`Обязательство`,
  `_Избегать_`: долг, IOU). Перевод на «третий» язык дефекта не чинит его — переносить текст в реестр
  строго уже в исправленной формулировке (аудит §696 п.3: «раньше перевода, чтобы не переводить брак»).
- **Реальный объём (проверено командами на `origin/main` сегодня, не по аудиту 2026-09-19 — см. ниже
  расхождение с оценкой спеки)**, см. таблицу «Объём» в каждом Track.
- Тесты: unit `apps/api`/`packages/shared` с `createI18n`; integration — там, где throw идёт из ветки с
  БД/RLS (мутационный гейт их не видит — unit-дубль обязателен, `mutation-gate-integration-specs.md`).
- `git add` явным списком; `DATABASE_URL= git push`; без `--no-verify`; коммиты с `ac_verified: <N>`.
- `security-reviewer` обязателен на PR, трогающих `finance/`, `auth/`, `users/` (critical-path,
  `pm.md`), даже когда diff — только замена текста на код (params — новая поверхность, требует проверки
  на утечку).
- `copy-reviewer` — вердикт по `uk` **и** `en` отдельно на каждый PR, трогающий каталог.
- Зона: `apps/api/**`, `packages/shared/**` — Coder. Тестовые файлы (`*.spec.ts`) — тоже Coder (правка
  ассертов внутри уже мигрирующего модуля, не новый E2E-спек — `zone-of-write.md`, сноска про AutoTest).

## Расхождение с оценкой спеки (289) — зафиксировано, не тихо исправлено

Спека §7 п.4 и `api-errors.ts`'s комментарий цитируют «289 оставшихся исключений» — цифра из сводки
аудита (§3: «289 русских + 214 английских»). Прямая проверка **сегодня** на `origin/main`:

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src | grep -v '\.spec\.ts' \
  | grep -P "[А-Яа-яЁё]" | wc -l                                    # однострочные: 266
git grep -n -A1 "Exception($" origin/main -- apps/api/src | grep -v '\.spec\.ts' \
  | grep -P "[А-Яа-яЁё]" | wc -l                                    # многострочные: 71
```

Итого **337** throw-сайтов с кириллическим сообщением сегодня (266+71), не 289. Расхождение — не
регрессия: детальная таблица того же аудита (`docs/architecture/…audit.md`, срез `api`, строка
«с кириллическим сообщением») уже называла **339** (266+73); её просто не перенесли в сводку §3.
Разница 339→337 объясняется семью файлами, которые частично мигрировали на `apiError()` за прошедшую
неделю (`employee-contracts.service.ts`, `signed-contracts.service.ts`, `invoices.service.ts`,
`notifications.controller.ts`, `projects.service.ts`, `tos.service.ts`, `users.service.ts` — 10
вызовов `apiError(` суммарно, восемь зарегистрированных кодов). **В этом плане — 337, число из
детальной таблицы аудита, не 289 из её сводки.** Расхождение — не находка ревью, если явка в PR body
и здесь одна: 289 никогда не было измерением, это была сумма, переписанная из другого раздела того же
документа.

---

## Карта файлов

| Файл                                                                                                                                                                                                 | Ответственность                                                                                                                                             | Задача |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/shared/src/schemas/api-errors.ts`                                                                                                                                                          | `API_ERROR_CODES`/`API_ERROR_MESSAGES`/`API_ERROR_PARAMS` — расширение                                                                                      | 1,2,3  |
| `apps/api/src/{auth,users,projects}/**`                                                                                                                                                              | Throw-сайты модулей волны A1 → `apiError()`                                                                                                                 | 1      |
| `apps/api/src/{finance,invoices}/**`                                                                                                                                                                 | Throw-сайты волны A2 (крупнейшая концентрация)                                                                                                              | 2      |
| `apps/api/src/{documents,contracts,teams,legends,approvals,interviews,notifications}/**`                                                                                                             | Throw-сайты волны A3                                                                                                                                        | 3      |
| `packages/shared/src/schemas/zod-errors.ts` (новый)                                                                                                                                                  | `ZodErrorCode`, `ZOD_ERROR_MESSAGES: Record<Code, MessageDescriptor>`                                                                                       | 4      |
| `apps/api/src/zod-exception.filter.ts`                                                                                                                                                               | Issues отдают `code` вместо голого `message`                                                                                                                | 4      |
| `packages/shared/src/schemas/{money,finance,users,payment-requisites}.ts`                                                                                                                            | Zod-сообщения волны B1 (дубли, самые массовые)                                                                                                              | 4      |
| `packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,tos,admin-actions}.ts` | Zod-сообщения волны B2                                                                                                                                      | 5      |
| `packages/shared/src/schemas/notification-registry.ts`                                                                                                                                               | `NOTIFICATION_TITLES`/`ACTION_LABELS`/`SUBJECT_*_LABELS` → `MessageDescriptor`, `describeNotification`/`subjectPhrase` на `i18n`, `money()` → `formatMoney` | 6      |
| `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/vacancies/applications.service.ts`                                                                                                        | Регистрация 3 «замороженных» типов в реестр (COPY-H-shared-5)                                                                                               | 6      |
| `apps/api/src/notifications/notification-email-copy.ts`                                                                                                                                              | 10 писем → `MessageDescriptor`/`select`/`plural`, `i18n._()` на локали получателя                                                                           | 7      |
| `apps/api/src/notifications/notification-email-copy.spec.ts`                                                                                                                                         | Снапшот темы+тела на `uk` и `en`, вместо русских подстрок                                                                                                   | 7      |
| `apps/api/src/notifications/notification-email.cron.ts`                                                                                                                                              | Активация локали получателя перед рендером                                                                                                                  | 7      |
| `apps/api/src/users/personal-email-invite-mailer.service.ts`                                                                                                                                         | Приглашение — локаль решается (A2-вопрос ниже)                                                                                                              | 7      |

Порядок: (1, 2, 3 — параллельно, волна ≤3 PR) → 4 → (5 — сама по себе, зависит от реестра Task 4) → 6 → 7.
Этап 5 (PDF счетов) стартует после Task 6/7 — общий каталог и активация локали получателя должны
существовать (спека §7: «5 — после 4»).

---

## Track A — коды ошибок по модулям (289/337 throw-сайтов)

### Task 1: Коды ошибок — `auth`/`users`/`projects`

**Files:**

- Modify: `packages/shared/src/schemas/api-errors.ts` — добавить коды этой волны в `API_ERROR_CODES`,
  `API_ERROR_MESSAGES`, `API_ERROR_PARAMS`, `API_ERROR_FALLBACK_EN`
- Modify: `apps/api/src/auth/*.service.ts` (6 throw-сайтов с кириллицей), `apps/api/src/users/users.service.ts`
  (54 кириллица + 26 английских — **самый крупный файл волны**, делить на суб-PR по под-фиче при
  необходимости: команда сама решит по факту diff-size), `apps/api/src/projects/projects.service.ts`
  (12 кириллица + 28 английских; **уже частично мигрирован** — 2 вызова `apiError()`, не переписывать)
- Test: `apps/api/src/{auth,users,projects}/*.spec.ts` — точечно на изменённых throw-сайтах;
  `packages/shared/src/schemas/api-errors.spec.ts` — новые коды в существующих инвариантных тестах
  («у каждого кода есть message-дескриптор», «fallback EN совпадает с en/messages.po»)

**Interfaces:**

- Consumes: `apiError<C>(code, status, ...params)` из `apps/api/src/common/api-error.ts` (не меняется
  этим task — сигнатура уже generic по `ParamsFor<C>`), `createI18n(locale)` из `@crm/shared`
- Produces: расширенный `API_ERROR_CODES` — коды этой волны видны Task 6/7 (не пересекаются по имени)
  и `apps/web`'s `getApiErrorMessage`/`translateApiError` (не трогаются этим task — уже читают весь
  реестр по конструкции, ничего добавлять на клиенте не нужно)

- [ ] **Step 1: Зафиксировать паттерн — один throw-сайт полностью, тестом вперёд**

Рабочий пример — `employee-contracts.service.ts:163/202` (`markReady`), оба ещё raw
`ConflictException` с английским текстом (COPY-H-api-2), файл уже частично мигрирован (2 других
кода — не трогать их).

```ts
// packages/shared/src/schemas/api-errors.ts — добавить в API_ERROR_CODES:
'CONTRACT_NOT_DRAFT',
// API_ERROR_PARAMS:
CONTRACT_NOT_DRAFT: [],
// API_ERROR_MESSAGES:
CONTRACT_NOT_DRAFT: /* i18n */ {
  id: 'api-error.CONTRACT_NOT_DRAFT',
  message: 'Контракт більше не в статусі чернетки — оновіть сторінку',
},
// API_ERROR_FALLBACK_EN:
CONTRACT_NOT_DRAFT: 'This contract is no longer a draft — refresh the page',
```

```ts
// packages/shared/src/schemas/api-errors.spec.ts — новый кейс (падает первым)
it('CONTRACT_NOT_DRAFT has a message descriptor and an EN fallback', () => {
  expect(API_ERROR_MESSAGES.CONTRACT_NOT_DRAFT.message).toBeTruthy()
  expect(API_ERROR_FALLBACK_EN.CONTRACT_NOT_DRAFT).toBeTruthy()
})
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm i18n:compile && pnpm --filter @crm/shared test -- src/schemas/api-errors.spec.ts`
Expected: FAIL — `CONTRACT_NOT_DRAFT` не существует в `API_ERROR_CODES`.

- [ ] **Step 3: Добавить код (блок выше), прогнать тест**

Run: та же команда → PASS.

- [ ] **Step 4: Заменить оба throw-сайта в `employee-contracts.service.ts`**

```ts
// было (строка 162-164):
throw new ConflictException(`Cannot mark ready: contract is ${contract.status}, expected DRAFT`)
// стало:
throw apiError('CONTRACT_NOT_DRAFT', HttpStatus.CONFLICT)

// было (строка 201-203):
throw new ConflictException('Cannot mark ready: contract is no longer DRAFT (concurrent update)')
// стало — тот же код: обе ветки сообщают пользователю ОДНО И ТО ЖЕ («контракт больше не
// черновик»), различие «почему» (гонка vs обычный повторный вызов) — детализация для
// разработчика, не для пользователя, остаётся в комментарии кода, не едет в ответ:
throw apiError('CONTRACT_NOT_DRAFT', HttpStatus.CONFLICT)
```

Добавить импорт `apiError` и `HttpStatus` из `@nestjs/common`, если ещё не импортированы в файле
(файл уже импортирует `apiError` для двух других кодов — проверить перед добавлением).

- [ ] **Step 5: Тест на сервис (падает → проходит)**

```ts
// employee-contracts.service.spec.ts — расширить существующий кейс 409
it('markReady rejects a non-DRAFT contract with CONTRACT_NOT_DRAFT', async () => {
  await expect(service.markReady(userId, viewer)).rejects.toMatchObject({
    response: { code: 'CONTRACT_NOT_DRAFT' },
  })
})
```

Run: `pnpm --filter @crm/api test -- src/contracts/employee-contracts.service.spec.ts` → PASS.

- [ ] **Step 6: Применить тот же паттерн к остальным throw-сайтам волны**

Точный список — командой перед началом работы (числа выше сняты сегодня, могут на 1-2 сдвинуться,
если между этим планом и стартом задачи что-то смёржилось — пересчитать, не доверять таблице):

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/auth apps/api/src/users apps/api/src/projects \
  | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/auth apps/api/src/users apps/api/src/projects \
  | grep -v '\.spec\.ts' | grep -vP "[А-Яа-яЁё]" | grep -E "\(('|\`)[A-Za-z]"
```

Каждое сообщение → один код (или переиспользуется существующий, если текст семантически совпадает —
свести дубли ДО регистрации нового кода, не заводить два кода на один смысл, аудит §696 п.5). Правило
для «сообщение = сырой enum» (COPY-H-api-3, здесь не встречается — это волна `contracts`, Task 3) и
«RBAC-матрица в тексте» (COPY-H-api-6, `finance/balance.service.ts` — Task 2) сюда не относится.

**Отдельная фикс-находка этой волны (не откладывать в Task 3 — файл её же волны):**
`users.service.ts` содержит роль в тексте нескольких сообщений сырым enum'ом — те же 4 throw-сайта,
где встречается `${role}` внутри русской фразы, переносить с `{role, select, ADMIN {адміністратор}
SENIOR {синьйор} JUNIOR {джуніор} HR {HR} ACCOUNTANT {бухгалтер} DROP {дроп} other {співробітник}}`
внутри `message`, а не подставлять сырой enum параметром (проверено через context7: `select`
ICU-формат — штатный, `{value, select, ...}`, без макроса пишется прямо строкой в `message`).

- [ ] **Step 7: Коммит**

```bash
git add packages/shared/src/schemas/api-errors.ts packages/shared/src/schemas/api-errors.spec.ts \
  apps/api/src/auth apps/api/src/users apps/api/src/projects
git commit -m "feat(api,shared): route auth/users/projects exceptions through api-error codes

ac_verified: 1"
```

---

### Task 2: Коды ошибок — `finance`/`invoices` (крупнейшая концентрация)

**Files:**

- Modify: `packages/shared/src/schemas/api-errors.ts`
- Modify: `apps/api/src/finance/transactions.service.ts` (60 кириллица + 60 англ.),
  `apps/api/src/finance/balance.service.ts`, `apps/api/src/finance/company-account.service.ts`,
  `apps/api/src/finance/pending-settlement.service.ts`, `apps/api/src/invoices/invoices.service.ts`
  (16 кириллица; уже 1 `apiError()` — не трогать)
- Test: `*.spec.ts` изменённых сервисов

**Interfaces:**

- Consumes: то же, что Task 1
- Produces: коды этой волны не пересекаются с Task 1/3 по имени (namespace `api-error.FINANCE_*`,
  `api-error.INVOICE_*` — конвенция, не enforced типами, но обязательна для читаемости реестра)

- [ ] **Step 1: Рабочий пример — COPY-H-api-4 (внутренний разбор в 400-й), тестом вперёд**

`finance/transactions.service.ts`, ветка `derivativePlan.needsReconfirm` (guard расхождения `amount`/
`settled_amount`) сегодня печатает пятистрочный разбор со ссылкой на PR `#598` пользователю. Найти
точный текст:

```bash
git grep -n "needsReconfirm" origin/main -- apps/api/src/finance/transactions.service.ts
```

Паттерн переноса: пользовательский код без деталей + **лог** с полным разбором (аудит: «Разбор — в лог»).

```ts
// packages/shared/src/schemas/api-errors.ts
FINANCE_ROW_AMOUNT_MISMATCH: /* i18n */ {
  id: 'api-error.FINANCE_ROW_AMOUNT_MISMATCH',
  message: 'Сума рядка і фактичні виплати розходяться — правка недоступна. Повідомте номер рядка адміністратору',
},
```

```ts
// transactions.service.ts — было: throw new BadRequestException(`пятистрочный разбор...`)
this.logger.warn(
  `Row ${row.id} needsReconfirm: amount=${row.amount} settled=${row.settledAmount} — see PR #598`,
)
throw apiError('FINANCE_ROW_AMOUNT_MISMATCH', HttpStatus.BAD_REQUEST)
```

- [ ] **Step 2-5: тест падает → код добавлен → throw заменён → тест проходит** (тот же цикл, что
      Task 1 Step 2-5; конкретный ассерт — `rejects.toMatchObject({ response: { code:
'FINANCE_ROW_AMOUNT_MISMATCH' } })`, плюс `expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('needsReconfirm'))`
      — разбор не потерян, просто переехал в лог)

- [ ] **Step 6: COPY-H-api-6 — RBAC-матрица в тексте (`balance.service.ts`)**

```bash
git grep -n "Доступ к pending obligations\|assert.*Access" origin/main -- apps/api/src/finance/balance.service.ts
```

Паттерн: убрать перечисление ролей из сообщения, оставить действие.

```ts
FINANCE_PENDING_OBLIGATIONS_FORBIDDEN: /* i18n */ {
  id: 'api-error.FINANCE_PENDING_OBLIGATIONS_FORBIDDEN',
  message: 'Цей розділ доступний бухгалтеру та адміністратору',
},
```

- [ ] **Step 7: COPY-H-api-7 — «IOU/obligation» в леджере (`pending-settlement.service.ts`, поле `notes`)**

Это не throw, а текст, пишущийся в БД (`transactions.notes`) — **вне периметра кодов ошибок**
(коды — только HTTP-ответы). Фикс здесь — терминологический, попутный: заменить
`` `Выплата drop IOU (obligation ${id})` `` на `` `Закриття зобов'язання дропа (${id})` `` прямым
литералом на `uk` (не через реестр — леджер читает бухгалтер, не конечный пользователь UI; текст в
`notes` не локализуется по получателю, это внутренняя бухгалтерская запись, решение отдельно от
реестра ошибок). Зафиксировать как единственное разумное расхождение с «всё через каталог» — записать
причину в PR body, не молчать.

- [ ] **Step 8: Применить тот же паттерн (коды ошибок) к остальным throw-сайтам волны**

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/finance apps/api/src/invoices \
  | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/finance apps/api/src/invoices \
  | grep -v '\.spec\.ts' | grep -vP "[А-Яа-яЁё]" | grep -E "\(('|\`)[A-Za-z]"
```

COPY-M-api-13 (абзац про курс в `pending-settlement.service.ts`) и COPY-M-api-8 (род «подписал» в
`invoices.service.ts` — «Инвойс подписан: {counterpartyName}» без рода) — тот же цикл, тексты
переписываются в исправленной формулировке ДО регистрации кода (аудит §696 п.3).

- [ ] **Step 9: Integration-спека — где throw идёт из ветки с реальным Drizzle-запросом**

Мутационный гейт не видит `*.integration.spec.ts` (`mutation-gate-integration-specs.md`) — на каждый
код этой волны, чей throw достижим только после реального запроса к БД (guard'ы на `amount`/
`settled_amount`, RLS-зависимые ветки `balance.service.ts`), unit-дубль с замоканным репозиторием
обязателен ДОПОЛНИТЕЛЬНО к integration-спеке, не вместо неё.

- [ ] **Step 10: Коммит**

```bash
git add packages/shared/src/schemas/api-errors.ts apps/api/src/finance apps/api/src/invoices
git commit -m "feat(api,shared): route finance/invoices exceptions through api-error codes

ac_verified: 1"
```

---

### Task 3: Коды ошибок — `documents`/`contracts`/`teams`/`legends`/`approvals`/`interviews`/`notifications`

**Files:**

- Modify: `packages/shared/src/schemas/api-errors.ts`
- Modify: `apps/api/src/documents/documents.service.ts` (18 кириллица + 4 англ.),
  `apps/api/src/contracts/{contract-templates,signed-contracts}.service.ts` (частично мигрирован —
  `signed-contracts.service.ts` уже 1 `apiError()`), `apps/api/src/teams/teams.service.ts` (18+19),
  `apps/api/src/legends/*.ts` (6), `apps/api/src/approvals/approvals.service.ts` (3),
  `apps/api/src/interviews/*.ts` (2+11 англ.), `apps/api/src/notifications/notifications.service.ts`
  (4 — только **логи**, не throw, см. Step 4)
- Test: соответствующие `*.spec.ts`

**Interfaces:**

- Consumes/Produces: как Task 1/2

**Область НЕ включает** (проверить по контроллеру перед началом — публичные лендинг-эндпоинты читает
`apps/landing`'s `errorKindForStatus` по статусу, не по тексту, COPY-M-api-14):
`apps/api/src/{vacancies,job-sourcing,resumes,contact}/**`, если throw-сайт достижим ТОЛЬКО с
публичного (не-CRM, без `@Roles`) маршрута. Если тот же сервис несёт и CRM-facing метод (админ
просматривает заявку) — мигрировать только CRM-facing throw-сайты, публичные — оставить статус-код без
текста-кода (уже работает по спеке — «Сервер отдаёт код [статус], лендинг — свой текст. Это и есть
целевая схема»).

- [ ] **Step 1: Рабочий пример — COPY-H-api-3 (сообщение = идентификатор)**

```bash
git grep -n "CONTRACT_NOT_EDITABLE\|DUPLICATE_ACTIVE_TEMPLATE\|ADMIN_DOES_NOT_HAVE_CONTRACT_TEMPLATE" \
  origin/main -- apps/api/src/contracts
```

11 мест, из них два уже ловит клиент по `.includes()` (`SignContractStep.tsx` — коды, оставить как
строки исключения ИЛИ дать им реальный `apiError`-код и переключить клиент на `getApiErrorCode`, что и
так входит в общую задачу отказа от `.includes()` на прозе — если клиент уже матчит по этим двум
константам как по кодам, регистрировать их под ТЕМИ ЖЕ именами избыточно: перенести 1:1 в
`API_ERROR_CODES` как коды с этими именами, `.includes()` на клиенте заменить на `getApiErrorCode(err)
=== 'CONTRACT_NOT_EDITABLE'`), девять остальных — новые тексты по правилу «объект + следующий шаг».

- [ ] **Step 2: Рабочий пример — COPY-M-api-11 (сырые enum в тексте, `documents.service.ts:993/1012/1019`)**

```ts
DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN: /* i18n */ {
  id: 'api-error.DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN',
  message:
    '{role, select, JUNIOR {Джуніор} HR {HR} ACCOUNTANT {Бухгалтер} SENIOR {Синьйор} DROP {Дроп} other {Співробітник}} ' +
    'не може завантажувати {category, select, CONTRACT {договори} RECEIPT {чеки} LOGO {логотипи} other {документи}}',
},
```

```ts
// packages/shared/src/schemas/api-errors.ts — API_ERROR_PARAMS
DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN: ['role', 'category'],
```

```ts
// documents.service.ts:993 — было:
throw new ForbiddenException(`Роль ${role} не может загружать ${category}`)
// стало:
throw apiError('DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN', HttpStatus.FORBIDDEN, { role, category })
```

`role`/`category` — enum-значения, не PII: проходят через `ParamsFor<C>`-пин без исключений.
`.../1012` и `.../1019` (частные случаи «чеки»/«логотипы») сводятся в тот же код тем же `select`
(дубль устранён — было три похожих сообщения, стал один код).

- [ ] **Step 3-4: тест падает → код добавлен → throw заменён → тест проходит**, плюс unit-тест на
      каждую ветку `select` (минимум `JUNIOR`+`CONTRACT`, `other`+`other` — mutation-gate поймает
      непокрытую ветвь `select`, как ловит непокрытый тернар, см. `mutation-gate-integration-specs.md`):

```ts
it('renders role and category labels for every combination the guard can hit', () => {
  const i18n = createI18n('uk')
  expect(
    i18n._(
      API_ERROR_MESSAGES.DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN.id,
      { role: 'JUNIOR', category: 'CONTRACT' },
      {
        message: API_ERROR_MESSAGES.DOCUMENT_UPLOAD_CATEGORY_FORBIDDEN.message,
      },
    ),
  ).toBe('Джуніор не може завантажувати договори')
})
```

- [ ] **Step 5: `notifications.service.ts` — 4 лога, НЕ throw (COPY-L-api-18)**

Это правило проекта («логи — английские»), не миграция на каталог. Перевести дословно на английский
при первом касании файла (уже входит в зону этой волны — файл в списке):

```
'Уведомление пропущено (событие не откатываем): …' → 'Notification skipped (event not rolled back): …'
'Путь производителя уведомлений упал (событие не откатываем): …' → 'Notification producer path failed (event not rolled back): …'
'Обработчик отказа уведомлений сам упал (наблюдение потеряно, …): …' → 'Notification failure handler itself failed (observability lost, …): …'
'Телеметрия не приняла отказ уведомления: …' → 'Telemetry did not accept the notification failure: …'
```

- [ ] **Step 6: Применить паттерн кодов ошибок к остальным throw-сайтам волны**

```bash
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/documents apps/api/src/contracts \
  apps/api/src/teams apps/api/src/legends apps/api/src/approvals apps/api/src/interviews \
  | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"
git grep -nE "throw new [A-Za-z]*Exception\(" origin/main -- apps/api/src/documents apps/api/src/contracts \
  apps/api/src/teams apps/api/src/legends apps/api/src/approvals apps/api/src/interviews \
  | grep -v '\.spec\.ts' | grep -vP "[А-Яа-яЁё]" | grep -E "\(('|\`)[A-Za-z]"
```

COPY-L-api-17 (17 однотипных «{объект} не найден» по разным модулям) — свести к **одному коду с
параметром объекта**: `NOT_FOUND: { message: '{object, select, PROJECT {Проєкт} DOCUMENT {Документ}
USER {Користувача} RECORD {Запис} other {Об'єкт}} не знайдено' }`, а не заводить 17 отдельных кодов —
экономит реестр и закрывает находку «разная конкретность для одного класса» разом.

- [ ] **Step 7: Коммит**

```bash
git add packages/shared/src/schemas/api-errors.ts apps/api/src/documents apps/api/src/contracts \
  apps/api/src/teams apps/api/src/legends apps/api/src/approvals apps/api/src/interviews \
  apps/api/src/notifications/notifications.service.ts
git commit -m "feat(api,shared): route documents/contracts/teams/legends/approvals/interviews exceptions through api-error codes

ac_verified: 1"
```

---

## Track B — Zod-сообщения shared

### Task 4: Механизм + волна B1 (`money.ts`/`finance.ts`/`users.ts`/`payment-requisites.ts`)

**Выбор механизма (спека §4.3 уже решает «коды через тот же реестр» — здесь фиксируется КАК):**

Zod v4 позволяет только `message: string` на валидаторе — нет отдельного поля «код». Вариант
`z.setErrorMap` — глобальная карта по `issue.code`/`issue.path`, не по бизнес-смыслу (не различает
«email некорректен» от «email обязателен» без ручного разбора issue) — отклонён: реестр по коду
читается там же, где уже стоит `getApiErrorMessage`, добавлять второй механизм разбора issue рядом
избыточно. **Выбор: `message` в схеме — стабильная строка-ключ вида `'zod.<CODE>'`, не текст.**
Она едет как есть в `issue.message` (Zod это не отличает от обычного текста), а перевод в текст —
на выходе, в двух местах: `ZodExceptionFilter` (сервер, конверт 400-го ответа) и клиентский
рендер ошибки поля.

**Files:**

- Create: `packages/shared/src/schemas/zod-errors.ts` — `ZodErrorCode`, `ZOD_ERROR_MESSAGES: Record<Code, MessageDescriptor>`
- Create: `packages/shared/src/schemas/zod-errors.spec.ts`
- Modify: `apps/api/src/zod-exception.filter.ts` — issues отдают `{ path, code, params? }` вместо `{ path, message }`
- Modify: `packages/shared/src/schemas/money.ts`, `finance.ts`, `users.ts`, `payment-requisites.ts`
- Test: `apps/api/src/zod-exception.filter.spec.ts` (новый или расширить существующий — проверить,
  есть ли), `packages/shared/src/schemas/{money,finance,users,payment-requisites}.spec.ts`

**Interfaces:**

- Produces: `ZOD_ERROR_MESSAGES: Record<ZodErrorCode, MessageDescriptor>` — читает Task 5 (расширяет
  тот же `Record`) и (в отдельной, вне-периметра-этого-плана задаче apps/web) форма, показывающая
  ошибку поля
- Consumes: `createI18n`, `MessageDescriptor` — как Track A

- [ ] **Step 1: Реестр — тест вперёд, на самом массовом дубле (`bankUahRnokpp`, 3 места)**

```bash
git grep -n "РНОКПП должен быть 10 цифр\|РНОКПП обязателен" origin/main -- packages/shared/src/schemas
```

```ts
// packages/shared/src/schemas/zod-errors.spec.ts
import { createI18n } from '../i18n/catalog'
import { ZOD_ERROR_MESSAGES } from './zod-errors'

describe('ZOD_ERROR_MESSAGES', () => {
  it('RNOKPP_FORMAT has a uk message descriptor', () => {
    const i18n = createI18n('uk')
    expect(
      i18n._(ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.id, undefined, {
        message: ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.message,
      }),
    ).toBe('РНОКПП має містити 10 цифр')
  })
})
```

- [ ] **Step 2: Убедиться, что падает** — `pnpm i18n:compile && pnpm --filter @crm/shared test -- src/schemas/zod-errors.spec.ts` → FAIL (файла нет).

- [ ] **Step 3: Создать реестр**

```ts
// packages/shared/src/schemas/zod-errors.ts
import type { MessageDescriptor } from '@lingui/core'

export const ZOD_ERROR_CODES = ['RNOKPP_FORMAT', 'RNOKPP_REQUIRED', 'TX_HASH_MIN_LENGTH'] as const
export type ZodErrorCode = (typeof ZOD_ERROR_CODES)[number]

export const ZOD_ERROR_MESSAGES: Record<ZodErrorCode, MessageDescriptor> = {
  RNOKPP_FORMAT: /* i18n */ {
    id: 'zod-error.RNOKPP_FORMAT',
    message: 'РНОКПП має містити 10 цифр',
  },
  RNOKPP_REQUIRED: /* i18n */ {
    id: 'zod-error.RNOKPP_REQUIRED',
    message: "РНОКПП обов'язковий",
  },
  TX_HASH_MIN_LENGTH: /* i18n */ {
    id: 'zod-error.TX_HASH_MIN_LENGTH',
    message: 'txHash має містити щонайменше 10 символів',
  },
}
```

- [ ] **Step 4: Прогнать тест → PASS**, затем заменить оба литерала-дубля кодом-ключом:

```ts
// packages/shared/src/schemas/payment-requisites.ts:17 — было:
bankUahRnokpp: z.string().regex(/^\d{10}$/, 'РНОКПП должен быть 10 цифр'),
// стало:
bankUahRnokpp: z.string().regex(/^\d{10}$/, 'zod.RNOKPP_FORMAT'),

// packages/shared/src/schemas/users.ts:159 — тот же дубль, тот же код:
const bankUahRnokppField = z.string().regex(/^\d{10}$/, 'zod.RNOKPP_FORMAT')
// users.ts:196 — было:
ctx.addIssue({ code: 'custom', message: 'РНОКПП обязателен', path: ['bankUahRnokpp'] })
// стало:
ctx.addIssue({ code: 'custom', message: 'zod.RNOKPP_REQUIRED', path: ['bankUahRnokpp'] })
```

Ключ `'zod.<CODE>'` — с префиксом `zod.`, чтобы `ZodExceptionFilter` отличал переведённые схемы этого
этапа от ещё не мигрированных (у которых `issue.message` — по-прежнему свободный текст, см. Step 6).

- [ ] **Step 5: `finance.ts:1181/1476` — тот же `txHash` дубль**, тем же кодом `TX_HASH_MIN_LENGTH`.

- [ ] **Step 6: `ZodExceptionFilter` — issues отдают код, если он есть, иначе прежний текст (переходный период)**

```ts
// apps/api/src/zod-exception.filter.ts — было:
errors: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
// стало:
errors: exception.issues.map((i) => {
  const isMigrated = i.message.startsWith('zod.')
  return {
    path: i.path.join('.'),
    ...(isMigrated ? { code: i.message.slice('zod.'.length) } : { message: i.message }),
  }
}),
```

Немигрированная схема продолжает отдавать `message` как раньше — ничего не ломает соседние 25 файлов
до их собственного PR (Task 5). `isFinanceCritical && !isAdmin` ветка (COPY-H-api-1, `'Invalid request
body'`) — заменить на `apiError('VALIDATION_FAILED', HttpStatus.BAD_REQUEST)` из Track A реестра
(добавить код `VALIDATION_FAILED` в Task 1, если ещё не заведён — этот PR читает Task 1 результат,
значит физически после него).

- [ ] **Step 7: Тест на фильтр**

```ts
it('returns a code for a migrated schema message, text for a non-migrated one', () => {
  const migrated = new ZodError([
    { code: 'custom', path: ['bankUahRnokpp'], message: 'zod.RNOKPP_FORMAT' },
  ])
  const legacy = new ZodError([{ code: 'custom', path: ['email'], message: 'Некорректный email' }])
  // ... вызов filter.catch на обоих, проверка errors[0] содержит code / message соответственно
})
```

- [ ] **Step 8: Применить тот же перенос к остальным сообщениям волны B1**

```bash
git grep -cP "message:.*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{money,finance,users,payment-requisites}.ts
git grep -cP "\.(min|max|email|regex|refine|length)\([^)]*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{money,finance,users,payment-requisites}.ts
```

Свести известные дубли ДО регистрации (COPY-L-shared из аудита, п. «22 различных строки»): «Некорректный
email» (5× в `users.ts`), «Причина отказа обязательна»/«слишком длинная» (в `approvals.ts`,
`pending-share.ts`, `projects.ts` — те **вне** volны B1, оставить их Task 5, но код в реестре завести
уже здесь, если первое появление — в этой волне, чтобы Task 5 не заводил дубль кода).
`transactionAmountError`/`moneyFloorAndPrecisionError` (`money.ts`↔`finance.ts`, COPY-M-shared-10) —
одна функция, а не две почти одинаковых: свести к вызову из `money.ts` в `finance.ts` (удаляет
`finance.ts:514/519/520`, `finance.ts` начинает звать `moneyFloorAndPrecisionError` из `./money`
напрямую вместо своей копии) — попутный рефакторинг, не расширяет периметр (тот же файл, тот же PR).
`AMOUNT_DECIMAL_PLACES`/`COMPANY_REQUISITES_MAX` (числа в сообщении) — `plural` ICU:
`{n, plural, one {# знак} few {# знаки} many {# знаків} other {# знаку}}` для `uk`,
`{n, plural, one {# digit} other {# digits}}` для `en` (синтаксис подтверждён context7:
`{numBooks, plural, one {# book} other {# books}}`).

- [ ] **Step 9: Коммит**

```bash
git add packages/shared/src/schemas/zod-errors.ts packages/shared/src/schemas/zod-errors.spec.ts \
  packages/shared/src/schemas/money.ts packages/shared/src/schemas/finance.ts \
  packages/shared/src/schemas/users.ts packages/shared/src/schemas/payment-requisites.ts \
  apps/api/src/zod-exception.filter.ts
git commit -m "feat(api,shared): zod validation messages become stable codes (money/finance/users/payment-requisites)

ac_verified: 1"
```

---

### Task 5: Zod-сообщения — волна B2 (остальные 13 файлов)

**Files:**

- Modify: `packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,
notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,
tos,admin-actions}.ts`
- Modify: `packages/shared/src/schemas/zod-errors.ts` — расширение реестра (тот же файл, что Task 4
  создал — конфликт мержа маловероятен: Task 4 трогает money/finance/users/payment-requisites,
  Task 5 — остальные 13; оба добавляют записи в один `Record`, порядок PR — Task 4 сначала, Task 5
  ребейзится на него)

**Interfaces:**

- Consumes: `ZOD_ERROR_MESSAGES`, паттерн Task 4 Step 1-7 (тот же цикл: код в реестр → `'zod.<CODE>'`
  вместо текста в схеме → тест на резолв через `createI18n`)

- [ ] **Step 1: Рабочий пример — COPY-H-shared-1 (`CONTRACT_VARIABLE_DESCRIPTIONS`, 5 украинских
      подписей внутри русской карты)**

```bash
git grep -n "Адреса реєстрації\|human-readable Russian" origin/main -- packages/shared/src/schemas/contracts.ts
```

Это не Zod-сообщение, а `Record<string, string>` — тот же принцип (карта верхнего уровня, вычисляется
при импорте), но структурно ближе к Task 6 (`NOTIFICATION_TITLES`). Переносится здесь, потому что файл
`contracts.ts` уже в периметре этой волны (другие Zod-сообщения того же файла), а не отдельным PR ради
24 строк: `CONTRACT_VARIABLE_DESCRIPTIONS: Record<string, MessageDescriptor>`, пять уже украинских
записей просто переносятся как есть (текст уже верный), 19 остальных переводятся при переносе.
Комментарий «human-readable Russian descriptions» над картой удаляется — он был неточен уже до этой
задачи, аудит это подтвердил.

- [ ] **Step 2: COPY-M-shared-8 — три словаря ролей (`ROLE_LABELS`/`role: '...'`/сырой `ADMIN`)**

Канон ролей на клиенте уже существует (`role-select.tsx`'s `ROLE_LABEL_MESSAGES`/`useRoleLabel`,
stage 3a). Здесь — `contracts.ts`'s `role: 'Роль (HR / Синьор / Джун / Дроп / Бухгалтер)'` (ADMIN
пропущен) переписывается как полный список без роли-как-текста в самой строке: либо ссылкой на канон
(если `contracts.ts` может импортировать из `apps/web` — **не может**, разные пакеты; значит здесь —
собственный `Record<Role, MessageDescriptor>` с ТЕМИ ЖЕ шестью подписями, что канон, сверить вручную
командой `git grep -n "ROLE_LABEL_MESSAGES" origin/main -- apps/web/app/components/ui/role-select.tsx`
перед написанием, чтобы не разойтись текстом).

- [ ] **Step 3: Применить паттерн Task 4 к остальным 13 файлам волны**

```bash
git grep -cP "message:.*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,tos,admin-actions}.ts
git grep -cP "\.(min|max|email|regex|refine|length)\([^)]*[А-Яа-яЁё]" origin/main -- packages/shared/src/schemas/{approvals,pending-share,projects,credentials,legends,notification-preferences,notifications,documents,resume,employee-contracts,contracts,teams,tos,admin-actions}.ts
```

Известные дубли для свода в один код на этой волне: «Причина отказа обязательна» /
«Причина отказа слишком длинная (максимум 500 символов)» — `approvals.ts`, `pending-share.ts`,
`projects.ts` (3 файла этой волны — один код `REJECTION_REASON_REQUIRED`/`REJECTION_REASON_TOO_LONG`
на все три). `legends.ts`'s `'ФИО обязательно'` vs `legendEntrySchema.fullName`'s `'Имя обязательно'`
(COPY-L-shared-17) — свести к одной подписи поля перед регистрацией кода. `'Неизвестный тип
уведомления'` (COPY-M-shared-14, `notification-preferences.ts`) — по аудиту это не пользовательская
ошибка (интерфейс сам прислал невалидный тип): код заводится, но текст — «Налаштування застаріли,
оновіть сторінку», а не буквальный перевод.

Также 13 English `message:` (COPY-H-shared-3) в этой волне и Task 4 — те, что человек может
исправить, переводятся и получают код как остальные; те, что диагностика контракта API (пример:
``'`locked` must be derived from the type, not sent independently'`` — это не может исправить
пользователь никаким действием в форме) — не регистрируются в каталоге вообще, остаются английским
текстом ТОЛЬКО для лога/разработчика: `ZodExceptionFilter`'s Step 6 ветка `isMigrated` для них
остаётся `false` (нет префикса `zod.`), и это осознанное решение, не пропуск — записать в PR body
список таких сообщений с обоснованием «не пользовательская ошибка».

- [ ] **Step 4: `notifications.ts`'s `safeNotificationLinkSchema` — English message**, аналогично: если
      достижимо только внутренним рассинхроном данных (не вводом пользователя) — не переводить, лог-only.

- [ ] **Step 5: Тесты — по одному на каждый новый код** (шаблон Task 4 Step 1/7), плюс regression-тест
      на дубли: `git grep` в CI-скрипте не заводить (вне периметра — это Coder-проверка перед PR, не
      постоянный гейт), но команда прогоняется перед коммитом:

```bash
git grep -h "message: 'zod\." packages/shared/src/schemas -- '*.ts' | grep -v spec | sort | uniq -c | sort -rn | head
```

Повторяющийся код на разные литералы (до переноса) — сигнал, что дубль не свели; ноль строк с
count > 1, где смысл РАЗНЫЙ, — сигнал готовности.

- [ ] **Step 6: Коммит**

```bash
git add packages/shared/src/schemas/zod-errors.ts packages/shared/src/schemas/approvals.ts \
  packages/shared/src/schemas/pending-share.ts packages/shared/src/schemas/projects.ts \
  packages/shared/src/schemas/credentials.ts packages/shared/src/schemas/legends.ts \
  packages/shared/src/schemas/notification-preferences.ts packages/shared/src/schemas/notifications.ts \
  packages/shared/src/schemas/documents.ts packages/shared/src/schemas/resume.ts \
  packages/shared/src/schemas/employee-contracts.ts packages/shared/src/schemas/contracts.ts \
  packages/shared/src/schemas/teams.ts packages/shared/src/schemas/tos.ts \
  packages/shared/src/schemas/admin-actions.ts
git commit -m "feat(shared): remaining zod validation messages become stable codes

ac_verified: 1"
```

---

## Track C — уведомления при показе

### Task 6: `notification-registry.ts` → `MessageDescriptor`, 3 замороженных типа, форматирование

**Files:**

- Modify: `packages/shared/src/schemas/notification-registry.ts` — `NOTIFICATION_TITLES`,
  `ACTION_LABELS`, `SUBJECT_MISSING_LABELS`, `SUBJECT_ARCHIVED_LABELS`,
  `APPROVAL_SUPERSEDED_LABEL`/`APPROVAL_DECIDED_LABEL`, `describeNotification`, `subjectPhrase`,
  `percentText`, `money()`, `quoteWithinBudget`, `NOTIFICATION_DETAIL_LINE_CHARS`
- Modify: `apps/api/src/invoices/invoices.service.ts:1311-1312` (`INVOICE_SIGNED` — зарегистрировать
  тип в реестре вместо raw `title`), `apps/api/src/invoices/invoices.service.ts:403/565`
  (`INVOICE_SIGN_REQUIRED`), `apps/api/src/vacancies/applications.service.ts:669` (`VACANCY_APPLICATION`)
- Modify: `packages/shared/src/schemas/notification-registry.spec.ts`
- Test: тот же файл + `apps/api/src/invoices/invoices.service.spec.ts`,
  `apps/api/src/vacancies/applications.service.spec.ts` (проверка, что запись больше не несёт `title`/`body`)

**Interfaces:**

- Consumes: `createI18n`, `formatMoney(amount, currency, locale)` из `packages/shared/src/i18n/format.ts`
  (уже существует, Task 6 меняет `money()`'s хардкод `toLocaleString('ru-RU')` на вызов этой функции)
- Produces: `renderNotification(n, locale)` — **новая сигнатура с параметром `locale`** (сейчас без
  него — Task 7 и `apps/web`'s вызывающий код должны передать локаль зрителя; для показа в интерфейсе
  это локаль текущего пользователя из `I18nProvider`, для письма — локаль получателя из
  `createI18n(recipientLocale)`)

- [ ] **Step 1: Рабочий пример — COPY-H-shared-5, регистрация `INVOICE_SIGNED` (падает тестом вперёд)**

```ts
// notification-registry.spec.ts
it('INVOICE_SIGNED renders from the registry, not from a frozen DB title', () => {
  const rendered = describeNotification('INVOICE_SIGNED', { counterpartyName: 'ТОВ Ромашка' }, 'uk')
  expect(rendered.title).toBe('Рахунок підписано')
  expect(rendered.title).not.toContain('ТОВ Ромашка') // §10: письмо/попап не называет людей/контрагентов по имени лишний раз — деталь по кнопке
})
```

- [ ] **Step 2: Убедиться, что падает** — `INVOICE_SIGNED` сегодня не в `NEW_NOTIFICATION_TYPES`.

- [ ] **Step 3: Добавить тип в реестр**

```ts
// NEW_NOTIFICATION_TYPES — добавить 'INVOICE_SIGNED', 'INVOICE_SIGN_REQUIRED', 'VACANCY_APPLICATION'
// NOTIFICATION_TITLES — добавить:
INVOICE_SIGNED: /* i18n */ { id: 'notification.INVOICE_SIGNED.title', message: 'Рахунок підписано' },
INVOICE_SIGN_REQUIRED: /* i18n */ { id: 'notification.INVOICE_SIGN_REQUIRED.title', message: 'Рахунок очікує підпису' },
VACANCY_APPLICATION: /* i18n */ { id: 'notification.VACANCY_APPLICATION.title', message: 'Новий відгук на вакансію' },
```

`NOTIFICATION_TITLES`'s тип сегодня `Record<NewNotificationType, string>` — меняется на
`Record<NewNotificationType, MessageDescriptor>`; каждый читающий сайт (`describeNotification`,
`notification-email-copy.ts`'s фолбэк-ветка) переходит на `i18n._(NOTIFICATION_TITLES[type].id, ...)`.

- [ ] **Step 4: Добавить `dataSchemaFor` для трёх типов** (у каждого нового `NewNotificationType`
      обязана быть схема данных в `dataSchemas` — `notificationDataSchemaFor` иначе бросит на
      неизвестном типе):

```ts
INVOICE_SIGNED: z.object({ counterpartyName: z.string() }),
INVOICE_SIGN_REQUIRED: z.object({ amount: moneyFields.amount, currency: moneyFields.currency }),
VACANCY_APPLICATION: z.object({ vacancyTitle: z.string() }),
```

- [ ] **Step 5: Заменить производителей на структурированный `data` вместо `title`/`body`**

```ts
// invoices.service.ts:1311-1312 — было:
type: 'INVOICE_SIGNED',
title: `${counterpartyRow.displayName} подписал инвойс`,
// стало:
type: 'INVOICE_SIGNED',
data: { counterpartyName: counterpartyRow.displayName },
```

Аналогично `INVOICE_SIGN_REQUIRED` (строки 403, 565 — убрать `title`/`body`, передать `data`) и
`VACANCY_APPLICATION` (`applications.service.ts:669`).

- [ ] **Step 6: Прогнать тест Step 1 → PASS**, плюс тест на старые записи в БД (обратная совместимость):

```ts
it('a legacy row with a frozen title still renders (fallback path stays)', () => {
  const rendered = renderNotification(
    { type: 'SOME_OLD_TYPE', title: 'старая строка', body: null /* ... */ },
    'uk',
  )
  expect(rendered.title).toBe('старая строка') // composeBody's fallback branch — не трогается этим task
})
```

- [ ] **Step 7: `money()` → `formatMoney`, локаль форматирования**

```ts
// notification-registry.ts — было:
function money(d: { amount: string; currency: string }): string {
  const num = Number(d.amount)
  return `${num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${d.currency}`
}
// стало:
import { formatMoney } from '../i18n/format'
function money(d: { amount: string; currency: string }, locale: Locale): string {
  return formatMoney(d.amount, d.currency as 'USDT' | 'USD' | 'EUR' | 'UAH', locale)
}
```

Все вызовы `money(d)` внутри файла получают второй аргумент `locale`, который сам приходит параметром
в `describeNotification`/`renderNotification` (Step 1 уже ввёл этот параметр).

- [ ] **Step 8: `subjectPhrase`/`percentText` — падежи, не текст-с-плейсхолдером**

```bash
git grep -n "function subjectPhrase\|function percentText" origin/main -- packages/shared/src/schemas/notification-registry.ts
```

`subjectPhrase()` (проект/доля по падежам) переписывается через `select`, не строковую склейку:

```ts
// было: `проект ${named}` / `доля по проекту ${named}` (родительный/предложный вручную)
// стало — ОДНО сообщение с параметром типа субъекта, падеж — часть перевода:
function subjectPhrase(
  kind: 'PROJECT' | 'PROJECT_SHARE' | 'BASE_SHARE',
  name: string | null,
): MessageDescriptor {
  return /* i18n */ {
    id: 'notification.subjectPhrase',
    message:
      '{kind, select, PROJECT {проєкт{name, select, null {} other { «{name}»}}} ' +
      'PROJECT_SHARE {доля за проєктом{name, select, null {} other { «{name}»}}} ' +
      'other {доля за замовчуванням}}',
  }
}
```

(Вложенный `select` на `name` — штатный ICU-паттерн «пусто или значение»; проверить в
`pnpm i18n:extract`, что `lingui` не спотыкается на вложенности — если спотыкается, два отдельных
сообщения `subjectPhraseNamed`/`subjectPhraseUnnamed` вместо вложенного `select`, записать в PR body,
какой вариант выбран и почему.)

`percentText(null) → 'не задана'` (женский род, согласован с «долей» в русском; в uk — «не задано»
средний род или собственная форма, в en рода нет) — не параметр, а часть той же `message`, `select` по
`null`/не-`null`.

- [ ] **Step 9: `NOTIFICATION_DETAIL_LINE_CHARS`/`quoteWithinBudget` — бюджет под самый длинный язык**

```bash
git grep -n "NOTIFICATION_DETAIL_LINE_CHARS\|quoteWithinBudget" origin/main -- packages/shared/src/schemas/notification-registry.ts
```

Бюджет (22 символа/строка, 2 строки) настроен под русский. Тест на самой длинной реалистичной
украинской строке (аудит: uk длиннее en на 15-30%) — если обрезка режет посреди слова при активной
локали `uk`, поднять `NOTIFICATION_DETAIL_LINE_CHARS` или адаптировать `quoteWithinBudget` под
параметр локали. Это UI-полировка (попап `w-80`) — **design-gate Tier 3** (правка существующего
компонента, conformance-проверка, не полная генерация) применяется отдельно к `apps/web`'s
рендер-компоненту, здесь — только сама функция бюджета в `shared`.

- [ ] **Step 10: Типографика кавычек** — `quoteWithinBudget`'s `«…»` жёстко для любой локали
      (COPY: «Типографика зашита в шаблоны»). Параметризовать: `uk` → `«…»`, `en` → `"…"`,
      выбор — по `locale`-параметру, который Step 1 уже ввёл во всю цепочку вызовов.

- [ ] **Step 11: Коммит**

```bash
git add packages/shared/src/schemas/notification-registry.ts packages/shared/src/schemas/notification-registry.spec.ts \
  apps/api/src/invoices/invoices.service.ts apps/api/src/invoices/invoices.service.spec.ts \
  apps/api/src/vacancies/applications.service.ts apps/api/src/vacancies/applications.service.spec.ts
git commit -m "feat(shared): render notification titles/details by locale, register 3 legacy DB-frozen types

ac_verified: 1"
```

---

## Track D — письма uk/en

### Task 7: `notification-email-copy.ts` и приглашение — локаль получателя

**Files:**

- Modify: `apps/api/src/notifications/notification-email-copy.ts` — все 10 `BODIES`, `acceptedLine`/
  `rejectedLine`/`projectPhrase`/`sharePhrase` (переписать целиком предложениями, не склейкой — аудит
  §696 п.4), `renderNotificationEmail` получает `locale` параметром
- Modify: `apps/api/src/notifications/notification-email-copy.spec.ts` — снапшот на `uk` и `en` вместо
  `startsWith('Запрос на')`/литеральных русских подстрок
- Modify: `apps/api/src/notifications/notification-email.cron.ts` — активировать локаль **получателя**
  (`users.locale`) перед вызовом `renderNotificationEmail`, не локаль крона/отправителя
- Modify: `apps/api/src/users/personal-email-invite-mailer.service.ts` — локаль приглашения (см.
  «Вопросы владельцу» A2 ниже — до ответа реализуется рекомендованный вариант)
- Test: те же файлы

**Interfaces:**

- Consumes: `NOTIFICATION_TITLES` (Task 6, для фолбэк-ветки `composeBody`), `createI18n(locale)`,
  `renderNotification(n, locale)` (Task 6 — email использует тот же `describeNotification`, где
  применимо, вместо параллельного текста)
- Produces: `renderNotificationEmail(source, opts, locale)` — новая сигнатура; вызывающий код
  (`notification-email.cron.ts`) обязан передать `locale`, иначе typecheck красный (сознательно —
  чтобы не забыть про одного из двух вызывающих)

- [ ] **Step 1: Рабочий пример — `TRANSACTION_ADDED`, тестом вперёд на двух локалях**

```ts
// notification-email-copy.spec.ts
it('TRANSACTION_ADDED renders the project name on both locales', () => {
  const uk = renderNotificationEmail(
    source('TRANSACTION_ADDED', { projectName: 'Мобільний банк' }),
    opts,
    'uk',
  )
  const en = renderNotificationEmail(
    source('TRANSACTION_ADDED', { projectName: 'Mobile Bank' }),
    opts,
    'en',
  )
  expect(uk.subject).toBe('Транзакція за проєктом «Мобільний банк»')
  expect(en.subject).toBe('Transaction on “Mobile Bank”')
  // §10 инвариант (уже в файле) — ни одной цифры/имени, кроме названия объекта:
  expect(uk.text).not.toMatch(/\d/)
})
```

- [ ] **Step 2-4: тест падает → дескриптор написан → `BODIES.TRANSACTION_ADDED` переведён на
      `i18n._()` → тест проходит**

```ts
// было:
TRANSACTION_ADDED: (d) => ({
  subject: d.projectName === null ? 'Вам добавили транзакцию' : `Транзакция по проекту «${d.projectName}»`,
  lines: ['В ваших финансах новая транзакция. Сумма и детали — в CRM.'],
}),
// стало:
TRANSACTION_ADDED: (d, i18n) => ({
  subject: i18n._(
    /* i18n */ { id: 'email.TRANSACTION_ADDED.subject', message: '{projectName, select, null {Вам додали транзакцію} other {Транзакція за проєктом «{projectName}»}}' },
    { projectName: d.projectName },
  ),
  lines: [i18n._(/* i18n */ { id: 'email.TRANSACTION_ADDED.body', message: 'У ваших фінансах нова транзакція. Сума та деталі — в CRM.' })],
}),
```

Каждая функция в `BODIES` получает второй аргумент `i18n: I18n` (экземпляр `createI18n(locale)`,
создаётся один раз в `renderNotificationEmail`, не в каждой функции — избегает 10 отдельных
`createI18n` вызовов на одно письмо).

- [ ] **Step 5: `acceptedLine`/`rejectedLine`/`projectPhrase`/`sharePhrase` — переписать целыми
      предложениями, не склейкой (аудит §696 п.4 — падежи иначе не собрать для `uk`)**

```ts
// было (фрагменты, родительный падеж вручную):
function acceptedLine(subjectKind: ApprovalSubjectKind, subjectTitle: string | null): string {
  return subjectKind === 'PROJECT'
    ? `Сотрудник согласился участвовать ${projectPhrase(subjectTitle)}.`
    : `Сотрудник согласился на смену ${sharePhrase(subjectKind, subjectTitle)}.`
}
// стало — три целых предложения (по subjectKind), не сборка из функций-фрагментов:
function acceptedLine(
  i18n: I18n,
  subjectKind: ApprovalSubjectKind,
  subjectTitle: string | null,
): string {
  return i18n._(
    /* i18n */ {
      id: 'email.acceptedLine',
      message:
        '{subjectKind, select, ' +
        'PROJECT {Співробітник погодився брати участь у {subjectTitle, select, null {проєкті} other {проєкті «{subjectTitle}»}}.} ' +
        'PROJECT_SHARE {Співробітник погодився на зміну частки за {subjectTitle, select, null {проєктом} other {проєктом «{subjectTitle}»}}.} ' +
        'other {Співробітник погодився на зміну частки за замовчуванням.}}',
    },
    { subjectKind, subjectTitle },
  )
}
```

`projectPhrase`/`sharePhrase` как отдельные функции — **удаляются** (не помечаются deprecated: у них
ровно два вызывающих места, `acceptedLine`/`rejectedLine`, оба переписаны этим шагом).
`rejectedLine` — тот же паттерн, отдельная функция (аудит §691's «две функции, не одна с параметром
решения» — MUTATION-GATE-подтверждённая причина, комментарий в файле уже объясняет; сохранить это
архитектурное решение, не сворачивать обратно в одну функцию с веткой).

- [ ] **Step 6: Применить паттерн Step 2-4 к остальным 8 писем**

Список — весь `BODIES` (10 функций: `TRANSACTION_ADDED` ✓ Step 4, `TRANSACTION_STATUS_CHANGED`,
`TEAM_MEMBER_ADDED`, `PROJECT_MEMBER_ADDED`, `TEAM_NEW_MEMBER`, `PROJECT_CONFIRM_REQUIRED`,
`SHARE_CONFIRM_REQUIRED`, `DOCUMENT_SIGN_REQUIRED`, `APPROVAL_CONFIRMED` ✓ Step 5,
`APPROVAL_REJECTED` ✓ Step 5). Снапшот-тест на каждый, на обеих локалях (спека §8: «снапшот темы и
тела на uk и en»).

- [ ] **Step 7: Типографика темы письма** (аналог Task 6 Step 10 — `«…»` для `uk`, `"…"` для `en`,
      уже встроено в Step 4/5 примерах через сам текст ICU-сообщения, отдельного параметра не нужно —
      кавычки пишутся прямо в `message` каждой локали каталога).

- [ ] **Step 8: `notification-email.cron.ts` — локаль получателя**

```bash
git grep -n "renderNotificationEmail" origin/main -- apps/api/src/notifications/notification-email.cron.ts
```

```ts
// было (предположительно, без locale — проверить точный вызов командой выше перед правкой):
const email = renderNotificationEmail(source, opts)
// стало:
const email = renderNotificationEmail(source, opts, recipientUser.locale)
```

Убедиться, что `recipientUser` (или эквивалент) уже несёт `locale` в выборке из БД этого крона —
`users.locale` добавлена в Task 3 стадии 2 (уже в `main`), но SELECT крона мог не включать колонку до
сих пор: проверить `select`/`with` в запросе, добавить поле, если отсутствует.

- [ ] **Step 9: Снапшот-тест писем на обеих локалях — весь файл**

```ts
// notification-email-copy.spec.ts — по образцу существующего DATA-объекта (10 типов), для каждого:
it.each(NEW_NOTIFICATION_TYPES)('%s renders on uk and en without literal Russian', (type) => {
  const uk = renderNotificationEmail(source(type, DATA[type]), opts, 'uk')
  const en = renderNotificationEmail(source(type, DATA[type]), opts, 'en')
  expect(uk.subject).not.toBe(en.subject)
  expect(uk.subject).toMatch(/[а-яіїєґ]/i) // содержит украинские буквы, не сорвался на фолбэк-код
  expect(en.subject).not.toMatch(/[а-яіїєґ]/i)
})
```

Существующие инвариантные проверки (`startsWith('Запрос на')` и т.п.) переписываются на проверку по
**структуре** (тип входит в `ACTION_REQUIRED_NOTIFICATION_TYPES` → subject начинается с префикса из
каталога для активной локали, не с литерала — `i18n._(PREFIX_ID)`, сверка результата с результатом, а
не с русской строкой, аудит §693: «проверять придётся идентификатор сообщения, а не отрендеренный
текст»).

- [ ] **Step 10: Коммит**

```bash
git add apps/api/src/notifications/notification-email-copy.ts apps/api/src/notifications/notification-email-copy.spec.ts \
  apps/api/src/notifications/notification-email.cron.ts
git commit -m "feat(api): render all 10 notification emails on recipient locale (uk/en), whole-sentence phrasing

ac_verified: 1"
```

---

## Что НЕ входит в этот план

- **`apps/web`** (кроме уже упомянутых точек интеграции — `getApiErrorMessage`/`translateApiError`,
  которые УЖЕ читают весь реестр по конструкции и не требуют правки при расширении кодов). Клиентский
  рендер ошибки Zod-поля по коду (`ZOD_ERROR_MESSAGES`) — отдельная задача этапа 3/следующей волны,
  здесь только серверный механизм и реестр.
- **`apps/api/src/contact/**`, публичные throw-сайты `vacancies`/`job-sourcing`/`resumes`** —
landing-facing, читает `apps/landing`'s `errorKindForStatus`по статус-коду, не по тексту (COPY-M-api-14,
уже целевая схема). CRM-facing throw-сайты тех же модулей (если контроллер несёт`@Roles`) —
  мигрировать по паттерну Track A, проверять по контроллеру перед стартом Task 3.
- **PDF счетов** (`invoice-pdf.service.ts`) и **договоры** (`contract-pdf.service.ts`,
  `contract-rendering.ts`) — этап 5 спеки, стартует после этого плана (общий каталог должен
  существовать). COPY-M-api-9/10 (расхождение языка документов) — находка для этапа 5, не сюда.
  `contract-rendering.ts`'s `COMPANY_REQUISITES_HEADING`/`'не указано'` (COPY-M-api-10) — тоже этап 5.
- **`resume-text-extraction.service.ts`/`resume-source.util.ts`** (COPY-M-api-12, сообщения парсера
  DOCX) — сообщения об ошибке не Zod и не `HttpException` с прямым throw в контроллер; отдельная
  находка, не входит ни в один Track этого плана; зафиксировать как пункт бэклога, если не подхвачена
  отдельной задачей до старта этапа 6.
- **`invoice-pdf.service.ts`'s блок «ЗАКАЗЧИК»** (COPY-L-api-15) — часть этапа 5 (PDF).
- **`pending/pending.service.ts`'s `proposedByName: 'Неизвестно'`** (COPY-L-api-16) — косметика
  DTO-сборки без прямого throw/Zod-сообщения; не Track A/B/C/D по построению (это не ошибка и не
  уведомление, а fallback-значение поля ответа) — пункт бэклога.
- **Signal-бот «+»** — вне границ спеки §5, не пересматривается.
- **Договоры** — только `uk` (решение владельца, спека §5), логика UA\|EN — отдельно, позже.

## Допущения (A1 — обратимо, ≤ одного PR, записано)

- Namespace-конвенция id (`api-error.*`, `zod-error.*`, `notification.*`, `email.*`) — не enforced
  типами, чисто договорная; откат = переименование id в одном PR, не влияет на рантайм (id — просто
  строка-ключ каталога).
- «Сообщение = сырой enum, но клиент уже матчит по нему» (`CONTRACT_NOT_EDITABLE` и подобные, Task 3
  Step 1) — регистрируются кодами под теми же именами вместо новых имён; откат = переименовать код,
  клиент обновляется тем же PR.
- `subjectPhrase`'s вложенный `select` (Task 6 Step 8) — если `lingui extract` не парсит вложенность,
  разворачивается в два плоских сообщения; выбор фиксируется в PR body, откат тривиален (правка одного
  файла).

## Вопросы владельцу (A2)

**1. Локаль письма-приглашения, когда адрес ещё не подтверждён.**
`personal-email-invite-mailer.service.ts` шлёт приглашение на email, для которого ещё нет строки
`users` с `locale` (пользователь только создаётся мастером — см. аудит §B «Тексты писем существуют в
двух копиях» и «Инфраструктуры локали на сервере нет»). На момент отправки локаль получателя неизвестна
системе никаким способом (нет cookie, нет `Accept-Language` — это не HTTP-запрос получателя, это
исходящее письмо).
➡️ **Рекомендую:** локаль создающего администратора (тот, кто в мастере вводит email и, скорее всего,
знает, на каком языке говорит новый сотрудник) — как явное поле выбора в форме мастера создания
пользователя (не implicit fallback), значение сразу пишется в `users.locale` новой записи. Если
администратор не указал — `uk` (дефолт спеки). Обратимо: поле формы, откат = убрать поле, оставить
жёсткий `uk`.
🔓 Обратимо · молчание → принимаю рекомендацию, записываю в «Допущения» Task 7, откат = один PR
(убрать поле выбора, оставить дефолт).

**2. Логи `notifications.service.ts` — перевести на английский при первом касании (Task 3 Step 5) —
подтвердить, что это не требует отдельного code review circle.**
➡️ **Рекомендую:** да, попутно — правило `russian-language.md` уже требует английские логи, это не
новое решение, а исполнение существующего.
🔓 Обратимо · молчание → делаю как рекомендовано.

## Проверка готовности этапа

- `git grep -nE "throw new [A-Za-z]*Exception\(" apps/api/src | grep -v '\.spec\.ts' | grep -P "[А-Яа-яЁё]"`
  — 0 строк (кроме явно задокументированных исключений «Что НЕ входит»).
- `git grep -cP "message:.*[А-Яа-яЁё]|\.(min|max|email|regex|refine|length)\([^)]*[А-Яа-яЁё]" packages/shared/src/schemas` — 0.
- `packages/shared/src/schemas/notification-registry.ts` — ни один `Record<..., string>` с видимым
  текстом; все три «замороженных» типа зарегистрированы (`NEW_NOTIFICATION_TYPES` включает
  `INVOICE_SIGNED`/`INVOICE_SIGN_REQUIRED`/`VACANCY_APPLICATION`).
- `notification-email-copy.spec.ts` — снапшот на `uk` и `en` для всех 10 типов, ни одного
  `startsWith`/`toContain` на русский литерал.
- `pnpm i18n:extract` идемпотентен (второй прогон не меняет `.po`), `copy-reviewer` — `PASS` на `uk` и
  `en` по каждому PR трека.
- `security-reviewer` — `APPROVE` на PR Task 1 (auth/users), Task 2 (finance/invoices).
- Оба A2-вопроса закрыты ответом владельца ИЛИ истёк срок молчания и применена рекомендация (записано
  в «Допущения»).
