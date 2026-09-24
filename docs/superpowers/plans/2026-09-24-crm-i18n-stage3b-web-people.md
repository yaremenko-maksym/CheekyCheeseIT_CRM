# CRM i18n — этап 3, волна (b) «web-people» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести на `uk`/`en` всё, что в CRM касается людей: онбординг, профиль (оболочка, вкладки, админ-действия, самоправка, контракт сотрудника), список пользователей и мастер создания, команды, архивацию пользователя и резюме сеньйора. Три PR, продуктовые файлы не пересекаются, в мигрированных файлах не остаётся русского текста, а оба легаси-словаря ролей (`ROLE_LABELS` в `role-select.tsx` и в `components/users/constants.ts`) удаляются, потому что после волны у них не остаётся потребителей.

**Architecture:** Тот же единственный каталог `packages/shared/src/i18n/locales/{uk,en}/messages.po` и те же шаблоны A–F, что в волне (a) (`docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md`, раздел «Шаблоны миграции»). Нового в этой волне три вещи. Первое — **переход потребителей со старых словарей на каноны**, которые уже лежат в `main`: роли через `ROLE_LABEL_MESSAGES`/`useRoleLabel` (3a PR1), ошибки сервера и тексты «войти как» через `API_ERROR_MESSAGES` (этап 4), Zod-сообщения через `translateZodCode`/`translateZodMessage` (этап 4). Второе — **один текст влияния архивации на пользователя** вместо двух: блок пользователя из `components/archive/ArchiveConfirmDialog.tsx` выносится в `components/archive/UserArchiveImpact.tsx`, и его рендерят оба диалога. Третье — **таблица канонических форм терминов волны (b)** (раздел ниже). PR1 и PR2 идут параллельно, поэтому оба берут слова из неё, а не придумывают каждый свои.

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`), уже настроен этапом 2. React 18, Vite 6, Vitest 4, TanStack Router, Tailwind v4, shadcn/ui, `eslint-plugin-lingui` 0.16.0 (`warn`), Playwright, Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §5 (гейты), §7 п.3 (волна b: «команда, пользователи, профиль, онбординг»), §8 (тесты). Аудит: `docs/architecture/2026-09-19-crm-i18n-audit.md`, срез `web-people` (30 находок, `Findings:` в конце среза) и сквозные темы §1–§2. Образец формата и шаблоны A–F: план волны (a) `docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md`.

**Замер:** все числа ниже сняты командами на `origin/main` `062af6f8` (#707) 2026-09-24. Перед стартом каждого PR исполнитель повторяет замер (шаг 0 каждой задачи), потому что между планом и исполнением смёржится #706.

## Global Constraints

Действуют на каждую задачу. Пункты с пометкой «урок» взяты из разборов PR #700–#707, и каждый из них уже однажды стоил отдельного раунда ревью.

**Версии и механика Lingui**

- `@lingui/*` — **5.9.5 EXACT**, одной версией (`version-pins.md`). Этот план ничего не апгрейдит.
- Исходный текст в коде — **украинский** (`sourceLocale: 'uk'`). Английский пишет тот же кодер в том же PR как второй оригинал (скилл `copywriting` §5, решение владельца №7). Интерфейс по умолчанию `uk`, второй язык `en`.
- На уровне модуля — только `msg`. `t`, `plural` и `select` на уровне модуля запрещены: строка замёрзнет при импорте. В компоненте `t`/`i18n` берутся из `useLingui()` (`@lingui/react/macro`).
- **Урок (#700): макрос `plural()` несовместим со Stryker.** Под инструментированием `#` не подставляется. Для чисел в JSX — компонент `<Plural>`; вне JSX — `msg` с ICU-строкой и `i18n._(descriptor, { count })`. Вызов `t\`${plural(...)}\`` не использовать.
- **Урок (#707): `as const satisfies Record<…, MessageDescriptor>` на карте `msg`-шаблонов отключает Stryker для всего блока** (0 мутантов). Пишется `satisfies Record<…>` без `as const`. Если гейт показывает 0 мутантов в файле, где точно есть `msg`, причина в этом.
- `i18n._()` принимает только **выражение**: `i18n._(API_ERROR_MESSAGES.X)` или `i18n._(MAP[key])`. Объектный литерал со spread (`i18n._({ ...d, values })`) роняет `lingui extract` (подробности в комментарии к `translateApiError` в `apps/web/app/lib/axios-utils.ts`).
- **Урок (#707): у записей с явным id (`api-error.*`, `zod-error.*`) `msgstr` правится руками в обоих `.po`.** `i18n:extract` существующий `msgstr` не перезаписывает. Эта волна тексты с явным id не меняет. Если такая правка понадобится, это отдельная строка в «Допущениях» PR и ручная правка обоих `.po`.

**Тексты (`CONTEXT.md` → «Формы `uk`/`en`» + таблица канона ниже)**

- Апостроф — `’` (U+2019), не `'` и не `ʼ`. Многоточие — `…` (U+2026), не `...` (аудит COPY-L-ppl-1: в срезе 23 строки с `...` против 21 с `…`). Кавычки: в `uk` ёлочки `«…»`, в `en` типографские `“…”`.
- Роли пишутся словами из глоссария: `uk` — «адміністратор», «сеньйор», «джуніор», «HR», «бухгалтер», «дроп»; `en` — «admin», «senior», «junior», «HR», «accountant», «drop». **`en` для ADMIN — «admin»** (глоссарий `CONTEXT.md` и каталог `Адміністратор → Admin`). Если на урок #701 п.4 («administrator») ссылается ревьюер, отвечать глоссарием: он канон.
- **Урок (#702, п.13): сырой enum роли в видимом тексте — находка.** После замены литерала сканировать **весь** файл: `grep -nE '\b(ADMIN|SENIOR|JUNIOR|HR|ACCOUNTANT|DROP)\b'` по JSX-тексту, `aria-label`, `title` и `placeholder`. На каждый экран с ролью — тест «в отрендеренном экране нет сырого enum». Исключение одно: `HR` — это и enum, и слово глоссария.
- **Урок (#702, п.9): подстановка роли в косвенный падеж ломает `uk`.** Роль подставляется только в именительном («для ролі «Сеньйор»»). Если нужен другой падеж — `select` по роли с готовыми формами, набор веток которого совпадает со значениями enum, реально доходящими до места (урок п.8), плюс тест, что `other` недостижим.
- Тост и отказ — **одно предложение, без точки в конце**, с глаголом, и там, где есть действие, сказано «что делать». Телеграфный стиль («Аватар: документ видалено») запрещён. Одна ситуация — один текст: одинаковые состояния в PR1 и PR2 берут текст из таблицы канона дословно, тогда в каталоге будет один ключ.
- Имена полей, пути API, `teamMode=…`, `senior+team`, `cascade` в тексте для человека запрещены (аудит COPY-H-ppl-6).
- **Урок (#701, п.5): русизмы проверять по юникоду, не байтовым `grep`.** Перед каждым push:

```bash
python3 -c "import re,sys,subprocess;fs=subprocess.run(['git','diff','--name-only','origin/main','--','apps/web/app'],capture_output=True,text=True).stdout.split();[print(f,i,l.strip()) for f in fs if f.endswith(('.ts','.tsx')) for i,l in enumerate(open(f,encoding='utf8'),1) if re.search('[ыЫэЭъЪёЁ]',l) and not re.match(r'\s*(//|\*|\{/\*)',l)]"
```

Строки из этого вывода в файлах **своего** PR — недоделка. Исключения — тестовые фикстуры с русскими данными (имена людей из сида) и комментарии.

**Тесты**

- Якоря — `data-testid` и роли. Текст в ассертах берётся из **каталога `uk`**, не литералом:
  - Vitest — `loadCatalog(locale)` и `I18nTestProvider` из `apps/web/app/test/i18n.tsx` (уже в `main`);
  - E2E — `loadMessages('uk')` и `assertInCatalog(uk, '<текст>')` из `apps/e2e/fixtures/catalog.ts` (уже в `main`).
- **Урок (#700, п.2): E2E-свип по всему `apps/e2e`, а не по спекам из диффа.** Регрессия — любой литерал мигрированного компонента в любой спеке. Процедура и скрипт — «Общий шаг: E2E-свип» ниже. «Pre-existing» допустимо только если CI на `origin/main` красный на той же спеке. Если `main` зелёный, это регрессия.
- **Урок (#700, п.3): мутационный гейт на полном диффе — обязательный AC**, `survived 0`. Если у `NoCoverage` нет integration-hint, его закрывает unit-тест (`mutation-gate-integration-specs.md`). Локальный SKIP по таймауту — не PASS: тогда `stryker run` напрямую с `dryRunTimeoutMinutes: 20` и тем же конфигом, что у гейта.
- **Урок (#699, п.12): каждое подавление Stryker — с причиной на той же строке директивы**, не короче 12 символов (`// Stryker disable next-line <Mutator>: <причина>`). Перед push — `node scripts/devops/check-mutation-suppressions.mjs`: локальный `pnpm mutation:changed` его не вызывает, а CI с ним валит все Mutation Gate джобы ещё до старта.
- Тесты правит тот же кодер в том же PR (зона AutoTest по природе файла, но правка ассертов внутри мигрируемого модуля — часть той же задачи, как в волне a). Новых `*.spec.ts`-сценариев E2E волна не заводит.

**Процесс**

- `git add` явным списком (в каждой задаче он есть). Push — `DATABASE_URL= git push`, без `--no-verify`. Каждый коммит несёт `ac_verified:` с номерами из раздела «Acceptance criteria» своей задачи.
- **Урок (#700, п.6): каденс для 30+ файлов** — `wip:`-коммиты локально, в конце **один** push. Pre-push под нагрузкой флакает, каждый push занимает 5–12 минут.
- **Урок (#700, п.5): скриншоты и живые проходы делаются скриптом `npx playwright` в своём scratchpad**, не через `mcp__playwright__*`: браузер MCP общий у всех параллельных агентов.
- **Урок (#704/#707, п.6 и п.18): конфликт `.po` при параллельных PR аддитивен.** Берутся обе стороны, затем `pnpm i18n:extract` дважды, и второй прогон должен дать пустой дифф. Проверка числами: число `msgid` равно `main` плюс новые записи PR, а fuzzy, `#-#-#` и пустых `msgstr` в `en` — 0. Merge `.po` не отдаётся haiku.
- **Урок (#700, п.9): task-файл — единственный канал требований.** В промпт кодера оркестратор пишет: «все разделы "Дополнение оркестратора" в task-файле — часть задания».
- После каждого Edit/Write `.ts`/`.tsx` — `mcp__eslint__lint-files`. На строках, которые волна трогает, новых warning `lingui/no-unlocalized-strings` быть не должно.
- `pnpm i18n:extract` идемпотентен: второй прогон подряд не меняет `.po`. CI-гейт «i18n catalogs are in sync» это проверяет, перед push то же воспроизводится локально.
- **Урок (#705, п.15): FM-5 guard-test gate.** Волна **не трогает** `apps/api`. Если исполнитель всё же решит править контроллер из списка `guard-test-gate.yml`, в том же PR нужен изменённый `apps/api/**/*.spec.ts` с ассертом 403 (или строка `guard-test-na: <причина>` в теле PR до push). Лучше такую правку вынести отдельным PR.
- Каждый PR проходит design-gate **Tier 2** (правка существующих экранов: conformance-проверка ui-ux-designer, без генерации в Claude Design) и fidelity Mode B на всех классах устройств. Вердикт `copy-reviewer` — по `uk` и по `en` **отдельно**. `security-reviewer` обязателен для всех трёх PR: они трогают формы реквизитов и USDT-кошелька, доли, создание пользователя с ролью, архивацию и маскировку состава команды (critical-path zones `pm.md`). Логика там не меняется, но проверить это должен ревьюер, а не автор.
- **Responsive AC для каждого PR:** экраны из задачи проверяются на 320 и 375 (мобайл), 768 (планшет), 1024 и 1280 (ноутбук), 1440 и 1920 (большой) на **обоих** языках. Нет горизонтального скролла (`document.scrollWidth <= clientWidth`), ни одна подпись не обрезана без `truncate` с `title`, тач-таргеты на мобайле не меньше 44×44. Скриншоты 320 и 1440 × `uk` и `en` прикладываются к PR. Украинский длиннее английского на 15–30 %, поэтому 320 на `uk` — главный риск.

---

## Тестовый доступ к каталогу (хелперы уже в `main`)

Раздел волны (a) «Тестовый доступ к каталогу» реализован и смёржен. Здесь — только как пользоваться.

```tsx
// Vitest (apps/web) — реальный каталог через тот же путь, что в продакшене
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

await loadCatalog('uk')
render(<UserRow user={senior} />, { wrapper: I18nTestProvider })
expect(screen.getByText('Сеньйор')).toBeInTheDocument()

await loadCatalog('en')
render(<UserRow user={senior} />, { wrapper: I18nTestProvider })
expect(screen.getByText('Senior')).toBeInTheDocument()
```

```ts
// E2E (apps/e2e) — перед прогоном обязателен `pnpm i18n:compile`
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

const uk = await loadMessages('uk')
await page.getByTestId('user-dialog-role-trigger').click()
await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
```

`assertInCatalog` падает с понятной ошибкой, если текста нет в каталоге: так устаревший литерал не превращается в таймаут Playwright. Относительный путь импорта зависит от глубины спеки: `'../fixtures/catalog'` для `tests/*.spec.ts`, `'../../../fixtures/catalog'` для `tests/crm/<раздел>/*.spec.ts` (образец — `crm/team/team-archive.spec.ts`).

---

## Периметр волны (b) — как получен

Команда (зона среза аудита `web-people`):

```bash
git ls-files apps/web/app/components/{users,user-profile,onboarding,job-sourcing} \
  apps/web/app/routes/_authenticated/{team,users,profile,onboarding} \
  | grep -vE '__tests__|\.(spec|test)\.'
```

Результат на `062af6f8` — **60 продуктовых файлов** (аудит на `3990a584` насчитал 59: с тех пор этап 2 добавил `LanguageSection.tsx`). Кириллица — 1045 строк, из них вне комментариев 880.

Дальше периметр корректируется. Каждое отклонение — строка в «Допущениях» ниже.

| Что                                                                                                                                                      | Решение            | Почему                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/job-sourcing/**` (3 файла, 47 строк вне комментариев)                                                                                        | **исключить**      | Автоподача резюме на паузе по решению владельца: «код job-sourcing не трогать, новых задач не заводить». Что с модулем делать к этапу 6 — вопрос A2 ниже |
| `components/user-profile/LanguageSection.tsx`                                                                                                            | **не мигрировать** | Этап 2 уже написал его на `uk` (6 строк с кириллицей — украинские исходники `msg`/`Trans`)                                                               |
| `components/user-profile/contract/ContractEditor.tsx`, `users/{ProfileNameLink,UnarchiveButton,UserAvatar,section}.tsx`, `job-sourcing/open-original.ts` | **не трогать**     | Кириллицы 0                                                                                                                                              |
| `routes/_authenticated/profile/{index,$userId}.tsx`                                                                                                      | **не мигрировать** | По 1 строке кириллицы, обе — комментарии                                                                                                                 |
| `components/archive/ArchiveConfirmDialog.tsx`                                                                                                            | **добавить** (PR2) | Отложенные COPY-L-31/L-32 из #700 живут в нём; блок пользователя выносится в общий компонент                                                             |
| `components/archive/UserArchiveImpact.tsx`                                                                                                               | **создать** (PR2)  | Отложенный пункт 3: один текст влияния архивации вместо двух                                                                                             |
| `components/ui/role-select.tsx`                                                                                                                          | **добавить** (PR3) | Удаление легаси `ROLE_LABELS` после миграции последнего потребителя (урок #700, п.8)                                                                     |
| `packages/shared/src/schemas/{contracts,tos,notification-preferences}.ts`                                                                                | **добавить** (PR1) | Удаление трёх русских `*_IMPERSONATION_MESSAGE`: после PR1 у них не остаётся потребителей                                                                |
| `packages/shared/src/i18n/format.ts`                                                                                                                     | **добавить** (PR3) | Стиль `'dateTime'` для `formatResetTime` (время сброса квоты — нужны часы и минуты в локальной зоне; все существующие стили — даты в UTC)                |
| `CONTEXT.md`                                                                                                                                             | **добавить** (PR1) | Урок #700, п.1: формы терминов волны заводятся в глоссарий до миграции файлов                                                                            |

Итог по PR:

| PR      | Что                                                                                                                                         | Продуктовых файлов (мигрирует / разобрано) | Строк кириллицы вне комментариев |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| **PR1** | Онбординг и профиль (оболочка, вкладки, админ-действия, самоправка, контракт сотрудника)                                                    | 30 / 30 + 3 shared-схемы + `CONTEXT.md`    | 362                              |
| **PR2** | Список пользователей, команды, архивация пользователя (оба диалога и общий текст влияния)                                                   | 11 / 11 + 1 новый                          | 221                              |
| **PR3** | Мастер пользователя (`UserDialog.tsx`), резюме сеньйора, удаление обоих легаси `ROLE_LABELS`, стиль `'dateTime'`, 17 E2E-кликов по «Синьор» | 10 / 10 + `format.ts`                      | 244                              |

Сумма мигрируемых строк — 827 из 880. Оставшиеся 53 — `job-sourcing` (47) и `LanguageSection.tsx` (6, уже украинские исходники). Столбец «строк» считает строки с кириллицей вне комментариев (`uk`-строки уже мигрированного `components/archive/ArchiveConfirmDialog.tsx` в сумму не входят).

---

## Дисциплина параллельности

| Шаг | Что                          | Ждёт               | Почему                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | #706 (3a PR2, `lib`/`hooks`) | —                  | Открыт. Трогает файлы этой волны: `user-profile/admin-actions/__tests__/{AdminActionsMenu.resend-invite,ArchiveUserDialog}.test.tsx`, `user-profile/tabs/__tests__/{FinanceTab.total-earned,OverviewTab.pending-share}.test.tsx`, E2E `profile-self-edit`, `requisites-warning`, `crm/team/team-archive`, а также `CONTEXT.md`. Кроме того, меняет `formatAmount`/`formatBytes` (параметр `locale`)                                                                                    |
| 1   | **PR1 ∥ PR2**                | мерж #706          | Продуктовые, тестовые и E2E-файлы PR1 и PR2 не пересекаются (проверено скриптом по фрагментам текста, уникальным для каждой группы: ни одна спека не ассертит тексты обеих групп). Общее у них только `.po` — конфликт аддитивный (Global Constraints). Одинаковые состояния («нічого не знайдено», «не вказано») оба пишут дословно по таблице канона — один ключ                                                                                                                     |
| 2   | **PR3**                      | мерж **PR1 и PR2** | (1) Удаление `role-select.ROLE_LABELS` возможно только после PR1 (`UserProfileHeader`, `ContractTab`, `TeamTab`), удаление `constants.ROLE_LABELS` — только после PR2 (`UserRow`, `users/index.tsx`). (2) Спеки `users`, `crm/users/users-refactor`, `drop-add-senior`, `drop-create`, `drop-create-ui-regressions`, `senior-create-default` правит и PR2 (бейджи, фильтр), и PR3 (мастер). То же с `admin-actions` и `requisites-warning` (PR1 и PR3). Последовательно конфликтов нет |

**Распределение E2E-спек** (чей текст ассертит строка, тот PR её и правит; снято скриптом, повторить на шаге свипа):

| PR  | Спеки (строки — на `062af6f8`, для ориентира)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 | `admin-actions.spec.ts` (пункт меню «Заметка админа»), `crm/contract-editor.spec.ts` («Нет шаблона контракта для роли Синьор», «Вернуть подписанный контракт в черновик?», «Остаться»), `crm/mobile-keyboard-attributes.spec.ts` («Реквизиты для выплат»), `crm/senior-resume.spec.ts` (только «Остаться» — диалог несохранённых изменений `UserProfileShell`), `onboarding-logout.spec.ts` («Выйти»), `profile-self-edit.spec.ts`, `requisites-warning.spec.ts` (кроме строк мастера)                                                                                                                   |
| PR2 | `crm/team/team-archive.spec.ts`, `crm/users/users-refactor.spec.ts` (бейдж «Синьор» в строке, фильтры), `drop-archive-real.spec.ts`, `drop-archive-user-real.spec.ts`, `drop-archive-cascade.spec.ts`, `drop-rotate-senior.spec.ts`, `polish-regressions.spec.ts`, `team.spec.ts` (31 строка), `users.spec.ts` (бейджи «Администратор»/«Синьор», фильтр «Все роли»/«Джун»), строки команд и HR-чипов в `drop-add-senior`, `drop-create`, `drop-create-ui-regressions`, `senior-create-default`                                                                                                           |
| PR3 | **17 кликов `getByRole('option', { name: 'Синьор' })` по `user-dialog-role-trigger`** в 5 спеках: `users.spec.ts` ×5, `drop-add-senior.spec.ts` ×6, `senior-create-default.spec.ts` ×3, `crm/users/users-refactor.spec.ts` ×2, `drop-create-ui-regressions.spec.ts` ×1. Плюс `admin-actions.spec.ts` (заголовок «Редактировать пользователя», триггер роли «Джун», тост «Пользователь обновлён»), `drop-duplicate-email.spec.ts` («Дроп создан»), `requisites-warning.spec.ts` (подпись «USDT ERC-20 кошелёк» в мастере), `crm/senior-resume.spec.ts` («Распознаём резюме»), `crm/create-wizard.spec.ts` |

`cache/anti-stale.spec.ts` (`/^Синьор/`) ассертит подпись в диалоге **проекта** (волна c) — в этой волне не трогается.

---

## Канон терминов волны (b) — `uk`/`en`

PR1 переносит эту таблицу в `CONTEXT.md` (раздел «Формы `uk`/`en`», продолжение волны a) первым коммитом. PR2 и PR3 берут слова отсюда дословно. Колонка «Откуда» ссылается на находку аудита, которая выбор предопределила.

| Термин (рус., для справки)           | `uk`                                                                             | `en`                                                                   | `_Избегать_` в продукте                                                                                       | Откуда                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Пользователь (учётная запись в CRM)  | користувач                                                                       | user                                                                   | «юзер»                                                                                                        | —                                                                                             |
| Сотрудник (человек в компании)       | співробітник                                                                     | employee                                                               | «працівник» (в каталоге уже 21 запись со «співробітник»)                                                      | каталог `main`                                                                                |
| Профиль                              | профіль                                                                          | profile                                                                | —                                                                                                             | —                                                                                             |
| Онбординг                            | онбординг                                                                        | onboarding                                                             | «адаптація», «введення в посаду»                                                                              | —                                                                                             |
| Пользовательское соглашение (ToS)    | Умови використання                                                               | Terms of Service                                                       | латиница «Terms of Service» в `uk`; «Умови користування», «Користувацька угода»                               | COPY-H-ppl-2; каталог уже говорит «умови використання» (`api-error.TOS_ACCEPT_IMPERSONATION`) |
| Юридическое имя                      | юридичне ПІБ                                                                     | legal name                                                             | «ФІО», «display name»                                                                                         | глоссарий **Юридическое имя**; COPY-H-ppl-7                                                   |
| Имя в CRM (отображаемое)             | ім’я та прізвище                                                                 | full name                                                              | «display name» в тексте                                                                                       | —                                                                                             |
| Реквизиты                            | реквізити для виплат                                                             | payout details                                                         | «платіжні реквізити», «payment requisites»                                                                    | COPY-M-ppl-10                                                                                 |
| Способ выплаты (`paymentMethodEnum`) | спосіб виплати                                                                   | payout method                                                          | «спосіб оплати», «метод оплати», «payment method»                                                             | глоссарий **Способ выплаты**; COPY-M-ppl-10                                                   |
| Кошелёк USDT                         | гаманець USDT (ERC-20)                                                           | USDT wallet (ERC-20)                                                   | «USDT кошельок»                                                                                               | каталог `main` («Гаманець USDT ERC-20»)                                                       |
| РНОКПП                               | РНОКПП                                                                           | tax ID (RNOKPP)                                                        | «ІПН», «ИНН ФОП»                                                                                              | —                                                                                             |
| Архивировать / восстановить          | архівувати / відновити                                                           | archive / restore                                                      | «видалити», «deleted» про архівацію                                                                           | COPY-H-ppl-8                                                                                  |
| Архив (фильтр)                       | в архіві                                                                         | archived                                                               | —                                                                                                             | —                                                                                             |
| Заметка администратора               | нотатка адміністратора                                                           | admin note                                                             | «заметка админа», «коментар»                                                                                  | COPY-H-ppl-3                                                                                  |
| Личная почта                         | особистий email                                                                  | personal email                                                         | «особиста адреса» (читается как поштова адреса; в каталоге сейчас оба варианта — PR1 выравнивает свои строки) | каталог `main`                                                                                |
| Статус контракта `DRAFT`             | чернетка                                                                         | draft                                                                  | —                                                                                                             | глоссарий **Контракт сотрудника**                                                             |
| Статус контракта `READY_TO_SIGN`     | готовий до підписання                                                            | ready to sign                                                          | «передано на підпис» как название статуса                                                                     | аудит §1 п.3 (две формулировки)                                                               |
| Статус контракта `SIGNED`            | підписаний                                                                       | signed                                                                 | —                                                                                                             | —                                                                                             |
| Статус контракта `CANCELLED`         | скасований                                                                       | cancelled                                                              | —                                                                                                             | —                                                                                             |
| Резюме сеньйора                      | резюме                                                                           | CV                                                                     | «resume» (в `en`-интерфейсе совпадает с глаголом «продолжить»)                                                | локаль `en-GB` (`INTL_TAG` в `format.ts`)                                                     |
| Пустое значение поля                 | не вказано                                                                       | not set                                                                | «—» без текста, «Не указано»/«не указано» вперемешку, «Заметок нет»                                           | COPY-L-ppl-4                                                                                  |
| Фильтр ничего не нашёл               | Нічого не знайдено — скиньте фільтри                                             | No matches — clear the filters                                         | «Нет данных», «Пользователи не найдены», «Нет доступных пользователей»                                        | COPY-M-ppl-14                                                                                 |
| Нет доступа к профилю                | Немає доступу до профілю — якщо він потрібен для роботи, напишіть адміністратору | No access to this profile — if you need it for work, write to an admin | два текста на один случай                                                                                     | COPY-M-ppl-7                                                                                  |
| Пример ФИО (placeholder)             | Іваненко Іван Іванович                                                           | Ivan Ivanenko                                                          | «Иванов Иван Иванович»                                                                                        | COPY-M-ppl-13                                                                                 |
| Пример адреса регистрации ФОП        | м. Київ, вул. Хрещатик, 1                                                        | 1 Khreshchatyk St, Kyiv                                                | «г. Киев, ул. Крещатик, 1»                                                                                    | COPY-M-ppl-13                                                                                 |
| Пример банка                         | ПриватБанк                                                                       | PrivatBank                                                             | —                                                                                                             | COPY-M-ppl-13                                                                                 |
| Подсказка поля технологий            | Почніть вводити: React, Node.js…                                                 | Start typing: React, Node.js…                                          | «Начните вводить, например: Re...»                                                                            | COPY-M-ppl-13                                                                                 |

---

## Шаблоны миграции

**A–F — те же, что в волне (a)** (`docs/superpowers/plans/2026-09-20-crm-i18n-stage3a-web-core.md`, раздел «Шаблоны миграции»): A — модульная константа → `msg` + `i18n._()` в рендере; B — JSX-текст → `<Trans>`; C — атрибут или императивная строка → `t` из `useLingui()`; D — число → `<Plural>` (в этой волне **только компонент**, см. урок про Stryker); E — родовая форма по роли → `select`; F — дата, деньги, число → `@crm/shared` `format.ts`.

Новые в этой волне:

**G. Текст, который уже есть в каталоге по коду, — через каталог, а не через русскую константу из `@crm/shared`.**

```tsx
// было (SignContractStep.tsx; то же в AcceptTosStep.tsx и NotificationSettingsTab.tsx)
import { CONTRACT_SIGN_IMPERSONATION_MESSAGE } from '@crm/shared'
const IMPERSONATION_EXPLANATION = `${CONTRACT_SIGN_IMPERSONATION_MESSAGE}.`
// …
{
  IMPERSONATION_EXPLANATION
}

// стало — тот же текст, что сервер отдаёт кодом CONTRACT_SIGN_IMPERSONATION;
// одно предложение без точки, точку снаружи не приклеиваем (аудит, B «Кросс-срезовые импорты»)
import { API_ERROR_MESSAGES } from '@crm/shared'
import { useLingui } from '@lingui/react/macro'
const { i18n } = useLingui()
// …
{
  i18n._(API_ERROR_MESSAGES.CONTRACT_SIGN_IMPERSONATION)
}
```

Zod-сообщения клиентских схем — код `'zod.<CODE>'` из реестра `ZOD_ERROR_CODES` и `translateZodMessage`/`translateZodCode` из `@/lib/axios-utils` (эталон — `ChangePersonalEmailDialog.tsx` и `RejoinTeamDialog.tsx`, которые этап 4 уже перевёл). Нового кода в реестре волна не заводит: всё нужное есть (`EMAIL_INVALID`, `EMAIL_TOO_LONG`, `DISPLAY_NAME_MIN`, `LEGAL_FULL_NAME_MIN`, `RECIPIENT_NAME_MIN`, `VALIDATION_FAILED_FORM`, `RESUME_TEXT_TOO_SHORT`). Если код всё-таки нужен, это правка `packages/shared/src/schemas/zod-errors.ts` с ручной правкой обоих `.po` (Global Constraints).

**H. Потребитель легаси-словаря ролей → `ROLE_LABEL_MESSAGES`.** Одиночное значение — хук, список — один `useLingui()` на компонент и `i18n._()` внутри `.map()` (хук в `.map()` вызывать нельзя). Образец — `routes/_authenticated/admin/login-as.tsx`.

```tsx
// было (UserRow.tsx)
import { ROLE_LABELS } from './constants'
<Badge variant={ROLE_VARIANT[user.role] ?? 'outline'}>{ROLE_LABELS[user.role]}</Badge>

// стало — одно значение
import { useRoleLabel } from '@/components/ui/role-select'
const roleLabel = useRoleLabel(user.role)
<Badge variant={ROLE_VARIANT[user.role] ?? 'outline'}>{roleLabel}</Badge>

// стало — список (TeamTab, $teamId, users/index, UserDialog)
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
const { i18n } = useLingui()
{members.map((m) => (
  <Badge key={m.id} variant="outline">{i18n._(ROLE_LABEL_MESSAGES[m.role])}</Badge>
))}
```

Фоллбэк `?? user.role` удаляется: `Role` — закрытый union, а `ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor>` покрывает все шесть значений. Фоллбэк печатал бы enum (COPY-H-ppl-4).

**I. E2E-ассерт по мигрированному тексту → `assertInCatalog`.**

```ts
// было
await expect(seniorRow.getByText('Синьор')).toBeVisible()
// стало
const uk = await loadMessages('uk')
await expect(seniorRow.getByText(assertInCatalog(uk, 'Сеньйор'))).toBeVisible()
```

Если у элемента есть `data-testid` и текст не является предметом проверки, лучше якорь по testid без текста.

---

## Общий шаг: E2E-свип (выполняется в каждом PR перед push)

Скрипт собирает русские фрагменты, которые **удалил этот PR**, и ищет их во всём `apps/e2e`. Каждая находка — строка, которую надо проверить. Если фрагмент остался в другом, ещё не мигрированном компоненте и спека ассертит именно его, строку не трогают. Если спека ассертит мигрированный экран, строку переводят на шаблон I.

```bash
SCRATCH="${TMPDIR:-/tmp}/wave-b-$(git rev-parse --abbrev-ref HEAD | tr / -)"   # свой каталог: имя из своей ветки, не общий путь
mkdir -p "$SCRATCH"
git diff origin/main -- apps/web/app > "$SCRATCH/wave-b.diff"
```

```python
# $SCRATCH/e2e_sweep.py — python3 e2e_sweep.py <path-to-wave-b.diff>
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
python3 "$SCRATCH/e2e_sweep.py" "$SCRATCH/wave-b.diff" > "$SCRATCH/sweep.txt"
cut -d: -f1 "$SCRATCH/sweep.txt" | sort -u > "$SCRATCH/sweep-specs.txt"   # список для git add
```

Вывод целиком идёт в тело PR (раздел «E2E-свип») с отметкой по каждой строке: «переведена на каталог», «testid» или «не наш текст — <какой компонент вне волны его рендерит>». Строка без отметки — незакрытая. В коммит спеки попадают через `git add $(cat "$SCRATCH/sweep-specs.txt")`: для файлов без изменений это пустая операция.

---

## Task 1 (PR1): онбординг и профиль

**Files:**

Продуктовые (`apps/web/app/`, кириллица на `062af6f8`: всего / вне комментариев):

| Файл                                                                  | Кир. строк | Паттерн(ы) | Находки аудита / примечание                                                                                                                               |
| --------------------------------------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/user-profile/tabs/OverviewTab.tsx`                        | 55 / 51    | B, C, D, F | COPY-H-ppl-2 (карточка ToS), H-3 («Заметка администратора», «Админ увидит причину»), M-10, M-12, L-4; дата принятия ToS — `formatDate(…, 'short')`        |
| `components/onboarding/SignContractStep.tsx`                          | 30 / 23    | B, C, G    | COPY-H-ppl-7 (подсказка), L-2 (`PREVIEW`), L-5 (имя файла), родовое «ознакомился»; **отложенный пункт 4** — плашки COPY-M-15/16 из #702 (Step 4)          |
| `components/user-profile/AvatarUploadDialog.tsx`                      | 29 / 29    | B, C, F    | COPY-M-ppl-8 (KB против MB) — `formatBytes(bytes, locale)` после #706                                                                                     |
| `components/user-profile/UserProfileShell.tsx`                        | 28 / 24    | B, C       | COPY-H-ppl-8 («был удалён»), M-7 (два текста 403), диалог «Остаться»                                                                                      |
| `components/user-profile/self-edit/RequisitesEditForm.tsx`            | 26 / 26    | B, C, G    | COPY-M-ppl-10, M-11 («SENIOR и ADMIN» ×2), M-13 (пример ФИО)                                                                                              |
| `components/user-profile/tabs/NotificationSettingsTab.tsx`            | 78 / 26    | A, B, C, G | Плашка «войти как» — `API_ERROR_MESSAGES.NOTIFICATION_PREFERENCES_IMPERSONATION`; `'Новый тип'`; заголовки типов — см. «Опасность: `NOTIFICATION_TITLES`» |
| `components/user-profile/tabs/FinanceTab.tsx`                         | 25 / 22    | B, C, F    | COPY-H-ppl-9 (карточка «Всего заработано»), M-5 (недостижимая ветка), M-14; `TYPE_OPTIONS`/`STATUS_OPTIONS` — см. «Опасность: карты финансов»             |
| `components/user-profile/contract/ContractPdfPreview.tsx`             | 16 / 15    | B, C       | COPY-L-ppl-5 (имя файла)                                                                                                                                  |
| `components/user-profile/contract/ContractFillForm.tsx`               | 15 / 15    | B, C       | —                                                                                                                                                         |
| `components/user-profile/contract/ContractActionBar.tsx`              | 14 / 14    | B, C       | Статусы — канон таблицы                                                                                                                                   |
| `components/user-profile/contract/ContractTab.tsx`                    | 14 / 14    | A, B, H    | COPY-H-ppl-5 — `ROLE_LABELS[targetRole]` → `useRoleLabel`; `STATUS_LABELS`, `FROZEN_BANNERS` → `msg`                                                      |
| `components/onboarding/AcceptTosStep.tsx`                             | 14 / 9     | B, C, G    | COPY-H-ppl-2 («Terms of Service» ×7 → «Умови використання»), L-1 («Принятие...»)                                                                          |
| `components/user-profile/tabs/RequisitesTab.tsx`                      | 13 / 13    | B          | COPY-M-ppl-10, L-4                                                                                                                                        |
| `components/user-profile/UserProfileHeader.tsx`                       | 10 / 6     | B, F, H    | `ROLE_LABELS` → `useRoleLabel`; «Зарегистрирован» (род) → «Дата реєстрації»; `toLocaleDateString('ru-RU')` → `formatDate(…, 'long')`                      |
| `routes/_authenticated/onboarding/index.tsx`                          | 9 / 9      | B, C       | —                                                                                                                                                         |
| `components/user-profile/admin-actions/AdminActionsMenu.tsx`          | 11 / 7     | A, B       | COPY-H-ppl-3 («Заметка админа»)                                                                                                                           |
| `components/user-profile/contract/useEmployeeContract.ts`             | 9 / 5      | C          | Пять склеек `` `Не удалось сохранить контракт: ${msg}` `` — склейка с серверным текстом уходит, серверный текст берётся из `getApiErrorMessage`           |
| `components/user-profile/ProfileCredentialsSection.tsx`               | 8 / 8      | B, C       | «Нет доступа» — канон таблицы                                                                                                                             |
| `components/user-profile/admin-actions/ChangePersonalEmailDialog.tsx` | 22 / 8     | C, G       | Zod уже на кодах (этап 4); остаток — подписи и тосты                                                                                                      |
| `components/user-profile/tabs/ProjectsTab.tsx`                        | 7 / 7      | B, F       | Две `toLocaleDateString('ru-RU')` → `formatDate`                                                                                                          |
| `components/user-profile/admin-actions/AdminNoteDialog.tsx`           | 6 / 6      | B, C       | COPY-H-ppl-3                                                                                                                                              |
| `components/onboarding/ContractWaitScreen.tsx`                        | 5 / 4      | B          | COPY-M-ppl-15 («15 секунд»), H-3 («Администратор заполнит»)                                                                                               |
| `components/user-profile/self-edit/ProfileEditFields.tsx`             | 5 / 5      | B, C       | COPY-M-ppl-13 (подсказка технологий)                                                                                                                      |
| `components/user-profile/contract/MissingFieldsBanner.tsx`            | 5 / 4      | B          | —                                                                                                                                                         |
| `components/user-profile/tabs/DocumentsTab.tsx`                       | 3 / 3      | B          | Заглушка «(Phase 6)» — внутреннее название этапа в тексте для человека, убрать                                                                            |
| `components/onboarding/TosUpdateBanner.tsx`                           | 2 / 2      | B          | COPY-H-ppl-2                                                                                                                                              |
| `components/user-profile/tabs/InterviewsTab.tsx`                      | 2 / 2      | B          | «синьора» → роль по глоссарию                                                                                                                             |
| `components/user-profile/cropImage.ts`                                | 2 / 2      | —          | Не UI-текст: `Error('…')` для разработчика. Сообщения → английские; `AvatarUploadDialog` показывает **свой** текст, а не `err.message` (Step 9)           |
| `routes/_authenticated/onboarding/route.tsx`                          | 2 / 2      | B          | «Выйти», «Все права защищены»                                                                                                                             |
| `components/user-profile/tabs/TeamTab.tsx`                            | 1 / 1      | B, F, H    | `ROLE_LABELS` → шаблон H; `localeCompare` → `compareNames(locale)`; пустое состояние — см. «Опасность: маскировка»                                        |

Не мигрировать (проверено): `components/user-profile/LanguageSection.tsx` (уже `uk`, этап 2), `components/user-profile/contract/ContractEditor.tsx` (0), `routes/_authenticated/profile/{index,$userId}.tsx` (только комментарии).

Вне `apps/web/app`:

- `CONTEXT.md` — раздел канона (Step 1).
- `packages/shared/src/schemas/contracts.ts`, `tos.ts`, `notification-preferences.ts` — удалить `CONTRACT_SIGN_IMPERSONATION_MESSAGE`, `TOS_ACCEPT_IMPERSONATION_MESSAGE`, `NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE` и их кейсы в `contracts.spec.ts`, `tos.spec.ts`, `notification-preferences.spec.ts` (Step 3). `INVOICE_SIGN_IMPERSONATION_MESSAGE` **не трогать**: его потребитель `invoice-detail-dialog.tsx` — волна (d).
- `packages/shared/src/i18n/locales/{uk,en}/messages.po`.

Тесты (обновить ассерты на каталог; число строк с кириллицей в скобках):

`components/onboarding/{AcceptTosStep.spec.tsx (0), SignContractStep.spec.tsx (7)}`, `components/user-profile/__tests__/{UserProfileHeader.test.tsx (5), UserProfileShell.drop-redirect.test.tsx (10), UserProfileShell.notifications-tab.test.tsx (12)}`, `components/user-profile/admin-actions/__tests__/{AdminActionsMenu.change-personal-email.test.tsx (8), AdminActionsMenu.resend-invite.test.tsx (3), ChangePersonalEmailDialog.test.tsx (32)}`, `components/user-profile/contract/__tests__/{ContractActionBar.test.tsx (5), ContractEditor.test.tsx (3), ContractFillForm.test.tsx (12), ContractPdfPreview.test.tsx (5), ContractTab.test.tsx (3)}`, `components/user-profile/tabs/__tests__/{FinanceTab.total-earned.test.tsx (2), NotificationSettingsTab.grouping.test.ts (10), NotificationSettingsTab.test.tsx (30), OverviewTab.pending-share.test.tsx (48), OverviewTab.share-card.test.tsx (6), OverviewTab.tos.test.tsx (1), TeamTab.empty-state.test.tsx (4)}`. Новые кейсы (Step 2) — внутри существующих файлов, новых тест-файлов PR1 не заводит.

E2E: см. «Распределение E2E-спек», строка PR1, плюс вывод свипа.

**Interfaces:**

- Consumes: `useRoleLabel(role: Role): string`, `ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor>` (`@/components/ui/role-select`, 3a PR1); `API_ERROR_MESSAGES: Record<ApiErrorCode, MessageDescriptor>` (`@crm/shared`, этап 4); `getApiErrorMessage(err, fallback?)`, `getApiErrorCode(err)`, `translateZodCode(code)`, `translateZodMessage(message)` (`@/lib/axios-utils`); `formatDate(value, locale, style)`, `compareNames(locale)` (`@crm/shared`); `useLocale(): Locale` (`@/lib/i18n`); `formatBytes(bytes, locale)` и `formatAmount` — **в той сигнатуре, которую оставит #706** (перед Step 7 и Step 9 проверить `git show origin/main:apps/web/app/lib/format-amount.ts` и `format-bytes.ts`); `loadCatalog`, `I18nTestProvider`, `loadMessages`, `assertInCatalog`.
- Produces: раздел канона волны (b) в `CONTEXT.md` — его читают PR2 и PR3. Из `@crm/shared` удаляются три экспорта `*_IMPERSONATION_MESSAGE` (перечислены выше). Новых экспортов нет. `components/user-profile/tabs/TeamTab.tsx`, `UserProfileHeader.tsx` и `contract/ContractTab.tsx` перестают импортировать `ROLE_LABELS` — это предусловие удаления легаси в PR3.

### Опасность: маскировка состава команды (`TeamTab`)

Аудит (COPY-M-ppl-6) предлагает для `TeamTab` текст «Состав команды пока пуст — добавьте участников кнопкой выше». **Здесь это применять нельзя.** Комментарий над пустым состоянием `TeamTab` фиксирует решение от 2026-08-17: маскировка прячет состав одинаково для всех зрителей, и текст обязан оставаться правдой в обоих случаях, то есть не говорить ни «команда пуста», ни «что-то скрыто». Легенда джуниора построена как список разрешённого (глоссарий **Легенда**). Текст, который подсказывает причину пустоты, раскрывает маскировку.

Перевод сохраняет нейтральность дословно: `uk` «Немає даних про склад команди», `en` "No team composition data". В теле PR — строка «COPY-M-ppl-6 для `TeamTab` не применён: инвариант маскировки», для `security-reviewer` отдельно.

### Acceptance criteria (PR1)

1. В `CONTEXT.md` есть подраздел «Волна b — `web-people`» с формами из таблицы канона.
2. `UserProfileHeader`, `ContractTab`, `TeamTab` не импортируют `ROLE_LABELS`; роли в них — из `ROLE_LABEL_MESSAGES` на `uk` и `en`; тесты «нет сырого enum» зелёные.
3. Плашки «войти как» в `SignContractStep`, `AcceptTosStep`, `NotificationSettingsTab` берут текст из `API_ERROR_MESSAGES`; `CONTRACT_SIGN_IMPERSONATION_MESSAGE`, `TOS_ACCEPT_IMPERSONATION_MESSAGE`, `NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE` удалены из `@crm/shared`.
4. Онбординг на `uk`/`en`, смысл исправлений COPY-M-15/16 из #702 сохранён; закрыты COPY-H-ppl-2, H-7, M-15, L-2, L-5 (онбординг и контракт).
5. Профиль на `uk`/`en`; закрыты COPY-H-ppl-3 (в файлах PR1), H-5, H-8, H-9, M-5, M-7, M-8, M-10, M-11, M-12, M-13 (в файлах PR1), M-14 (`FinanceTab`), L-4; пустое состояние `TeamTab` осталось нейтральным (маскировка).
6. В файлах PR1 нет `toLocale*String('ru-RU')` и `date-fns/locale`; даты, размеры и сортировка идут через `format.ts`/`formatBytes`.
7. Проверка Step 10: ни одной строки `RU`, строки `ENUM` разобраны.
8. Unit-тесты ассертят текст из каталога; E2E-свип выполнен, таблица в теле PR; E2E спек PR1 зелёные.
9. `pnpm i18n:extract` дважды — пустой дифф; в `en` 0 пустых `msgstr`.
10. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` зелёный.
11. Design tier 2, fidelity Mode B на всех ширинах, скриншоты 320/1440 × `uk`/`en`; `copy-reviewer` PASS по `uk` и `en`; `security-reviewer` APPROVE.

### Опасность: карты финансов в `FinanceTab` (кросс-срезовый импорт)

`FinanceTab.tsx` импортирует `TYPE_LABELS`/`STATUS_LABELS` из `@/routes/_authenticated/finance/constants` — это волна (d), и там они ещё русские. Эта волна **не трогает** `finance/constants.ts`. Производные массивы `TYPE_OPTIONS`/`STATUS_OPTIONS` переезжают с уровня модуля внутрь компонента (`useMemo`) и продолжают читать легаси-карты. Тогда волне (d) хватит поменять один источник, а заморозки при импорте здесь не останется. Русские подписи типов и статусов в фильтре `FinanceTab` доживают до волны (d) — это строка в «Допущениях» PR, а не недоделка.

### Опасность: `NOTIFICATION_TITLES` (этап 4, Task 6)

`NotificationSettingsTab.rowTitle` показывает `NOTIFICATION_TITLES[type]` — это `Record<NewNotificationType, string>` на русском в `packages/shared/src/schemas/notification-registry.ts`. Переводом занимается этап 4, Task 6: он вводит `NOTIFICATION_TITLE_MESSAGES` и оставляет легаси без изменений. На Step 10 проверить `git grep -n NOTIFICATION_TITLE_MESSAGES origin/main -- packages/shared`:

- **есть** — `rowTitle` переходит на `i18n._(NOTIFICATION_TITLE_MESSAGES[type])`, и функция получает параметр `i18n: I18n`;
- **нет** — `rowTitle` остаётся на легаси, в теле PR пишется строка «заголовки типов уведомлений — после этапа 4 Task 6», в `NotificationSettingsTab.tsx` ставится комментарий с тем же текстом. Остальной текст файла мигрирует в любом случае.

- [ ] **Step 0: Замер и предусловия**

```bash
git rev-parse --show-toplevel                       # == выданный worktree
git fetch origin main && git log --oneline -1 origin/main
gh pr view 706 --json state -q .state               # MERGED, иначе стоп: старт после мержа #706
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/components/onboarding apps/web/app/components/user-profile apps/web/app/routes/_authenticated/onboarding
```

Если числа отличаются от таблицы больше чем на 10 %, обновить таблицу в task-файле до начала работы.

- [ ] **Step 1: Канон терминов → `CONTEXT.md`**

Добавить в `CONTEXT.md` сразу после таблицы «Формы `uk`/`en` (этап 3, волна a …)» подраздел:

```markdown
### Волна b — `web-people` (добавлено PR <N>)

| Термин (русский, для справки) | `uk` | `en` | `_Избегать_` в продукте (`uk`/`en`) |
| ----------------------------- | ---- | ---- | ----------------------------------- |
```

Строки — из таблицы «Канон терминов волны (b)» этого плана, колонки «Термин», `uk`, `en`, «_Избегать_» дословно (колонка «Откуда» в глоссарий не переносится). Отдельный коммит `docs(context): wave b uk/en term forms`, `ac_verified: 1`.

- [ ] **Step 2: Тест на роли в профиле (падает)**

В существующий `components/user-profile/__tests__/UserProfileHeader.test.tsx` (там уже есть фабрика `makeUser(overrides)`) добавить:

```tsx
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const RAW_ROLE = /\b(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)\b/

describe('role badge comes from ROLE_LABEL_MESSAGES', () => {
  it.each([
    ['uk', 'SENIOR', 'Сеньйор'],
    ['uk', 'DROP', 'Дроп'],
    ['en', 'SENIOR', 'Senior'],
    ['en', 'ADMIN', 'Admin'],
  ] as const)('%s: %s badge reads %s and no raw enum leaks', async (locale, role, label) => {
    await loadCatalog(locale)
    const { container } = render(<UserProfileHeader user={makeUser({ role })} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.textContent ?? '').not.toMatch(RAW_ROLE)
  })
})
```

Существующие `render(<UserProfileHeader …/>)` этого файла получают `{ wrapper: I18nTestProvider }` и `beforeEach(() => loadCatalog('uk'))`: после Step 3 компонент зовёт `useLingui()`.

Для `TeamTab` и `ContractTab` — такие же `it.each` в их тест-файлах: `TeamTab.empty-state.test.tsx` получает кейс со списком участников (роли `SENIOR`, `JUNIOR`, `HR` → «Сеньйор», «Джуніор», «HR» на `uk`; «Senior», «Junior», «HR» на `en`), `ContractTab.test.tsx` — пустое состояние без шаблона для `SENIOR` (на `uk` в тексте «Сеньйор», `SENIOR` нет).

Run: `pnpm --filter @crm/web test -- UserProfileHeader ContractTab TeamTab` → FAIL (сейчас «Синьор» из легаси).

- [ ] **Step 3: Легаси-роли и плашки «войти как» (шаблоны H и G) → PASS**

`UserProfileHeader.tsx`: `ROLE_LABELS[user.role]` → `useRoleLabel(user.role)`; «Зарегистрирован {дата}» → `<Trans>Дата реєстрації: {createdAt}</Trans>`, где `createdAt = formatDate(user.createdAt, locale, 'long')`, `locale = useLocale()` (форма без рода — COPY «родовые окончания»).

`TeamTab.tsx`: шаблон H для списка; сортировка — `ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || compareNames(locale)(a.displayName, b.displayName)` (коллатор создать один раз: `const cmp = useMemo(() => compareNames(locale), [locale])`).

`ContractTab.tsx`: пустое состояние без шаблона.

```tsx
const roleLabel = useRoleLabel(targetRole as Role)
// …
<Trans>Немає шаблону контракту для ролі «{roleLabel}»</Trans>
```

`STATUS_LABELS`, `FROZEN_BANNERS` — шаблон A (`Record<ContractStatus, MessageDescriptor>`, `satisfies` без `as const`), статусы — по канону («Чернетка», «Готовий до підписання», «Підписаний», «Скасований»).

Плашки «войти как» (шаблон G):

- `SignContractStep.tsx` → `i18n._(API_ERROR_MESSAGES.CONTRACT_SIGN_IMPERSONATION)`;
- `AcceptTosStep.tsx` → `i18n._(API_ERROR_MESSAGES.TOS_ACCEPT_IMPERSONATION)`;
- `NotificationSettingsTab.tsx` → `i18n._(API_ERROR_MESSAGES.NOTIFICATION_PREFERENCES_IMPERSONATION)`.

Модульная константа `IMPERSONATION_EXPLANATION` в трёх файлах удаляется. Точка снаружи больше не приклеивается: каталожный текст — одно предложение без точки.

Затем удалить из `@crm/shared` три константы: `CONTRACT_SIGN_IMPERSONATION_MESSAGE` (`schemas/contracts.ts`), `TOS_ACCEPT_IMPERSONATION_MESSAGE` (`schemas/tos.ts`), `NOTIFICATION_PREFERENCES_IMPERSONATION_MESSAGE` (`schemas/notification-preferences.ts`) и их кейсы в соседних `*.spec.ts`. Перед удалением: `git grep -n '<ИМЯ>' -- apps packages` — вхождений вне этих файлов и мигрируемых тестов быть не должно. Тесты `AcceptTosStep.spec.tsx`, `SignContractStep.spec.tsx`, `NotificationSettingsTab.test.tsx`, которые ассертили `` `${…_MESSAGE}.` ``, переходят на `i18n._(API_ERROR_MESSAGES.<CODE>)` после `loadCatalog('uk')`.

Run: `pnpm --filter @crm/web test -- UserProfileHeader ContractTab TeamTab AcceptTosStep SignContractStep NotificationSettingsTab && pnpm --filter @crm/shared test` → PASS.

- [ ] **Step 4: Онбординг — `SignContractStep`, `AcceptTosStep`, `TosUpdateBanner`, `ContractWaitScreen`, `routes/onboarding/*` (отложенный пункт 4)**

`SignContractStep.tsx` — плашки, которые #702 оставил на русском (COPY-M-15/16 **уже исправлены по смыслу**, переносится именно исправленный смысл, не исходный):

| Место                                                  | `uk`                                                                                                                                  | `en`                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Безусловный абзац «Данные в контракте…» (COPY-M-16)    | Дані в контракті — ім’я, email і реквізити — задає адміністратор; якщо щось не так, напишіть йому                                     | The contract data — name, email and payout details — is set by an admin; if something is wrong, write to them |
| Плашка `legalNameMissing` (COPY-M-15)                  | Юридичне ПІБ не заповнено — підписання відкриється, щойно його заповнить адміністратор                                                | Your legal name is not filled in yet — signing opens as soon as an admin adds it                              |
| Подсказка кнопки при `legalNameMissing` (COPY-H-ppl-7) | Юридичне ПІБ заповнює адміністратор — напишіть йому, і підписання відкриється одразу після цього                                      | An admin fills in your legal name — write to them and signing opens right after                               |
| Чекбокс «Я ознакомился…» (родовое окончание, аудит B)  | Умови персонального контракту прочитано — підтверджую                                                                                 | I have read and accept the terms of my personal contract                                                      |
| `<Badge>PREVIEW</Badge>` (COPY-L-ppl-2)                | Попередній перегляд                                                                                                                   | Preview                                                                                                       |
| Тост успеха                                            | Контракт підписано, номер {contractNumber}                                                                                            | Contract signed, number {contractNumber}                                                                      |
| Тост общей ошибки                                      | `getApiErrorMessage(err)` — без клиентского литерала; ветки по кодам `LEGAL_NAME_REQUIRED`/`ADMIN_DOES_NOT_SIGN_CONTRACTS` не трогать | —                                                                                                             |
| `download="contract-preview.pdf"` (COPY-L-ppl-5)       | `download={t\`Контракт — попередній перегляд.pdf\`}`                                                                                  | Contract — preview.pdf                                                                                        |

Тексты выше — черновик для `copy-reviewer`, правится по его вердикту. Существующий тест из #702 «в экране нет `\bADMIN\b`» **сохраняется** и прогоняется на `uk` и `en` (`it.each(['uk','en'])`). Им же дополнительно проверяется `SENIOR|JUNIOR|ACCOUNTANT|DROP` — урок п.13.

`AcceptTosStep.tsx` и `TosUpdateBanner.tsx` — «Terms of Service» → «Умови використання» (COPY-H-ppl-2): «Завантажуємо Умови використання…», «Приймаю Умови використання», «Умови використання не знайдено — зверніться до адміністратора» (у множественного числа в `uk` нет рода, проблема «не найден» уходит), «Умови використання — версія {version}», кнопка «Прийняти Умови використання» / «Приймаємо…». `en` — "Terms of Service" с артиклем по месту: "Loading the Terms of Service…", "I accept the Terms of Service", "The Terms of Service could not be found — contact an admin". Тост ошибки — `getApiErrorMessage(err, t\`Не вдалося прийняти Умови використання\`)`вместо`err.message`.

`ContractWaitScreen.tsx` (COPY-M-ppl-15, H-3): «Контракт готується», «Ваш персональний контракт ще не готовий до підписання — адміністратор заповнить його найближчим часом», «Сторінка оновиться сама, щойно контракт буде готовий». Числа в тексте нет — `refetchInterval` родителя может меняться.

`routes/_authenticated/onboarding/route.tsx`: «Выйти» → `<Trans>Вийти</Trans>` (E2E `onboarding-logout.spec.ts` ассертит `toContainText('Выйти')` — переводится на шаблон I). «© {year} Cheeky Cheese IT. Все права защищены.» → `<Trans>© {year} Cheeky Cheese IT. Усі права захищено.</Trans>`.

- [ ] **Step 5: `UserProfileShell.tsx` (COPY-H-ppl-8, M-7)**

```tsx
// ветка ошибки загрузки
<h2 className="text-xl font-semibold">
  {is403 ? <Trans>Немає доступу до профілю</Trans> : <Trans>Профіль не знайдено</Trans>}
</h2>
<p className="max-w-sm text-sm text-muted-foreground">
  {is403 ? (
    <Trans>Якщо він потрібен для роботи, напишіть адміністратору</Trans>
  ) : (
    <Trans>Можливо, користувача архівовано — перевірте фільтр «В архіві» у списку</Trans>
  )}
</p>

// data-testid="profile-no-access" — тот же текст, что и для 403 (одна ситуация — один текст, M-7)
<p className="text-sm text-muted-foreground">
  <Trans>Немає доступу до профілю — якщо він потрібен для роботи, напишіть адміністратору</Trans>
</p>
```

Диалог несохранённых изменений: «Остаться» → `<Trans>Залишитися</Trans>` и остальные строки диалога — шаблон B/C. E2E `crm/contract-editor.spec.ts` и `crm/senior-resume.spec.ts` кликают `name: 'Остаться'` → шаблон I (строка «Остаться» в `senior-resume.spec.ts` — единственная правка PR1 в этой спеке).

- [ ] **Step 6: Реквизиты — `OverviewTab`, `RequisitesTab`, `RequisitesEditForm`, `ProfileEditFields` (COPY-M-ppl-10…13, L-4, H-2, H-3)**

- «Способ выплат», «Способ выплаты», `aria-label="Способ выплаты"` → везде «Спосіб виплати» / "Payout method" (M-10). «Реквизиты для выплат» → «Реквізити для виплат» / "Payout details".
- `RequisitesEditForm` — `disabledTooltip` и `TooltipContent`, две копии «SENIOR и ADMIN получают только в USDT ERC-20» (M-11): текст адресован самому человеку, одна `msg`-константа на обе копии:

```tsx
const USDT_ONLY_HINT = msg`Ви отримуєте виплати лише в USDT (мережа Ethereum) — змінити спосіб не можна`
// en: "You receive payouts in USDT (Ethereum network) only — the method cannot be changed"
const { i18n } = useLingui()
// …
disabledTooltip: i18n._(USDT_ONLY_HINT)
// …
<TooltipContent side="top">{i18n._(USDT_ONLY_HINT)}</TooltipContent>
```

- `OverviewTab` баннер `drop-requisites-missing-banner` (M-12): «Реквізити не заповнено» / «Без реквізитів ми не зможемо вам заплатити — вкажіть гаманець USDT або банківський рахунок».
- Пустые значения (L-4): «не указано» ×4, «Не указано», «Заметок нет» → одна `msg`-константа `NOT_SET = msg\`не вказано\`` в каждом из двух файлов (`OverviewTab`, `RequisitesTab`) — текст одинаковый, ключ в каталоге один.
- Заметка администратора (H-3): «Заметка администратора» → «Нотатка адміністратора»; «Админ увидит причину и сможет предложить другой процент» → «Адміністратор побачить причину і зможе запропонувати іншу частку» (глоссарий: «частка», не «відсоток»).
- Карточка «Пользовательское соглашение» (H-2) → «Умови використання», дата принятия — `formatDate(tosAcceptedAt, locale, 'short')` вместо `toLocaleDateString('ru-RU')`.
- Склейка `pendingSeniorShare` («Вашу долю по умолчанию предлагают изменить: сейчас {x}%, предлагают {y}%…», аудит B «сборка фразы из кусков JSX») → одна `<Trans>` со слотами `{current}` и `{proposed}`, без `{' '}`-стыков.
- Плейсхолдеры (M-13) — строго из таблицы канона: ФИО «Іваненко Іван Іванович», технологии «Почніть вводити: React, Node.js…».

- [ ] **Step 7: `FinanceTab.tsx` (COPY-H-ppl-9, M-5, M-14)**

```tsx
// карточка total-earned: ее видят только ADMIN/ACCOUNTANT на ЧУЖОМ профиле
<p className="text-xs uppercase tracking-wide text-muted-foreground">
  <Trans>Усього виплачено цій людині</Trans>
</p>
<p className="text-xs text-muted-foreground/70">
  <Trans>Сума всіх розрахунків з нею за весь час</Trans>
</p>
// en: "Total paid to this person" / "Sum of all settlements with them, all time"
```

`formatAmount(totalEarned.totalEarned, totalEarned.currency)` — привести к сигнатуре после #706 (если функция принимает `locale`, передать `useLocale()`).

Пустые состояния: «Транзакций пока нет» → «Транзакцій поки немає». Недостижимая ветка `hasActive ? 'Ничего не найдено' : 'Нет данных'` (M-5) удаляется: остаётся только текст канона «Нічого не знайдено — скиньте фільтри» (M-14). Чтобы мутационный гейт не счёл удаление потерей покрытия, добавить тест на ветку «фильтры активны и ничего не найдено».

`TYPE_OPTIONS`/`STATUS_OPTIONS` — внутрь компонента, `useMemo(() => Object.entries(TYPE_LABELS).map(…), [])` (см. «Опасность: карты финансов»).

- [ ] **Step 8: Контракт сотрудника — `ContractActionBar`, `ContractFillForm`, `ContractPdfPreview`, `MissingFieldsBanner`, `useEmployeeContract` (COPY-L-ppl-5)**

`useEmployeeContract.ts` — пять склеек вида ``toast.error(`Не удалось сохранить контракт: ${msg}`)``. Серверный текст больше не приклеивается к клиентскому (аудит B «шаблонная склейка»):

```ts
// было
onError: (err) => toast.error(`Не удалось сохранить контракт: ${extractMsg(err)}`)
// стало — хук вызывается из компонента, `t` берётся из useLingui() внутри хука
const { t } = useLingui()
onError: (err) => toast.error(getApiErrorMessage(err, t`Не вдалося зберегти контракт`))
```

Каждое из пяти мест получает свой фоллбэк по действию («зберегти», «позначити готовим до підписання», «скасувати» и т. д.). Серверный код, если есть, побеждает — так текст отказа совпадает с тем, что знает сервер.

`ContractPdfPreview.tsx` — `download` так же, как в `SignContractStep` (Step 4, одна и та же строка → один ключ).

- [ ] **Step 9: `AvatarUploadDialog.tsx` + `cropImage.ts` (COPY-M-ppl-8)**

```tsx
// было
setError(`Файл ${(file.size / 1024).toFixed(0)} KB — максимум 5 MB`)
// стало — обе величины одной функцией (formatBytes из @/lib/format-bytes после #706)
const locale = useLocale()
const size = formatBytes(file.size, locale)
const limit = formatBytes(AVATAR_MAX_BYTES, locale)
setError(t`Файл ${size} — максимум ${limit}, виберіть менший`)
```

`AVATAR_MAX_BYTES` — константа, которой файл сравнивает размер (не хардкодить `5 MB` во второй раз). Если её нет, завести `const AVATAR_MAX_BYTES = 5 * 1024 * 1024` рядом с проверкой и сравнивать с ней же.

`cropImage.ts`: `new Error('Не удалось создать canvas context')` → `new Error('canvas 2d context unavailable')`, `'Не удалось загрузить изображение'` → `'image failed to load'` (для разработчика, по-английски). В `AvatarUploadDialog` показ `err instanceof Error ? err.message : …` заменяется на свой текст `t\`Не вдалося обрізати зображення\``: сообщение `Error` пользователю не показывается.

Остальные строки файла — шаблоны B/C, многоточия `…`.

- [ ] **Step 10: Остальные файлы профиля**

`AdminActionsMenu.tsx` («Заметка админа» → «Нотатка адміністратора», E2E `admin-actions.spec.ts` — шаблон I), `AdminNoteDialog.tsx`, `ChangePersonalEmailDialog.tsx` (подписи и тосты; «личный email» → «особистий email» по канону), `ProfileCredentialsSection.tsx`, `DocumentsTab.tsx` («Документы появятся здесь (Phase 6)» → «Тут з’являться документи профілю» — без внутреннего названия этапа), `InterviewsTab.tsx` («Доска собеседований этого синьора» → «Дошка співбесід цього сеньйора», «Открыть Канбан» → «Відкрити дошку»), `ProjectsTab.tsx` (две даты → `formatDate(…, 'short')`, диапазон `{start}–{end}` через `<Trans>`), `NotificationSettingsTab.tsx` (`'Новый тип'` → `msg\`Новий тип сповіщень\``; `LOCKED_EXPLANATION`, `UNKNOWN_TYPE_EXPLANATION`— шаблон A; заголовки — «Опасность:`NOTIFICATION_TITLES`»), `routes/\_authenticated/onboarding/index.tsx`, `MissingFieldsBanner.tsx`.

Финальная проверка файлов PR1 (продуктовые файлы онбординга и профиля, кроме `resume/` — PR3 — и `ArchiveUserDialog.tsx` — PR2):

```bash
python3 - <<'EOF'
import re, pathlib
roots = ['apps/web/app/components/onboarding', 'apps/web/app/routes/_authenticated/onboarding',
         'apps/web/app/components/user-profile']
skip = re.compile(r'__tests__|\.(spec|test)\.|/resume/|ArchiveUserDialog\.tsx$')
enum = re.compile(r'\b(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)\b')
code = re.compile(r"===|!==|case |: Role|Role\[|z\.enum|role ===|\.role\b|'(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)'")
for root in roots:
    for f in sorted(pathlib.Path(root).rglob('*.ts*')):
        if skip.search(str(f)):
            continue
        for n, l in enumerate(f.read_text(encoding='utf8').splitlines(), 1):
            if re.match(r'\s*(//|\*|\{/\*)', l):
                continue
            if re.search('[ыЫэЭъЪёЁ]', l):
                print('RU  ', f, n, l.strip())
            if enum.search(l) and not code.search(l):
                print('ENUM', f, n, l.strip())
EOF
```

Строк `RU` быть не должно. Строки `ENUM` разобрать по одной: видимый текст с enum — недоделка, идентификатор в коде (ключ карты, тип) — норма.

- [ ] **Step 11: Тесты, E2E-свип, гейты, коммит**

Каждый тест-файл из списка Files: литерал → каталог (`loadCatalog('uk')`, для ключевых экранов — ещё и кейс `en`). E2E-свип (общий шаг) → строки спек из «Распределения» и вывода скрипта.

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/shared test
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- admin-actions contract-editor mobile-keyboard-attributes senior-resume onboarding-logout profile-self-edit requisites-warning onboarding-regression-pr110 notification-settings
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add CONTEXT.md \
  apps/web/app/components/onboarding/AcceptTosStep.tsx \
  apps/web/app/components/onboarding/AcceptTosStep.spec.tsx \
  apps/web/app/components/onboarding/ContractWaitScreen.tsx \
  apps/web/app/components/onboarding/SignContractStep.tsx \
  apps/web/app/components/onboarding/SignContractStep.spec.tsx \
  apps/web/app/components/onboarding/TosUpdateBanner.tsx \
  apps/web/app/routes/_authenticated/onboarding/index.tsx \
  apps/web/app/routes/_authenticated/onboarding/route.tsx \
  apps/web/app/components/user-profile/AvatarUploadDialog.tsx \
  apps/web/app/components/user-profile/ProfileCredentialsSection.tsx \
  apps/web/app/components/user-profile/UserProfileHeader.tsx \
  apps/web/app/components/user-profile/UserProfileShell.tsx \
  apps/web/app/components/user-profile/cropImage.ts \
  apps/web/app/components/user-profile/admin-actions/AdminActionsMenu.tsx \
  apps/web/app/components/user-profile/admin-actions/AdminNoteDialog.tsx \
  apps/web/app/components/user-profile/admin-actions/ChangePersonalEmailDialog.tsx \
  apps/web/app/components/user-profile/contract/ContractActionBar.tsx \
  apps/web/app/components/user-profile/contract/ContractFillForm.tsx \
  apps/web/app/components/user-profile/contract/ContractPdfPreview.tsx \
  apps/web/app/components/user-profile/contract/ContractTab.tsx \
  apps/web/app/components/user-profile/contract/MissingFieldsBanner.tsx \
  apps/web/app/components/user-profile/contract/useEmployeeContract.ts \
  apps/web/app/components/user-profile/self-edit/ProfileEditFields.tsx \
  apps/web/app/components/user-profile/self-edit/RequisitesEditForm.tsx \
  apps/web/app/components/user-profile/tabs/DocumentsTab.tsx \
  apps/web/app/components/user-profile/tabs/FinanceTab.tsx \
  apps/web/app/components/user-profile/tabs/InterviewsTab.tsx \
  apps/web/app/components/user-profile/tabs/NotificationSettingsTab.tsx \
  apps/web/app/components/user-profile/tabs/OverviewTab.tsx \
  apps/web/app/components/user-profile/tabs/ProjectsTab.tsx \
  apps/web/app/components/user-profile/tabs/RequisitesTab.tsx \
  apps/web/app/components/user-profile/tabs/TeamTab.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileHeader.test.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileShell.drop-redirect.test.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileShell.notifications-tab.test.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/AdminActionsMenu.change-personal-email.test.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/AdminActionsMenu.resend-invite.test.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/ChangePersonalEmailDialog.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractActionBar.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractEditor.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractFillForm.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractPdfPreview.test.tsx \
  apps/web/app/components/user-profile/contract/__tests__/ContractTab.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/FinanceTab.total-earned.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/NotificationSettingsTab.grouping.test.ts \
  apps/web/app/components/user-profile/tabs/__tests__/NotificationSettingsTab.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/OverviewTab.pending-share.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/OverviewTab.share-card.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/OverviewTab.tos.test.tsx \
  apps/web/app/components/user-profile/tabs/__tests__/TeamTab.empty-state.test.tsx \
  packages/shared/src/schemas/contracts.ts \
  packages/shared/src/schemas/contracts.spec.ts \
  packages/shared/src/schemas/tos.ts \
  packages/shared/src/schemas/tos.spec.ts \
  packages/shared/src/schemas/notification-preferences.ts \
  packages/shared/src/schemas/notification-preferences.spec.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/admin-actions.spec.ts \
  apps/e2e/tests/crm/contract-editor.spec.ts \
  apps/e2e/tests/crm/mobile-keyboard-attributes.spec.ts \
  apps/e2e/tests/crm/senior-resume.spec.ts \
  apps/e2e/tests/onboarding-logout.spec.ts \
  apps/e2e/tests/profile-self-edit.spec.ts \
  apps/e2e/tests/requisites-warning.spec.ts
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,shared,i18n): stage 3b wave (b) part 1 — onboarding and profile to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9,10 (11 — reviews after push)
EOF
)"
```

Список `git add` — верхняя граница. Файл, который не понадобилось менять (тест без русских ассертов), `git add` просто не затронет.

**Design tier 2.** Скриншоты 320 и 1440 × `uk` и `en`: онбординг (ToS, ожидание контракта, подписание — обычное, без юр. ПІБ, «войти как»), профиль (шапка, «Огляд», «Фінанси» глазами ADMIN, «Реквізити» с отключённой вкладкой, «Команда», «Контракт» без шаблона, «Сповіщення»), диалоги (аватар с ошибкой размера, заметка, смена личного email, несохранённые изменения). Fidelity Mode B — на всех ширинах из Global Constraints. `copy-reviewer` — вердикт по `uk` и `en` отдельно. `security-reviewer` — обязателен (реквизиты, кошелёк, карточка выплат, маскировка `TeamTab`).

---

## Task 2 (PR2): список пользователей, команды, архивация пользователя

**Files:**

| Файл                                                                             | Кир. строк | Паттерн(ы)    | Находки аудита / примечание                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/_authenticated/team/$teamId.tsx`                                         | 78 / 73    | A, B, C, F, H | Локальная копия `ROLE_LABELS` удаляется (шаблон H); COPY-M-ppl-2 («Ошибка добавления», «Не удалось обновить команду»), M-14; дата создания — `formatDate(…, 'long')`; две `localeCompare` → `compareNames` |
| `routes/_authenticated/team/index.tsx`                                           | 45 / 41    | B, C, D       | COPY-H-ppl-1 (`Сортування` в `uk` правильно, а `en` — "Sort by"), M-2 («Ошибка при создании»), M-13 (подсказка технологий), M-14; `localeCompare` → `compareNames`                                         |
| `components/users/ArchiveConfirmDialog.tsx` → **`ArchiveUserConfirmDialog.tsx`** | 34 / 33    | B, C          | **Отложенный пункт 3** (переименование); COPY-H-ppl-6 (жаргон `senior+team`, `cascade`, `JUNIOR`), M-2 («Ошибка при архивации»), L-1, «{n} шт.» (аудит B) — уходит вместе с `ImpactWarning`                |
| `routes/_authenticated/users/index.tsx`                                          | 24 / 22    | B, C, H       | Фильтр ролей — шаблон H; «Пользователи не найдены» (M-14), «Все роли»                                                                                                                                      |
| `components/users/RejoinTeamDialog.tsx`                                          | 19 / 18    | B, C          | COPY-L-ppl-3 («Готово» / «Сохранение...» → «Зберегти» / «Збереження…»), M-6 («Нет доступных…»)                                                                                                             |
| `components/users/UserRow.tsx`                                                   | 10 / 9     | B, F, H       | `ROLE_LABELS` → `useRoleLabel`; `date-fns` + `ru` → `formatRelativeTime(createdAt, locale)`                                                                                                                |
| `components/users/HrChipsField.tsx`                                              | 9 / 8      | B, C          | COPY-M-ppl-6 («Нет доступных HR» → «Немає вільних HR — створіть HR у розділі «Команда»»)                                                                                                                   |
| `components/users/AccountantChipField.tsx`                                       | 8 / 8      | B, C          | COPY-M-ppl-6 (то же для бухгалтеров)                                                                                                                                                                       |
| `components/user-profile/admin-actions/ArchiveUserDialog.tsx`                    | 5 / 5      | B, C          | Импорт `ImpactWarning` → `UserArchiveImpact`                                                                                                                                                               |
| `components/users/CreateWizardStepper.tsx`                                       | 4 / 4      | B             | —                                                                                                                                                                                                          |
| `components/archive/ArchiveConfirmDialog.tsx`                                    | уже `uk`   | —             | **Отложенный пункт 2**: COPY-L-31, COPY-L-32; ветка пользователя уходит в `UserArchiveImpact`; «інвойси» → «рахунки» (глоссарий **Счёт**) в ветке проекта                                                  |
| `components/archive/UserArchiveImpact.tsx`                                       | новый      | B, D, E       | Единственный источник текста влияния архивации пользователя                                                                                                                                                |

`components/users/constants.ts` в PR2 **не трогается**: его `ROLE_LABELS` ещё читает `UserDialog.tsx` (PR3). После PR2 у легаси остаётся один потребитель.

Тесты: `components/users/__tests__/ArchiveConfirmDialog.test.tsx` (36) → `git mv` в `ArchiveUserConfirmDialog.test.tsx`; `components/user-profile/admin-actions/__tests__/ArchiveUserDialog.test.tsx` (11); `components/users/__tests__/{CreateWizardStepper.test.tsx (3), ProfileNameLink.test.tsx (4), RejoinTeamDialog.schema-translation.test.tsx (2), UserRow.test.tsx (1)}`; `components/archive/__tests__/ArchiveConfirmDialog.test.tsx`. Новый: `components/archive/__tests__/UserArchiveImpact.test.tsx`. `apps/web/app/__tests__/support/mobile-keyboard-registry.ts` ссылается на testid `archive-confirm-name-input` — testid сохраняется, файл не меняется.

E2E: см. «Распределение E2E-спек», строка PR2, плюс вывод свипа.

**Interfaces:**

- Consumes: `useRoleLabel`, `ROLE_LABEL_MESSAGES` (`@/components/ui/role-select`); `formatRelativeTime(value, locale)`, `formatDate`, `compareNames` (`@crm/shared`); `useLocale()`; `getApiErrorMessage`, `translateZodCode`, `translateZodMessage` (`@/lib/axios-utils`); `ArchiveImpact` (`@crm/shared`); тестовые хелперы каталога.
- Produces:
  - `export function UserArchiveImpact(props: { entityName: string; impact: Extract<ArchiveImpact, { type: 'user' }> }): JSX.Element` — `components/archive/UserArchiveImpact.tsx`. Рендерит обёртку с `data-testid` по роли (`archive-warning-senior` для `SENIOR` и `DROP`, `archive-warning-hr`, `archive-warning-accountant`, `archive-warning-junior`, `archive-warning-admin`) и имя в `<strong data-testid="archive-confirm-user-name">`. Эти testid уже ассертят 5 E2E-спек и 2 unit-файла — они не меняются.
  - `export function ArchiveUserConfirmDialog(props: { user: UserProfileDto | null; onClose: () => void }): JSX.Element` — `components/users/ArchiveUserConfirmDialog.tsx` (бывший `components/users/ArchiveConfirmDialog.tsx`, поведение и testid `archive-confirm-dialog`, `archive-confirm-name-input`, `archive-confirm-submit` без изменений).
  - Удаляются: `components/users/ArchiveConfirmDialog.tsx` (как имя файла) и экспорт `ImpactWarning`.

### Опасность: два `ArchiveConfirmDialog` — переименовать и поделить текст, но не сливать диалоги

Слить два диалога в один `components/archive/ArchiveConfirmDialog` (`entityType='user'`) было бы красивее, но это меняет поведение деструктивного действия. Они различаются не только текстом:

| Свойство                   | `components/users/…` (список `/users`)                               | `components/archive/…` (`entityType='user'`) |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Мутация и инвалидация кэша | своя: `['users-admin']`, для SENIOR/DROP ещё `teams` и `projects`    | `useArchiveEntity('user', id)`               |
| Тосты успеха               | по роли («Сеньйор і команда архівовані»…)                            | общий хук                                    |
| testid                     | `archive-confirm-dialog`, `archive-confirm-name-input`               | `archive-confirm-input`                      |
| Закрытие во время запроса  | запрещено (Escape, оверлей, «Отмена») — security-review #584 раунд 3 | не запрещено                                 |
| Enter подтверждает         | да                                                                   | нет                                          |

Слияние потянуло бы правку 5 E2E-спек и снятие защиты, которую security-review #584 ставил осознанно. Поэтому в этой волне: **общий текст** (`UserArchiveImpact`) плюс **разные имена** (`ArchiveUserConfirmDialog`). Слияние диалогов, если оно нужно, — отдельная задача с `security-reviewer` (строка в «Находках вне периметра»).

### Acceptance criteria (PR2)

1. `components/archive/UserArchiveImpact.tsx` — единственный источник текста влияния архивации пользователя; его рендерят `components/archive/ArchiveConfirmDialog`, `ArchiveUserConfirmDialog` и `ArchiveUserDialog`; testid `archive-warning-*` и `archive-confirm-user-name` сохранены.
2. COPY-L-31 и COPY-L-32 закрыты, «з N команд/проєктів» — в родительном падеже, «інвойси» → «рахунки»; тесты `UserArchiveImpact` зелёные на `uk` и `en`.
3. `components/users/ArchiveConfirmDialog.tsx` переименован в `ArchiveUserConfirmDialog.tsx`, `ImpactWarning` удалён; поведение (инвалидация, запрет закрытия во время запроса, Enter, testid) не изменилось — существующие тесты диалога зелёные без правки логики.
4. `UserRow`, `users/index.tsx`, `team/$teamId.tsx` показывают роли из `ROLE_LABEL_MESSAGES`; локальная карта `ROLE_LABELS` в `$teamId.tsx` удалена; `date-fns/locale`, `toLocale*('ru-RU')` и `localeCompare` в файлах PR2 заменены на `format.ts`.
5. Закрыты COPY-H-ppl-1, H-6, M-2 (в файлах PR2), M-6 (чипы), M-13 (`team/index`), M-14 (`users/index`, `team/*`), L-3.
6. В файлах PR2 0 строк с `[ыэъё]` вне комментариев (проверка в Step 7).
7. Unit-тесты ассертят текст из каталога; E2E-свип выполнен, таблица в теле PR; E2E спек PR2 зелёные.
8. `pnpm i18n:extract` дважды — пустой дифф; в `en` 0 пустых `msgstr`.
9. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` зелёный.
10. Design tier 2, fidelity Mode B на всех ширинах, скриншоты 320/1440 × `uk`/`en`; `copy-reviewer` PASS по `uk` и `en` (с отдельной строкой по L-31/L-32); `security-reviewer` APPROVE.

- [ ] **Step 0: Замер и предусловия**

```bash
git rev-parse --show-toplevel
git fetch origin main && gh pr view 706 --json state -q .state     # MERGED
git grep -c -P '[А-Яа-яЁё]' origin/main -- apps/web/app/components/users apps/web/app/routes/_authenticated/team apps/web/app/routes/_authenticated/users
git grep -n "ArchiveConfirmDialog'" origin/main -- apps/web/app    # потребители обоих диалогов — сверить с таблицей
```

Канон терминов — из этого плана (PR1 заносит его в `CONTEXT.md` параллельно; если PR1 уже смёржен, читать `CONTEXT.md`).

- [ ] **Step 1: Тест `UserArchiveImpact` (падает)**

```tsx
// apps/web/app/components/archive/__tests__/UserArchiveImpact.test.tsx (новый)
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ArchiveImpact } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UserArchiveImpact } from '../UserArchiveImpact'

type UserImpact = Extract<ArchiveImpact, { type: 'user' }>
const base = { type: 'user' as const, pendingTransactions: [] }

const cases: Array<[string, UserImpact]> = [
  [
    'archive-warning-senior',
    {
      ...base,
      role: 'SENIOR',
      teamName: 'Alpha',
      projectsCount: 2,
      projectNames: ['P1', 'P2'],
      hrAccountantsOnTeam: 1,
      juniorsAffected: 3,
    },
  ],
  ['archive-warning-senior', { ...base, role: 'DROP', teamName: null, projectsCount: 1 }],
  ['archive-warning-hr', { ...base, role: 'HR', teamsCount: 5 }],
  ['archive-warning-accountant', { ...base, role: 'ACCOUNTANT', teamsCount: 1 }],
  ['archive-warning-junior', { ...base, role: 'JUNIOR', projectsCount: 2 }],
  ['archive-warning-admin', { ...base, role: 'ADMIN' }],
]

describe('UserArchiveImpact', () => {
  it.each(cases)(
    '%s renders for role, keeps the name testid, no raw enum or jargon',
    async (testId, impact) => {
      for (const locale of ['uk', 'en'] as const) {
        await loadCatalog(locale)
        const { unmount } = render(
          <UserArchiveImpact entityName="Олена Коваль" impact={impact} />,
          {
            wrapper: I18nTestProvider,
          },
        )
        const block = screen.getByTestId(testId)
        expect(screen.getByTestId('archive-confirm-user-name')).toHaveTextContent('Олена Коваль')
        expect(block.textContent).not.toMatch(
          /\b(SENIOR|JUNIOR|ACCOUNTANT|DROP|ADMIN)\b|senior\+team|cascade/,
        )
        unmount()
      }
    },
  )

  it('COPY-L-32: uk text never agrees with the person’s gender (no «архівований»/«архівована»)', async () => {
    await loadCatalog('uk')
    for (const [, impact] of cases) {
      const { container, unmount } = render(
        <UserArchiveImpact entityName="Олена" impact={impact} />,
        {
          wrapper: I18nTestProvider,
        },
      )
      expect(container.textContent).not.toMatch(/архівован(ий|а)/)
      unmount()
    }
  })

  it('COPY-L-31: the SENIOR/DROP branch without a team still says it can be restored', async () => {
    await loadCatalog('uk')
    render(<UserArchiveImpact entityName="Олена" impact={cases[1][1]} />, {
      wrapper: I18nTestProvider,
    })
    expect(screen.getByTestId('archive-warning-senior')).toHaveTextContent('Відновлення можливе')
  })

  it('HR/JUNIOR counts after «з» are genitive in uk (1 команди, 5 команд, 2 активних проєктів)', async () => {
    await loadCatalog('uk')
    const { rerender } = render(
      <UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'HR', teamsCount: 1 }} />,
      { wrapper: I18nTestProvider },
    )
    expect(screen.getByTestId('archive-warning-hr')).toHaveTextContent('з 1 команди')
    rerender(
      <UserArchiveImpact entityName="Олена" impact={{ ...base, role: 'HR', teamsCount: 5 }} />,
    )
    expect(screen.getByTestId('archive-warning-hr')).toHaveTextContent('з 5 команд')
    rerender(
      <UserArchiveImpact
        entityName="Олена"
        impact={{ ...base, role: 'JUNIOR', projectsCount: 2 }}
      />,
    )
    expect(screen.getByTestId('archive-warning-junior')).toHaveTextContent('з 2 активних проєктів')
  })
})
```

Run: `pnpm --filter @crm/web test -- UserArchiveImpact` → FAIL (модуля нет).

- [ ] **Step 2: `UserArchiveImpact.tsx` + COPY-L-31, COPY-L-32 (отложенный пункт 2) → PASS**

Переносится ветка `entityType === 'user'` из `renderImpactText` (`components/archive/ArchiveConfirmDialog.tsx`), с тремя правками текста:

1. **COPY-L-32** — пять строк «<ім’я> буде архівований …» переписываются безродно, по идиоме, которая уже есть в соседней ветке («В архів підуть: …»): «В архів піде профіль <ім’я> …». Подлежащее — «профіль» (мужской род), значит от пола человека текст больше не зависит.
2. **COPY-L-31** — ветка SENIOR/DROP без команды получает строку об обратимости.
3. **Родительный падеж после «з»** (найдено при подготовке плана): сейчас `<Plural one="# команда">` стоит после «прибраний з», и выходит «з 1 команда». После предлога нужен родительный: `one="# команди" few="# команд" many="# команд" other="# команди"`; для проектов — `one="# активного проєкту" few="# активних проєктів" many="# активних проєктів" other="# активного проєкту"`.

```tsx
// apps/web/app/components/archive/UserArchiveImpact.tsx
import type { ArchiveImpact } from '@crm/shared'
import { select } from '@lingui/core/macro'
import { Plural, Trans } from '@lingui/react/macro'

type UserImpact = Extract<ArchiveImpact, { type: 'user' }>

const TESTID_BY_ROLE: Record<UserImpact['role'], string> = {
  SENIOR: 'archive-warning-senior',
  DROP: 'archive-warning-senior',
  HR: 'archive-warning-hr',
  ACCOUNTANT: 'archive-warning-accountant',
  JUNIOR: 'archive-warning-junior',
  ADMIN: 'archive-warning-admin',
}

/** Single source of the "what archiving this person changes" copy — rendered by
 *  `components/archive/ArchiveConfirmDialog` (entityType='user'),
 *  `components/users/ArchiveUserConfirmDialog` and
 *  `user-profile/admin-actions/ArchiveUserDialog`. Gender-neutral by construction
 *  (the subject is «профіль», COPY-L-32). */
export function UserArchiveImpact({
  entityName,
  impact,
}: {
  entityName: string
  impact: UserImpact
}) {
  return <div data-testid={TESTID_BY_ROLE[impact.role]}>{renderBody(entityName, impact)}</div>
}

/** Inside <Trans> this becomes a numbered component slot (<0>…</0>), so the name keeps
 *  its markup and testid in every locale without being glued outside the sentence. */
function Name({ children }: { children: React.ReactNode }) {
  return (
    <strong className="text-foreground" data-testid="archive-confirm-user-name">
      {children}
    </strong>
  )
}

function renderBody(entityName: string, impact: UserImpact): React.ReactNode {
  const projectNames = impact.projectNames ?? []
  const namesSuffix = projectNames.length > 0 ? `: ${projectNames.join(', ')}` : ''

  if (impact.role === 'SENIOR' || impact.role === 'DROP') {
    if (!impact.teamName) {
      return (
        <>
          <Trans>
            В архів піде профіль <Name>{entityName}</Name> разом з усіма проєктами (
            <Plural
              value={impact.projectsCount ?? 0}
              one="# проєкт"
              few="# проєкти"
              many="# проєктів"
              other="# проєкту"
            />
            {namesSuffix}).
          </Trans>{' '}
          <Trans>Відновлення можливе — профіль повернеться, але проєкти відновлювати окремо.</Trans>
        </>
      )
    }
    // Stryker disable next-line ObjectLiteral,StringLiteral: Lingui's select() macro must read this options object as a literal at compile time (the `{}` mutant makes the transform throw before any test runs); `other` is unreachable inside the SENIOR|DROP guard
    const roleGenitive = select(impact.role, {
      SENIOR: 'сеньйора',
      DROP: 'дропа',
      other: 'співробітника',
    })
    // Stryker disable next-line ObjectLiteral,StringLiteral: same literal-options requirement and the same unreachable `other` as roleGenitive above
    const pairWord = select(impact.role, { SENIOR: 'сеньйор', DROP: 'дроп', other: 'співробітник' })
    return (
      <>
        <Trans>
          <Name>{entityName}</Name> та команда «<strong>{impact.teamName}</strong>» — пов’язана
          пара, прибрати по одному не можна. В архів підуть: профіль {roleGenitive}, команда і всі
          її проєкти (
          <Plural
            value={impact.projectsCount ?? 0}
            one="# проєкт"
            few="# проєкти"
            many="# проєктів"
            other="# проєкту"
          />
          {namesSuffix}).
        </Trans>{' '}
        <Trans>
          HR/бухгалтери в команді (
          <Plural
            value={impact.hrAccountantsOnTeam ?? 0}
            one="# HR/бухгалтер"
            few="# HR/бухгалтери"
            many="# HR/бухгалтерів"
            other="# HR/бухгалтера"
          />
          ) і джуніори на цих проєктах (
          <Plural
            value={impact.juniorsAffected ?? 0}
            one="# джуніор"
            few="# джуніори"
            many="# джуніорів"
            other="# джуніора"
          />
          ) залишаються активними учасниками і продовжують отримувати оплату — архівація команди й
          проєктів їх не стосується.
        </Trans>{' '}
        <Trans>
          Відновлення можливе — пара «{pairWord}+команда» повернеться, але проєкти відновлювати
          окремо.
        </Trans>
      </>
    )
  }

  if (impact.role === 'HR') {
    return (
      <Trans>
        В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
        <strong>
          <Plural
            value={impact.teamsCount ?? 0}
            one="# команди"
            few="# команд"
            many="# команд"
            other="# команди"
          />
        </strong>{' '}
        (роль HR). Самі команди залишаться активними.
      </Trans>
    )
  }

  if (impact.role === 'ACCOUNTANT') {
    return (
      <Trans>
        В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
        <strong>
          <Plural
            value={impact.teamsCount ?? 0}
            one="# команди"
            few="# команд"
            many="# команд"
            other="# команди"
          />
        </strong>{' '}
        (роль бухгалтера). Самі команди залишаться активними.
      </Trans>
    )
  }

  if (impact.role === 'JUNIOR') {
    return (
      <Trans>
        В архів піде профіль <Name>{entityName}</Name>; його буде прибрано з{' '}
        <strong>
          <Plural
            value={impact.projectsCount ?? 0}
            one="# активного проєкту"
            few="# активних проєктів"
            many="# активних проєктів"
            other="# активного проєкту"
          />
        </strong>
        . Самі проєкти залишаться активними.
      </Trans>
    )
  }

  // ADMIN — the only remaining member of the role union.
  return (
    <Trans>
      В архів піде профіль <Name>{entityName}</Name>. Нічого пов’язаного архівувати не треба.
    </Trans>
  )
}
```

Текст ветки «пара + команда» перенесён из `renderImpactText` дословно, с двумя правками: `other` у `<Plural>` — форма для дробных чисел (родительный единственного: «проєкту», «джуніора»), как требует `uk` CLDR; «команди/проєктів» → «команди й проєктів» вместо `/` в тексте. Если ревью текста #700 закрепило `other` иначе, оставить как в каталоге — это вопрос `copy-reviewer`, а не этого плана.

`en` (второй оригинал, черновик для `copy-reviewer`): "{name}’s profile will be archived together with all their projects (…)", "Restoring is possible — the profile comes back, but projects must be restored separately.", "{name}’s profile will be archived and removed from {n, plural, one {# team} other {# teams}} (HR role). The teams themselves stay active."

Комментарии `// Stryker disable` в новом файле — только с причиной на той же строке (гард). Существующие подавления из `renderImpactText` переносятся вместе с кодом, текст причины не теряется.

Ветки `ACCOUNTANT`, `JUNIOR`, `ADMIN` и продолжение ветки SENIOR/DROP с командой исполнитель пишет полностью по образцу выше. Комментарий `// …далее` в итоговом коде не остаётся — он стоит только в плане.

В `components/archive/ArchiveConfirmDialog.tsx`:

```tsx
if (entityType === 'user' && impact.type === 'user') {
  return <UserArchiveImpact entityName={entityName} impact={impact} />
}
```

Там же, в ветке `project`: «Фінансова історія (транзакції, інвойси)» → «(транзакції, рахунки)» — глоссарий **Счёт**, «інвойс» в `_Избегать_`. Существующий `components/archive/__tests__/ArchiveConfirmDialog.test.tsx` для пользовательских веток переходит на testid из `UserArchiveImpact`.

Run: `pnpm --filter @crm/web test -- UserArchiveImpact archive/__tests__/ArchiveConfirmDialog` → PASS.

- [ ] **Step 3: Переименование `components/users/ArchiveConfirmDialog` → `ArchiveUserConfirmDialog` (отложенный пункт 3)**

```bash
git mv apps/web/app/components/users/ArchiveConfirmDialog.tsx apps/web/app/components/users/ArchiveUserConfirmDialog.tsx
git mv apps/web/app/components/users/__tests__/ArchiveConfirmDialog.test.tsx apps/web/app/components/users/__tests__/ArchiveUserConfirmDialog.test.tsx
```

В файле: `export function ArchiveConfirmDialog` → `export function ArchiveUserConfirmDialog`; тело `ImpactWarning` удаляется целиком (вместе с «{projectsCount} шт.», `senior+team`, `cascade`, `JUNIOR` — COPY-H-ppl-6) и заменяется на `impact?.type === 'user' ? <UserArchiveImpact entityName={user.displayName} impact={impact} /> : null`. Остальной текст — шаблоны B/C:

| Было                                                           | `uk`                                                                                                                             | `en`                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| «Архивировать пользователя»                                    | Архівувати користувача                                                                                                           | Archive user                                                            |
| «Для подтверждения введите имя:»                               | Для підтвердження введіть ім’я:                                                                                                  | To confirm, type the name:                                              |
| «Отмена» / «Архивировать» / «Архивация...»                     | Скасувати / Архівувати / Архівуємо…                                                                                              | Cancel / Archive / Archiving…                                           |
| Тосты успеха по роли                                           | `select(role, { SENIOR: 'Сеньйора й команду архівовано', DROP: 'Дропа й команду архівовано', other: 'Користувача архівовано' })` | `Senior and team archived` / `Drop and team archived` / `User archived` |
| `err?.response?.data?.message ?? 'Ошибка при архивации'` (M-2) | `getApiErrorMessage(err, t\`Не вдалося архівувати користувача — спробуйте ще раз\`)`                                             | Could not archive the user — try again                                  |

Тост успеха собран так, что роль стоит в винительном падеже внутри `select` (урок п.9): «Сеньйора й команду архівовано» — безличная форма, от пола не зависит. `select` берёт `user.role`, до которого доходят все шесть значений, поэтому ветка `other` здесь достижима (HR, ACCOUNTANT, JUNIOR, ADMIN) — тест прогоняет все шесть значений.

Импорты: `routes/_authenticated/users/index.tsx` → `import { ArchiveUserConfirmDialog } from '@/components/users/ArchiveUserConfirmDialog'`; `user-profile/admin-actions/ArchiveUserDialog.tsx` → `import { UserArchiveImpact } from '@/components/archive/UserArchiveImpact'` вместо `ImpactWarning`, плюс миграция его пяти строк. Проверка: `git grep -n "components/users/ArchiveConfirmDialog\|ImpactWarning" -- apps/web` → пусто.

- [ ] **Step 4: `UserRow.tsx`, `routes/_authenticated/users/index.tsx`**

`UserRow`: шаблон H (одно значение) и `formatRelativeTime(user.createdAt, locale)` вместо `formatDistanceToNow(…, { locale: ru })` (импорты `date-fns` и `date-fns/locale` удаляются). «В архиве» → «В архіві».

`users/index.tsx`: фильтр ролей — шаблон H (список); «Все роли» → «Усі ролі»; «Пользователи не найдены» → текст канона «Нічого не знайдено — скиньте фільтри». Если «Пользователи не найдены» показывается и при пустой базе без фильтров, ветки разделить: без фильтров — «Користувачів поки немає».

- [ ] **Step 5: Команды — `team/index.tsx`, `team/$teamId.tsx`**

`team/index.tsx`: `placeholder="Сортування"` (COPY-H-ppl-1) → `t\`Сортування\``(слово в`uk`верное,`en`— "Sort by"). «Ошибка при создании» (M-2) →`getApiErrorMessage(err, t\`Не вдалося створити команду — спробуйте ще раз\`)`. «Ничего не найдено» (M-14) → канон. Подсказка технологий (M-13) → канон. `a.name.localeCompare(b.name)`→`compareNames(locale)(a.name, b.name)`.

`team/$teamId.tsx`: локальный `const ROLE_LABELS` удаляется; два места `{ROLE_LABELS[x.role] ?? x.role}` → шаблон H. `ROLE_VARIANT` остаётся (это не текст). «Создана {дата}» → `<Trans>Створено {createdAt}</Trans>` с `formatDate(team.createdAt, locale, 'long')`. «Ошибка добавления» → `getApiErrorMessage(err, t\`Не вдалося додати учасника — спробуйте ще раз\`)`; «Не удалось обновить команду» → `getApiErrorMessage(err, t\`Не вдалося оновити команду — спробуйте ще раз\`)`(M-2). «Нет доступных пользователей» (M-14) — если это результат поиска, то канон «Нічого не знайдено — скиньте фільтри»; если список кандидатов пуст без поиска — «Немає користувачів, яких можна додати». Две`localeCompare`→`compareNames`.

- [ ] **Step 6: Чипы и диалоги — `HrChipsField`, `AccountantChipField`, `RejoinTeamDialog`, `CreateWizardStepper`**

COPY-M-ppl-6: «Нет доступных HR» → «Немає вільних HR — створіть HR у розділі «Команда»» / "No HR available — create one in the Team section"; то же для бухгалтеров. COPY-L-ppl-3 (`RejoinTeamDialog`): `{mutation.isPending ? 'Сохранение...' : 'Готово'}` → `{mutation.isPending ? <Trans>Збереження…</Trans> : <Trans>Зберегти</Trans>}`.

- [ ] **Step 7: Тесты, E2E-свип, гейты, коммит**

E2E: бейджи в строке (`users.spec.ts` «Администратор», «Синьор»; `crm/users/users-refactor.spec.ts` бейдж) → шаблон I с «Адміністратор», «Сеньйор»; фильтр `users.spec.ts` «Все роли»/«Джун» → «Усі ролі»/«Джуніор» через каталог; `team.spec.ts` (31 строка) и архивные спеки — по свипу. Клики `user-dialog-role-trigger` → «Синьор» **не трогать**: это `UserDialog`, PR3.

Проверка файлов PR2 (строк быть не должно):

```bash
python3 - <<'EOF'
import re, pathlib
files = ['apps/web/app/components/archive/UserArchiveImpact.tsx',
         'apps/web/app/components/archive/ArchiveConfirmDialog.tsx',
         'apps/web/app/components/users/ArchiveUserConfirmDialog.tsx',
         'apps/web/app/components/users/AccountantChipField.tsx',
         'apps/web/app/components/users/HrChipsField.tsx',
         'apps/web/app/components/users/CreateWizardStepper.tsx',
         'apps/web/app/components/users/RejoinTeamDialog.tsx',
         'apps/web/app/components/users/UserRow.tsx',
         'apps/web/app/components/user-profile/admin-actions/ArchiveUserDialog.tsx',
         'apps/web/app/routes/_authenticated/users/index.tsx',
         'apps/web/app/routes/_authenticated/team/index.tsx',
         'apps/web/app/routes/_authenticated/team/$teamId.tsx']
for f in files:
    for n, l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(), 1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f, n, l.strip())
EOF
```

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- users users-refactor team team-archive drop-archive-real drop-archive-user-real drop-archive-cascade senior-archive-regression drop-rotate-senior polish-regressions drop-add-senior drop-create drop-create-ui-regressions senior-create-default
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
git add \
  apps/web/app/components/archive/UserArchiveImpact.tsx \
  apps/web/app/components/archive/ArchiveConfirmDialog.tsx \
  apps/web/app/components/archive/__tests__/UserArchiveImpact.test.tsx \
  apps/web/app/components/archive/__tests__/ArchiveConfirmDialog.test.tsx \
  apps/web/app/components/users/ArchiveUserConfirmDialog.tsx \
  apps/web/app/components/users/__tests__/ArchiveUserConfirmDialog.test.tsx \
  apps/web/app/components/users/AccountantChipField.tsx \
  apps/web/app/components/users/HrChipsField.tsx \
  apps/web/app/components/users/CreateWizardStepper.tsx \
  apps/web/app/components/users/RejoinTeamDialog.tsx \
  apps/web/app/components/users/UserRow.tsx \
  apps/web/app/components/users/__tests__/CreateWizardStepper.test.tsx \
  apps/web/app/components/users/__tests__/ProfileNameLink.test.tsx \
  apps/web/app/components/users/__tests__/RejoinTeamDialog.schema-translation.test.tsx \
  apps/web/app/components/users/__tests__/UserRow.test.tsx \
  apps/web/app/components/user-profile/admin-actions/ArchiveUserDialog.tsx \
  apps/web/app/components/user-profile/admin-actions/__tests__/ArchiveUserDialog.test.tsx \
  apps/web/app/routes/_authenticated/users/index.tsx \
  apps/web/app/routes/_authenticated/team/index.tsx \
  "apps/web/app/routes/_authenticated/team/\$teamId.tsx" \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/crm/team/team-archive.spec.ts \
  apps/e2e/tests/crm/users/users-refactor.spec.ts \
  apps/e2e/tests/drop-archive-real.spec.ts \
  apps/e2e/tests/drop-archive-user-real.spec.ts \
  apps/e2e/tests/drop-archive-cascade.spec.ts \
  apps/e2e/tests/drop-rotate-senior.spec.ts \
  apps/e2e/tests/polish-regressions.spec.ts \
  apps/e2e/tests/team.spec.ts \
  apps/e2e/tests/users.spec.ts
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3b wave (b) part 2 — users list, teams, user archive to uk/en

ac_verified: 1,2,3,4,5,6,7,8,9 (10 — reviews after push)
EOF
)"
```

`git mv` уже поставил в индекс удаление старых путей. `git status` перед коммитом покажет `renamed:` для обоих файлов.

**Design tier 2.** Скриншоты 320 и 1440 × `uk` и `en`: `/users` (список, фильтр ролей, пустой результат), `/team` (список, сортировка, пустой результат, создание), `/team/$teamId` (участники, добавление), диалоги архивации для SENIOR с командой, SENIOR без команды, HR (5 команд), JUNIOR — из списка `/users` **и** из меню профиля (оба рендерят `UserArchiveImpact`). `copy-reviewer` — по `uk` и `en` отдельно, отдельной строкой — вердикт по COPY-L-31 и L-32. `security-reviewer` — обязателен (архивация, состав команд).

---

## Task 3 (PR3): мастер пользователя, резюме, удаление легаси

**Files:**

| Файл                                                        | Кир. строк | Паттерн(ы)       | Находки аудита / примечание                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/users/UserDialog.tsx`                           | 142 / 119  | A, B, C, D, G, H | COPY-M-ppl-2 (5 фоллбэков), M-3 («переводе контракта»), M-6 («Нет активного шаблона»), M-13 (три примера), H-3 («Нельзя сменить свою роль ADMIN»); ручная форма «команд(ы) доступно» → `<Plural>`; секция «Платёжные реквизиты» по канону |
| `components/user-profile/resume/ResumeTab.tsx`              | 39 / 36    | B, C             | —                                                                                                                                                                                                                                         |
| `components/user-profile/resume/ResumeLayoutPanel.tsx`      | 29 / 29    | A, C             | `` `Показать «${SECTION_LABELS[key]}»` ``/`` `Скрыть «…»` `` — вложенная подстановка переводимой строки (аудит B) → `SECTION_LABEL_MESSAGES` + `t\`Показати «${label}»\``, пара `aria-label`/`title` — одна переменная на обе             |
| `components/user-profile/resume/ResumeStatusPanel.tsx`      | 17 / 15    | A, F             | `formatResetTime` → `formatDate(at, locale, 'dateTime')` (новый стиль); `failureHint` — шаблон A                                                                                                                                          |
| `components/user-profile/resume/ResumeIntake.tsx`           | 14 / 13    | B, C, G          | COPY-M-ppl-9 → `translateZodCode('RESUME_TEXT_TOO_SHORT')` (текст с числом уже в реестре, этап 4)                                                                                                                                         |
| `components/user-profile/resume/ResumeExperienceEditor.tsx` | 13 / 13    | C                | Шесть `aria-label` вида `` `Переместить место работы ${index + 1} вверх` `` → `t\`Перемістити місце роботи ${position} вгору\`` (`position = index + 1` до макроса)                                                                       |
| `components/user-profile/resume/ResumePdfPreview.tsx`       | 8 / 7      | C                | COPY-L-ppl-5: ``filename={`Резюме — ${…}.pdf`}`` → `t\`Резюме — ${name}.pdf\`` (`en`: "CV — {name}.pdf")                                                                                                                                  |
| `components/user-profile/resume/ResumeSectionCard.tsx`      | 7 / 7      | B                | —                                                                                                                                                                                                                                         |
| `components/users/constants.ts`                             | 7 / 5      | —                | Удалить `ROLE_LABELS` (5 строк значений и 1 строка комментария внутри блока); оставшаяся строка — пример данных в JSDoc `getInitials` («Иван Иванов» → «ИИ»), не мигрировать                                                              |
| `components/ui/role-select.tsx`                             | —          | —                | Удалить легаси `ROLE_LABELS` и комментарий над ним; обновить комментарий у `ROLE_BADGE_VARIANT` («See ROLE_LABELS»)                                                                                                                       |
| `packages/shared/src/i18n/format.ts` + `format.spec.ts`     | —          | F                | Стиль `'dateTime'`                                                                                                                                                                                                                        |

Тесты: `components/users/__tests__/{UserDialog.create-wizard.test.tsx (40), UserDialog.edit-drop-share.test.tsx (4), UserDialog.edit-prefill.test.tsx (8), UserDialog.pending-share-hygiene.test.tsx (21), UserDialog.share-role-scoping.test.tsx (23), UserDialog.test.tsx (4)}`, `components/user-profile/resume/__tests__/{ResumeExperienceEditor.test.tsx (0), ResumeLayoutPanel.test.tsx (7), ResumeTab.test.tsx (39)}`, `components/ui/__tests__/role-select.locale.test.tsx` (кейс «легаси не тронут» → «легаси удалён»), `components/layout/__tests__/ImpersonationBanner.spec.tsx` (комментарий ссылается на `ROLE_LABELS`, поправить текст комментария).

E2E: **17 кликов** и остальное из «Распределения», строка PR3, плюс вывод свипа.

**Interfaces:**

- Consumes: всё, что в PR1/PR2 (`useRoleLabel`, `ROLE_LABEL_MESSAGES`, `translateZodCode`, `translateZodMessage`, `getApiErrorMessage`, `formatDate`, `useLocale`); `ShareSlider`, `RoleSelect` (уже мигрированы в 3a); `ContractEditor`, `ContractActionBar`, `useEmployeeContract` (мигрированы в PR1 — `UserDialog` их только рендерит).
- Produces: `formatDate(value, locale, style: 'short' | 'long' | 'month' | 'monthYear' | 'dateTime')` — `'dateTime'` = день, месяц словом, часы и минуты, **в локальной зоне браузера** (без `timeZone: 'UTC'`, в отличие от остальных стилей: время сброса квоты человек читает по своим часам). Удаляются `ROLE_LABELS` из `@/components/ui/role-select` и из `@/components/users/constants`. После PR3 `git grep -nP '\bROLE_LABELS\b' apps/web/app` находит только локальные карты **вне** периметра (`projects/$projectId.tsx`, `admin/contracts.{index,$role}.tsx` — волна c; «Находки вне периметра»).

### Опасность: удаление легаси — только после мержа PR1 и PR2

`role-select.ROLE_LABELS` читают `UserProfileHeader`, `ContractTab`, `TeamTab` (PR1). `constants.ROLE_LABELS` читают `UserRow`, `users/index.tsx` (PR2) и `UserDialog` (этот PR). Если удалить экспорт раньше, typecheck упадёт у всех, кто ещё не переехал. Step 0 проверяет, что оба PR смёржены, а Step 3 — что потребителей ноль.

### Acceptance criteria (PR3)

1. `UserDialog.tsx` на `uk`/`en`: роли в выборе и триггере — из `ROLE_LABEL_MESSAGES`; закрыты COPY-M-ppl-2 (в мастере), M-3, M-6 (шаг контракта), M-10 и M-13 (в мастере), H-3 (подсказка про свою роль); «команд(ы) доступно» — `<Plural>`; Zod-сообщения — коды реестра.
2. `ROLE_LABELS` удалён из `role-select.tsx` и из `components/users/constants.ts`; тесты «легаси удалён» зелёные; в периметре волны `ROLE_LABELS` не встречается.
3. Резюме на `uk`/`en`; закрыты COPY-M-ppl-9 и L-5 (резюме); `formatDate` получил стиль `'dateTime'` с тестом; `formatResetTime` принимает локаль.
4. 17 кликов `name: 'Синьор'` в 5 спеках идут через `assertInCatalog(uk, 'Сеньйор')`; `git grep "name: 'Синьор'" -- apps/e2e/tests` пуст.
5. Финальная сверка волны (три команды Step 6) дала ожидаемый результат, вывод — в теле PR.
6. Unit-тесты ассертят текст из каталога; E2E-свип выполнен, таблица в теле PR; E2E спек PR3 зелёные.
7. `pnpm i18n:extract` дважды — пустой дифф; в `en` 0 пустых `msgstr`.
8. `pnpm mutation:changed` — `survived 0`; `check-mutation-suppressions.mjs` зелёный.
9. Design tier 2, fidelity Mode B на всех ширинах, скриншоты 320/1440 × `uk`/`en`; `copy-reviewer` PASS по `uk` и `en`; `security-reviewer` APPROVE.

- [ ] **Step 0: Замер и предусловия**

```bash
git rev-parse --show-toplevel
git fetch origin main
git grep -nP "\bROLE_LABELS\b" origin/main -- apps/web/app ':!**/__tests__/**'
```

Ожидается: вхождения только в `role-select.tsx` (объявление), `components/users/constants.ts` (объявление), `components/users/UserDialog.tsx` и локальные карты вне периметра (`projects/$projectId.tsx`, `admin/contracts.index.tsx`, `admin/contracts.$role.tsx`). Любое другое вхождение — значит PR1 или PR2 не смёржен или что-то пропустил: стоп, `.blocked.md`.

- [ ] **Step 1: Тест — роли в мастере из канона, легаси удалён (падает)**

В существующий `components/users/__tests__/UserDialog.create-wizard.test.tsx` (в нём уже есть `render` с `I18nTestProvider`, `beforeEach(loadCatalog('uk'))` и моки `@/context/auth`, роутера и `api`) добавить:

```tsx
import { within } from '@testing-library/react'

describe('role picker reads ROLE_LABEL_MESSAGES', () => {
  it.each([
    ['uk', ['Сеньйор', 'Джуніор', 'HR', 'Бухгалтер', 'Дроп']],
    ['en', ['Senior', 'Junior', 'HR', 'Accountant', 'Drop']],
  ] as const)(
    '%s: every CREATE_ALLOWED_ROLES option is the canon label, no legacy or enum',
    async (locale, labels) => {
      await loadCatalog(locale)
      const user = userEvent.setup()
      render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
      await user.click(screen.getByTestId('user-dialog-role-trigger'))
      const listbox = await screen.findByRole('listbox')
      for (const label of labels) {
        expect(within(listbox).getByRole('option', { name: label })).toBeInTheDocument()
      }
      expect(listbox.textContent).not.toMatch(/Синьор|Джун\b|SENIOR|JUNIOR|ACCOUNTANT|DROP/)
    },
  )
})
```

В `components/ui/__tests__/role-select.locale.test.tsx` кейс `'leaves the legacy ROLE_LABELS export untouched (type: string) …'` заменить на:

```tsx
describe('legacy ROLE_LABELS exports are gone (wave b, PR3)', () => {
  it('role-select no longer exports ROLE_LABELS', async () => {
    expect('ROLE_LABELS' in (await import('../role-select'))).toBe(false)
  })
  it('components/users/constants no longer exports ROLE_LABELS', async () => {
    expect('ROLE_LABELS' in (await import('@/components/users/constants'))).toBe(false)
  })
})
```

Run: `pnpm --filter @crm/web test -- UserDialog.create-wizard role-select.locale` → FAIL.

- [ ] **Step 2: `UserDialog.tsx` — миграция**

Файл самый большой в волне (2596 строк), поэтому идти по секциям мастера, по `wip:`-коммиту после каждой: «Ідентичність» → «Роль і мова» → «Дані для контракту» → «Контакти» → «Професія» → «Фінанси» → «Реквізити для виплат» → «Команда» → шаг контракта → диалог смены email → тосты мутаций.

Ключевые места:

- **Выбор роли**: `{ROLE_LABELS[r]}` в `SelectItem` → шаблон H (список); `{ROLE_LABELS[role]}` в триггере — шаблон H (одно значение). Хардкод «Синьор» и «(HR может создавать только синьоров)» → `i18n._(ROLE_LABEL_MESSAGES.SENIOR)` и `<Trans>(HR може створювати лише сеньйорів)</Trans>`. `hint` «Нельзя сменить свою роль ADMIN» (H-3, сырой enum) → `t\`Свою роль змінити не можна\``.
- **Реквизиты**: «Для роли «{ROLE_LABELS[role]}» доступна только оплата через USDT ERC-20» → `<Trans>Для ролі «{roleLabel}» доступні лише виплати в USDT ERC-20</Trans>` (роль в именительном падеже внутри кавычек, урок п.9). «Способ оплаты» (label и `ariaLabel`) → «Спосіб виплати» (канон). «USDT ERC-20 кошелёк» → «Гаманець USDT (ERC-20)» — ровно та строка, что в `RequisitesEditForm` после PR1: один ключ, и `requisites-warning.spec.ts` ассертит одну подпись для обеих форм. «ФИО получателя (ФОП)», «РНОКПП (ИНН ФОП)» → «ПІБ отримувача (ФОП)», «РНОКПП». Плейсхолдеры — канон (M-13): «Іваненко Іван Іванович» (оба ФИО-поля — один пример, сейчас их два разных), «м. Київ, вул. Хрещатик, 1», «ПриватБанк».
- **Команда дропа**: `'команда доступна' / 'команд(ы) доступно'` → `<Plural value={n} one="# команда доступна" few="# команди доступні" many="# команд доступно" other="# команди доступно" />`.
- **Тосты мутаций** (M-2, M-3) — `explainUserMutationError(err, <fallback>)`, фоллбэк называет действие и говорит, что данные на месте:

| Было                                  | `uk`                                                                       | `en`                                                             |
| ------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| «Ошибка при создании»                 | Не вдалося створити користувача — дані у формі збережено, спробуйте ще раз | Could not create the user — the form keeps your data, try again  |
| «Ошибка при создании дропа»           | Не вдалося створити дропа — дані у формі збережено, спробуйте ще раз       | Could not create the drop — the form keeps your data, try again  |
| «Ошибка при обновлении» (×2)          | Не вдалося зберегти зміни — дані у формі збережено, спробуйте ще раз       | Could not save the changes — the form keeps your data, try again |
| «Ошибка при переводе контракта» (M-3) | Не вдалося позначити контракт готовим до підписання                        | Could not mark the contract as ready to sign                     |

«Ошибка при переводе» — это смена статуса `DRAFT → READY_TO_SIGN`, а не перевод текста: формулировка берётся словами кнопки («Позначити готовим до підписання»), иначе в `en` получится "translation".

- **Успехи**: «Пользователь создан, контракт готов к подписанию» → «Користувача створено, контракт готовий до підписання»; «Пользователь обновлён» → «Зміни збережено» (`admin-actions.spec.ts` ассертит тост → шаблон I); многострочный `` `Сохранено. Предложение отправлено синьору: ${pending.percent}%…` `` → `<Trans>` / `t` одним предложением с `{percent}`.
- **Шаг контракта**: «Нет активного шаблона» (M-6) → «Немає активного шаблону контракту для цієї ролі — контракт можна додати пізніше з профілю користувача; натисніть «Далі», щоб продовжити». «Черновик» / «Отметить готовым к подписи» / «Отправка...» → «Чернетка» / «Позначити готовим до підписання» / «Надсилаємо…». `frozenBanner` → канон статусов.
- **Диалог смены email**: «Убедись, что пользователь…» (обращение на «ты» в интерфейсе, где везде «вы») → «Переконайтеся, що користувач знає про зміну і за потреби змінить свій обліковий запис Google» («обліковий запис Google» — глоссарий).
- **Zod** внутри рендера (`z.string().email('Некорректный email')`, «Имя минимум 2 символа», «ФИО минимум 5 символов», «ФИО получателя минимум 3 символа» — три ручные формы слова «символ», аудит B) → `'zod.EMAIL_INVALID'`, `'zod.DISPLAY_NAME_MIN'`, `'zod.LEGAL_FULL_NAME_MIN'`, `'zod.RECIPIENT_NAME_MIN'` + `translateZodMessage` в месте показа ошибки поля. Числа живут в реестре (этап 4), в JSX не дублируются.
- «Язык интерфейса» (поле, добавленное этапом 2) и его `hint` → «Мова інтерфейсу» / «Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі». Пункты `Українська`/`English` — эндонимы, не переводятся.

- [ ] **Step 3: Удаление легаси `ROLE_LABELS` (отложенный пункт 1)**

`components/users/constants.ts` — удалить `export const ROLE_LABELS` целиком. `components/ui/role-select.tsx` — удалить `export const ROLE_LABELS` и комментарий «task-i18n-stage3a (Task 1), Step 1/2 — legacy export, LEFT UNCHANGED …» над ним; у `ROLE_BADGE_VARIANT` комментарий «See ROLE_LABELS — placeholder …» переписать без ссылки на удалённый экспорт.

```bash
git grep -nP "\bROLE_LABELS\b" -- apps/web/app ':!**/__tests__/**'
# ожидается: только projects/$projectId.tsx, admin/contracts.index.tsx, admin/contracts.$role.tsx (локальные карты вне периметра)
git grep -nP "\bROLE_LABELS\b" -- apps/web/app/**/__tests__
# ожидается: только комментарии — поправить текст в ImpersonationBanner.spec.tsx и UserProfileHeader.test.tsx
```

Run: `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web test -- UserDialog role-select` → PASS.

- [ ] **Step 4: Резюме + стиль `'dateTime'`**

```ts
// packages/shared/src/i18n/format.spec.ts — добавить
it("formatDate 'dateTime' keeps the reader's local clock (no UTC shift)", () => {
  const d = new Date(2026, 8, 24, 14, 5) // local 24 Sep 2026 14:05
  expect(formatDate(d, 'en', 'dateTime')).toMatch(/24 September.*14:05/)
  expect(formatDate(d, 'uk', 'dateTime')).toMatch(/24 вересня.*14:05/)
})
```

```ts
// packages/shared/src/i18n/format.ts — расширить union стилей и STYLE_OPTS
dateTime: { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' },
// без timeZone: 'UTC' — см. Interfaces
```

`ResumeStatusPanel.formatResetTime(iso)` → `formatResetTime(iso, locale)`: `Number.isNaN` → `msg\`найближчим часом\``, иначе `formatDate(at, locale, 'dateTime')`. Строка входит в «Ліміт оновиться {when}» одной `<Trans>`— без склейки.`failureHint` (`switch`по коду) — шаблон A, по`msg` на ветку.

`ResumeIntake.tsx`: `toast.error('Текст резюме слишком короткий')` (M-9) → `toast.error(translateZodCode('RESUME_TEXT_TOO_SHORT'))` — тот же текст, что у серверной проверки, одна строка на два пакета.

`ResumeLayoutPanel.tsx`: `SECTION_LABELS` → `SECTION_LABEL_MESSAGES: Record<ResumeSectionKey, MessageDescriptor>` (шаблон A); `` `Показать «${…}»` `` / `` `Скрыть «${…}»` `` → `const label = i18n._(SECTION_LABEL_MESSAGES[key])`, затем `t\`Показати «${label}»\`` / `t\`Приховати «${label}»\``. Одна переменная идёт и в `aria-label`, и в `title` (аудит B: пара легко разъедется).

Остальные файлы `resume/*` — шаблоны B/C, многоточия `…`. E2E `crm/senior-resume.spec.ts` («Распознаём резюме» и остальное из свипа) — шаблон I.

- [ ] **Step 5: 17 E2E-кликов «Синьор» и остальные строки мастера (отложенный пункт 1, COPY-H-8 #707)**

В каждой из 5 спек — один `const uk = await loadMessages('uk')` в начале теста (или в `beforeEach`, если спека так устроена), затем:

```ts
// было
await page.getByRole('option', { name: 'Синьор' }).click()
// стало
await page.getByRole('option', { name: assertInCatalog(uk, 'Сеньйор') }).click()
```

Места: `users.spec.ts` ×5, `drop-add-senior.spec.ts` ×6, `senior-create-default.spec.ts` ×3, `crm/users/users-refactor.spec.ts` ×2, `drop-create-ui-regressions.spec.ts` ×1 — итого 17. В `drop-create-ui-regressions.spec.ts` удаляется комментарий «UserDialog renders the legacy `ROLE_LABELS` map … Flip to assertInCatalog(uk, 'Сеньйор') together with those 17 other call sites» — это ровно та правка. Там же клики `name: 'Дроп'` (×3) → `assertInCatalog(uk, 'Дроп')` (слово то же, но ассерт идёт через каталог — правило спеки §8).

Проверка счёта:

```bash
git grep -c "name: 'Синьор'" origin/main -- apps/e2e/tests   # до: 17 в 5 файлах
git grep -c "name: 'Синьор'" -- apps/e2e/tests                # после: пусто
```

Остальные строки мастера: `admin-actions.spec.ts` (заголовок «Редактировать пользователя» → «Редагувати користувача», триггер роли `toContainText('Джун')` → `assertInCatalog(uk, 'Джуніор')`, тост), `drop-duplicate-email.spec.ts` («Дроп создан»), `requisites-warning.spec.ts` (подпись кошелька в мастере), `crm/create-wizard.spec.ts` — по свипу.

- [ ] **Step 6: Тесты, свип, финальная сверка волны, гейты, коммит**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/shared test -- src/i18n/format.spec.ts
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- users users-refactor drop-add-senior senior-create-default drop-create-ui-regressions drop-create drop-duplicate-email admin-actions requisites-warning create-wizard senior-resume
pnpm mutation:changed
node scripts/devops/check-mutation-suppressions.mjs
```

Финальная сверка волны (b) — выполняется в PR3 и вставляется в тело PR:

```bash
# 1. русских букв в мигрированных файлах волны нет (исключение — job-sourcing, вне волны)
python3 - <<'EOF'
import re, pathlib, subprocess
out = subprocess.run(['git', 'ls-files', 'apps/web/app/components/users', 'apps/web/app/components/user-profile',
                      'apps/web/app/components/onboarding', 'apps/web/app/routes/_authenticated/team',
                      'apps/web/app/routes/_authenticated/users', 'apps/web/app/routes/_authenticated/onboarding',
                      'apps/web/app/components/archive'], capture_output=True, text=True).stdout.split()
bad = 0
for f in out:
    if re.search(r'__tests__|\.(spec|test)\.', f):
        continue
    for n, l in enumerate(pathlib.Path(f).read_text(encoding='utf8').splitlines(), 1):
        if re.search('[ыЫэЭъЪёЁ]', l) and not re.match(r'\s*(//|\*|\{/\*)', l):
            print(f, n, l.strip()); bad += 1
print('violations:', bad)
EOF
# 2. ветвлений по тексту ошибки сервера нет (аудит §4)
git grep -nE "message\)?\.(toLowerCase\(\)\.)?includes\('" -- apps/web/app/components/users apps/web/app/components/user-profile apps/web/app/components/onboarding
# 3. легаси ролей нет в периметре
git grep -nP "\bROLE_LABELS\b" -- apps/web/app/components apps/web/app/routes/_authenticated/{team,users,onboarding,profile}
```

Ожидается: 1 — `violations: 0`; 2 — пусто; 3 — пусто.

```bash
git add \
  apps/web/app/components/users/UserDialog.tsx \
  apps/web/app/components/users/constants.ts \
  apps/web/app/components/ui/role-select.tsx \
  apps/web/app/components/ui/__tests__/role-select.locale.test.tsx \
  apps/web/app/components/layout/__tests__/ImpersonationBanner.spec.tsx \
  apps/web/app/components/user-profile/__tests__/UserProfileHeader.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.create-wizard.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.edit-drop-share.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.edit-prefill.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.pending-share-hygiene.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.share-role-scoping.test.tsx \
  apps/web/app/components/users/__tests__/UserDialog.test.tsx \
  apps/web/app/components/user-profile/resume/ResumeTab.tsx \
  apps/web/app/components/user-profile/resume/ResumeLayoutPanel.tsx \
  apps/web/app/components/user-profile/resume/ResumeStatusPanel.tsx \
  apps/web/app/components/user-profile/resume/ResumeIntake.tsx \
  apps/web/app/components/user-profile/resume/ResumeExperienceEditor.tsx \
  apps/web/app/components/user-profile/resume/ResumePdfPreview.tsx \
  apps/web/app/components/user-profile/resume/ResumeSectionCard.tsx \
  apps/web/app/components/user-profile/resume/__tests__/ResumeLayoutPanel.test.tsx \
  apps/web/app/components/user-profile/resume/__tests__/ResumeTab.test.tsx \
  packages/shared/src/i18n/format.ts \
  packages/shared/src/i18n/format.spec.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/users.spec.ts \
  apps/e2e/tests/drop-add-senior.spec.ts \
  apps/e2e/tests/senior-create-default.spec.ts \
  apps/e2e/tests/crm/users/users-refactor.spec.ts \
  apps/e2e/tests/drop-create-ui-regressions.spec.ts \
  apps/e2e/tests/admin-actions.spec.ts \
  apps/e2e/tests/drop-duplicate-email.spec.ts \
  apps/e2e/tests/requisites-warning.spec.ts \
  apps/e2e/tests/crm/senior-resume.spec.ts \
  apps/e2e/tests/crm/create-wizard.spec.ts
git add $(cat "$SCRATCH/sweep-specs.txt")
git commit -m "$(cat <<'EOF'
feat(web,shared,i18n): stage 3b wave (b) part 3 — user wizard, senior CV, drop legacy ROLE_LABELS

ac_verified: 1,2,3,4,5,6,7,8 (9 — reviews after push)
EOF
)"
```

**Design tier 2.** Скриншоты 320 и 1440 × `uk` и `en`: мастер создания — каждый шаг для SENIOR, DROP (с выбором команды дропа), JUNIOR и HR; редактирование (включая диалог смены email и подсказку «Свою роль змінити не можна»); шаг контракта без шаблона; вкладка резюме (ввод, распознавание, ошибка квоты со временем сброса, раскладка секций). Главный риск на 320 — длинные украинские подписи полей в двухколоночных секциях мастера. `copy-reviewer` — по `uk` и `en` отдельно. `security-reviewer` — обязателен (создание пользователя с ролью, доли, реквизиты).

---

## Отложенные в волну (b) пункты — где закрываются

| #   | Пункт                                                                                                                  | Где                                                                                                                                  | Как проверить                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Легаси `ROLE_LABELS` → канон `ROLE_LABEL_MESSAGES`, удаление легаси; 17 E2E-кликов «Синьор» в 5 спеках (COPY-H-8 #707) | PR1 Step 3 (профиль), PR2 Step 4–5 (список, команды), PR3 Step 2–3 (мастер + удаление обоих экспортов), PR3 Step 5 (17 кликов)       | Тест «легаси удалён» (PR3 Step 1); `git grep -c "name: 'Синьор'" -- apps/e2e/tests` → пусто; финальная сверка PR3 п.3                       |
| 2   | COPY-L-31 (ветка без команды молчит об обратимости), COPY-L-32 («буде архівований» в 5 строках)                        | PR2 Step 2                                                                                                                           | Тесты `UserArchiveImpact`: «Відновлення можливе» в ветке без команды; нет `архівован(ий\|а)` ни в одной ветке пользователя                  |
| 3   | Два компонента `ArchiveConfirmDialog`                                                                                  | PR2 Step 2–3: переименование в `ArchiveUserConfirmDialog` + общий `UserArchiveImpact`; полное слияние отклонено («Опасность» Task 2) | `git grep -n "components/users/ArchiveConfirmDialog\|ImpactWarning" -- apps/web` → пусто; имя `ArchiveConfirmDialog` экспортирует один файл |
| 4   | `SignContractStep.tsx` — русские плашки из #702 (COPY-M-15/16)                                                         | PR1 Step 4                                                                                                                           | Тест «нет сырого enum роли» на `uk` и `en`; в файле 0 строк с `[ыэъё]`                                                                      |
| 5   | Дубли логики вне периметра (как `$projectId.tsx`) — не расширять периметр, записать                                    | «Находки вне периметра» ниже                                                                                                         | Раздел есть и заполнен                                                                                                                      |

---

## Трассировка находок аудита `web-people`

`Findings:` среза — 30. Каждый идентификатор ниже.

| Находка       | Статус на `062af6f8`                                              | Где закрывается                                                                                    |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| COPY-H-ppl-1  | открыта (`Сортування` в русском интерфейсе)                       | PR2 Step 5                                                                                         |
| COPY-H-ppl-2  | открыта                                                           | PR1 Step 4, Step 6                                                                                 |
| COPY-H-ppl-3  | частично (#702 убрал `ADMIN` в `SignContractStep`)                | PR1 Step 4, 6, 10; PR2 Step 5; PR3 Step 2                                                          |
| COPY-H-ppl-4  | закрыта этапом 2 (Task 8: канон с `DROP`)                         | PR1 Step 3 переводит на `useRoleLabel`                                                             |
| COPY-H-ppl-5  | частично (подпись роли есть, но из русского легаси)               | PR1 Step 3                                                                                         |
| COPY-H-ppl-6  | открыта                                                           | PR2 Step 2–3 (`ImpactWarning` удаляется)                                                           |
| COPY-H-ppl-7  | открыта                                                           | PR1 Step 4                                                                                         |
| COPY-H-ppl-8  | открыта                                                           | PR1 Step 5                                                                                         |
| COPY-H-ppl-9  | открыта                                                           | PR1 Step 7                                                                                         |
| COPY-H-ppl-10 | закрыта этапом 4 (`CONTRACT_TEMPLATE_MISSING`, `getApiErrorCode`) | проверка: финальная сверка PR3 п.2                                                                 |
| COPY-M-ppl-1  | закрыта этапом 4 (`VALIDATION_FAILED_FORM`, в срезе 0 вхождений)  | —                                                                                                  |
| COPY-M-ppl-2  | открыта (7 фоллбэков)                                             | PR2 Step 3, 5; PR3 Step 2                                                                          |
| COPY-M-ppl-3  | открыта                                                           | PR3 Step 2                                                                                         |
| COPY-M-ppl-4  | закрыта #702 (`ADMIN_DOES_NOT_SIGN_CONTRACTS`, текст из каталога) | —                                                                                                  |
| COPY-M-ppl-5  | открыта                                                           | PR1 Step 7                                                                                         |
| COPY-M-ppl-6  | открыта                                                           | PR2 Step 6 (чипы); PR3 Step 2 (шаблон); **для `TeamTab` не применяется** — «Опасность: маскировка» |
| COPY-M-ppl-7  | открыта                                                           | PR1 Step 5                                                                                         |
| COPY-M-ppl-8  | открыта                                                           | PR1 Step 9                                                                                         |
| COPY-M-ppl-9  | серверная часть закрыта этапом 4 (`RESUME_TEXT_TOO_SHORT`)        | PR3 Step 4 (клиентский тост)                                                                       |
| COPY-M-ppl-10 | открыта                                                           | PR1 Step 6; PR3 Step 2                                                                             |
| COPY-M-ppl-11 | открыта                                                           | PR1 Step 6                                                                                         |
| COPY-M-ppl-12 | открыта                                                           | PR1 Step 6                                                                                         |
| COPY-M-ppl-13 | открыта                                                           | PR1 Step 6; PR2 Step 5; PR3 Step 2                                                                 |
| COPY-M-ppl-14 | открыта                                                           | PR1 Step 7; PR2 Step 4, 5                                                                          |
| COPY-M-ppl-15 | открыта                                                           | PR1 Step 4                                                                                         |
| COPY-L-ppl-1  | открыта                                                           | Global Constraints (`…`), все три PR                                                               |
| COPY-L-ppl-2  | открыта                                                           | PR1 Step 4                                                                                         |
| COPY-L-ppl-3  | открыта                                                           | PR2 Step 6                                                                                         |
| COPY-L-ppl-4  | открыта                                                           | PR1 Step 6                                                                                         |
| COPY-L-ppl-5  | открыта                                                           | PR1 Step 4, 8; PR3 Step 4                                                                          |

Findings: COPY-H-ppl-1 … COPY-H-ppl-10, COPY-M-ppl-1 … COPY-M-ppl-15, COPY-L-ppl-1 … COPY-L-ppl-5 (30) — строк в таблице 30.

---

## Находки вне периметра (не расширяем, записываем)

| Что                                                                                                                                                                                                                                                                                                                                                                                                   | Чья волна / куда                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Локальные карты ролей: `routes/_authenticated/projects/$projectId.tsx` (`ROLE_LABELS`, фоллбэк `?? role` печатает enum), `admin/contracts.index.tsx` и `admin/contracts.$role.tsx` (`ROLE_LABELS: Record<ContractTargetRole, string>`, плюс склейка `` `Шаблон для роли ${…} опубликован` ``), `routes/_authenticated/stats.tsx` (`ROLE_LABEL`), `routes/invoice.v.$transactionId.tsx` (`ROLE_LABEL`) | (c) — проекты и админка контрактов; (d) — статистика и счета. Шаблон H из этого плана                                      |
| `components/admin-actions/AdminActionsMenu.tsx` + его тест: файл **нигде не импортируется** (`git grep "components/admin-actions" -- apps/web` → пусто) со времён #34, в нём русские «Действия», «Восстановить из архива», «Архивировать»                                                                                                                                                             | Кандидат на удаление, отдельный light-track PR. Если его не удалить, guard этапа 6 на русские буквы упадёт на мёртвом коде |
| `INVOICE_SIGN_IMPERSONATION_MESSAGE` (`@crm/shared`, русский) — последний потребитель `components/invoices/invoice-detail-dialog.tsx`                                                                                                                                                                                                                                                                 | (d) — перейти на `API_ERROR_MESSAGES.INVOICE_SIGN_IMPERSONATION` и удалить константу (как PR1 Step 3)                      |
| `TYPE_LABELS`/`STATUS_LABELS` (`routes/_authenticated/finance/constants.ts`) читает `FinanceTab`                                                                                                                                                                                                                                                                                                      | (d)                                                                                                                        |
| `NOTIFICATION_TITLES` (`@crm/shared`) читает `NotificationSettingsTab`                                                                                                                                                                                                                                                                                                                                | этап 4 Task 6                                                                                                              |
| Каталог держит два варианта «особиста адреса» / «особистий email» (`api-error.*`, `zod-error.*`)                                                                                                                                                                                                                                                                                                      | Этап 4: выровнять по канону этой волны («особистий email»), `msgstr` правится руками в обоих `.po`                         |
| Полное слияние двух диалогов архивации пользователя                                                                                                                                                                                                                                                                                                                                                   | Отдельная задача с `security-reviewer`, если понадобится («Опасность» Task 2)                                              |

---

## Что НЕ входит

- **`components/job-sourcing/**`\*\* — модуль на паузе (решение владельца). Вопрос A2 ниже.
- **`apps/api`** — волна его не трогает (FM-5 не применяется; если понадобится — Global Constraints).
- **Волны (c)–(e)**: проекты, собеседования, вакансии, финансы, статистика, счета, документы, уведомления, `/pending`. Их файлы не редактируются, даже когда в них найдены дубли (см. «Находки вне периметра»).
- **Этап 6**: ESLint `lingui/no-unlocalized-strings` в режиме error, guard на русские буквы, `extract --clean` как хард-гейт.
- Тексты с явным id (`api-error.*`, `zod-error.*`) волна не меняет, а только использует.

---

## Допущения (A1 — обратимые, записаны)

1. **Периметр скорректирован** относительно буквального среза аудита: исключены `job-sourcing` (пауза владельца), `LanguageSection.tsx` (уже `uk`) и файлы без кириллицы или только с комментариями; добавлены `components/archive/ArchiveConfirmDialog.tsx`, новый `UserArchiveImpact.tsx`, `role-select.tsx`, `format.ts`, три shared-схемы и `CONTEXT.md` — каждый по конкретной причине (таблица «Периметр»).
2. **Резюме — в PR3, а не в PR1**, хотя это вкладка профиля. Так PR1 (362 строки, 30 файлов) и PR3 (244) уравнены. PR3 и так последовательный, дисциплину параллельности это не нарушает. Общая E2E-спека `crm/senior-resume.spec.ts` правится двумя PR последовательно (PR1 — «Остаться», PR3 — тексты резюме).
3. **Два диалога архивации не сливаются**: общий текст плюс переименование (обоснование — «Опасность» Task 2). Слияние — отдельная задача.
4. **ToS в `uk` — «Умови використання»**, хотя аудит предлагал «Умови користування». Каталог уже говорит «умови використання» (`api-error.TOS_ACCEPT_IMPERSONATION`), это же форма из украинского интерфейса Google — тот же довод, что у «обліковий запис Google» в глоссарии.
5. **`en` для «резюме» — «CV»**: локаль `en-GB`, а «resume» в `en`-интерфейсе совпадает с глаголом «продолжить». `copy-reviewer` может пересмотреть — тогда правка одной строки канона и каталога.
6. **COPY-M-ppl-6 для `TeamTab` не применяется**: инвариант маскировки (легенда джуниора) важнее подсказки. Текст остаётся нейтральным.
7. **Три русских `*_IMPERSONATION_MESSAGE` удаляются из `@crm/shared` в PR1**: у них не остаётся потребителей (урок #700, п.8). `INVOICE_SIGN_…` остаётся до волны (d).
8. **Стиль `'dateTime'` в `formatDate` — без `timeZone: 'UTC'`**, в отличие от остальных стилей: время сброса квоты — момент, который человек сверяет со своими часами. Даты без времени по-прежнему в UTC.
9. **Родительный падеж после «з» в архивном тексте** исправлен по ходу (в каталоге сейчас «з 1 команда»). Находка не из аудита — записана здесь, чтобы `copy-reviewer` видел, откуда правка в уже мигрированном файле.
10. **Черновики `uk`/`en` в шагах** — ориентир, а не окончательный текст. Окончательный текст утверждает `copy-reviewer` по рубрике «два оригинала»; расхождение с черновиком плана в PR — не нарушение плана.

## Вопросы владельцу (A2)

```
🟠 Решения от тебя — 1 шт. · план i18n волны (b)
Всё остальное в плане решено и записано в «Допущения».
Продолжают идти: PR1 и PR2 волны (b) после мержа #706, этап 4.

❓ 1 — Модуль автоподачи резюме (job-sourcing) — переводить или удалять к этапу 6?
   Модуль на паузе с 2026-08-23, код не трогаем. В нём 2 экрана и 47 строк русского текста.
   Этап 6 включает проверку «ни одной русской буквы в продукте» — на этих файлах она упадёт.
➡️ Рекомендую: решить при планировании этапа 6. Если пауза к тому моменту ещё действует —
   добавить модуль в исключения проверки с датой пересмотра, а не переводить мёртвый экран.
🔓 Обратимо · ⏱ молчание до планирования этапа 6 → приму рекомендацию и запишу
   в «Допущения» плана этапа 6; откат = один перевод двух файлов
```

---

## Проверка готовности волны (b)

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — зелёные после каждого PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test` на спеках из «Распределения» и вывода свипа — зелёные; CI на всех шардах зелёный.
- `pnpm i18n:extract` дважды подряд — второй прогон не меняет `.po`; в `en` 0 пустых `msgstr`.
- `pnpm mutation:changed` — `survived 0`; `NoCoverage` без integration-hint закрыт unit-тестом; `node scripts/devops/check-mutation-suppressions.mjs` — зелёный.
- Финальная сверка PR3: 0 строк с `[ыэъё]` вне комментариев в периметре; 0 ветвлений по тексту ошибки; 0 `ROLE_LABELS` в периметре; 0 кликов `name: 'Синьор'` в `apps/e2e/tests`.
- В `CONTEXT.md` есть подраздел «Волна b — `web-people`».
- `copy-reviewer`: `PASS` на `uk` и на `en` для каждого из 3 PR.
- `security-reviewer`: `APPROVE` для каждого из 3 PR.
- Скриншоты 320/1440 × `uk`/`en` для каждого мигрированного экрана — в теле каждого PR; fidelity Mode B — все ширины.
- Трассировка: 30 идентификаторов аудита `web-people` — у каждого строка в теле того PR, который его закрывает (`review-findings-transfer.md`).
