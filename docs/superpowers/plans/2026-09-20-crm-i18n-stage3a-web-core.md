# CRM i18n — этап 3, волна (a) «web-core» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести на `uk`/`en` весь каркас CRM — общие UI-компоненты (`components/ui`, `components/layout`, `components/crm`, `components/archive`), навигацию, дашборды после входа (`routes/_authenticated/routing/**`), вход (`login.tsx`, `__root.tsx`, `client.tsx`), обработку ошибок (`axios-utils.ts`, `ErrorBoundary.tsx`) и весь `lib`/`hooks` — тремя PR по непересекающимся файлам, без русского текста в мигрированных файлах и без регрессий в поведении, которое перевод ломает молча (аудит §2).

**Architecture:** Тот же единственный каталог `packages/shared/src/i18n/locales/{uk,en}/messages.po`, что и в этапе 2. Модульные константы (`NAV_ITEMS`, `ROLE_LABELS`, `ERROR_MESSAGES`, `STATUS_MESSAGES`, `SORT_OPTIONS` и т. п.) переходят с «вычислено при импорте» на `msg`-дескриптор + `i18n._()` в рендере — иначе переключение языка не подействует на уже загруженную вкладку. Видимый JSX-текст — `<Trans>`; атрибуты (`aria-label`/`title`/`placeholder`) и императивные строки (`toast.error(...)`) — `t` из `useLingui()` (не голый макрос `t` вне компонента — учитывает реактивность на смену локали). Числовые формы — `plural`/`<Plural>`; ветвление по роли в родовых формах — `select`. Формат дат/денег/чисел — только через `packages/shared/src/i18n/format.ts` (`formatDate`, `formatMoney`, `formatNumber`, `compareNames`) плюс новая `formatRelativeTime` (Task 1, заменяет `date-fns/locale/ru`).

**Tech Stack:** Lingui **5.9.5** EXACT (`@lingui/core`, `@lingui/react`, `@lingui/core/macro`, `@lingui/react/macro`) — уже установлен и настроен этапом 2 (`lingui.config.ts`, Vite/Vitest macro-плагин). React 18 + Vite 6 + Vitest 4, TanStack Router, Tailwind v4 + shadcn/ui, `eslint-plugin-lingui` 0.16.0 (уже `warn`), Node 22 LTS, pnpm 7.32.4.

**Spec:** `docs/superpowers/specs/2026-09-19-crm-i18n-design.md` §4.6, §7 п.3 (волна a), §8 (тесты), §5 (гейты). Аудит: `docs/architecture/2026-09-19-crm-i18n-audit.md`, срез `web-core` (строки 129–222) + сквозные темы §1–§4. Фундамент (уже смёржен на `origin/main`): `docs/superpowers/plans/2026-09-19-crm-i18n-stage2-foundation.md`.

## Global Constraints

- Версии `@lingui/*` — **5.9.5 EXACT**, одной версией (решение владельца 2026-09-19 после спайков 0b/0c — Lingui 6 ESM-only ломает `tsc` в api/shared; см. `version-pins.md`). НЕ апгрейдить в этом плане.
- Исходный текст в коде — **украинский** (`sourceLocale: 'uk'`); английский пишется рядом в том же PR как второй оригинал (скилл `copywriting` §5, решение владельца #7). Русские литералы в файлах из периметра этой волны убираются полностью; литералы в файлах ВНЕ периметра (`_Избегать_`) не трогаются.
- `msg`/`plural`/`select`/`t`/`Trans` — **никогда `t`/`plural`/`select` на уровне модуля** (фиксируют строку один раз при импорте): модульные константы — `msg`, разрешаются `i18n._()` в месте показа. Источник — Lingui 5.9.5 docs (`Do not call t, plural or select at module level`).
- В компонентах — `useLingui()` из `@lingui/react/macro` для `t`/`i18n` (не голый `@lingui/core/macro` `t`/`plural` вне компонента): так строка реагирует на переключение языка без ремонта.
- Тесты: якоря `data-testid`/роли; текст в ассертах — импорт скомпилированного сообщения из каталога `uk` (`import { messages } from '@crm/shared/i18n/locales/uk/messages'` + `messages['<id>']`), не литералом (`playwright-patterns` §10, `russian-language.md`).
- `git add` явным списком; `DATABASE_URL= git push`; без `--no-verify`; коммиты с `ac_verified: <номера>`.
- После каждого Edit/Write `.ts`/`.tsx` → `mcp__eslint__lint-files`; `lingui/no-unlocalized-strings` пока `warn` (этап 6 включит `error') — ноль новых warning на строках, которые эта волна и так трогает, обязателен.
- `pnpm i18n:extract` (== `lingui extract --clean`) идемпотентен: второй прогон подряд не меняет `.po`-файлы. CI-гейт «i18n catalogs are in sync» (`ci.yml`) уже это проверяет — воспроизвести локально перед push.
- Каждый PR: design tier 2 (правка существующего экрана — conformance, не полная генерация), `copy-reviewer` вердикт по `uk` **и** `en` отдельно, скриншоты 320/1440 на обоих языках, `pnpm mutation:changed` на диффе.
- Зона: весь диапазон файлов волны — `apps/web/**` + `packages/shared/src/i18n/format.ts` (расширение, не переписывание) — Coder-зона. Тестовые файлы — тоже Coder (не AutoTest: это не новый `.spec.ts`, а правка ассертов внутри уже смигрировавших модулей, часть той же задачи).

---

## Периметр волны (a) — как получен и почему он ýже, чем буквальная команда

Задание требовало снять периметр командой:

```bash
git ls-files apps/web/app | grep -E '^apps/web/app/(components/(ui|layout)|lib|hooks|routes/(__root|index|login|_auth)[^/]*|router)'
```

**Эта команда даёт неверный периметр**, и это проверено запуском, а не предположением: `grep -E` без `$` на конце делает **префиксный**, а не точный, матч — `routes/(_auth)[^/]*` матчит `routes/_authenticated` и ЛЮБОЙ хвост после него, включая `/`. На деле команда возвращает **все** файлы под `routes/_authenticated/**` — `finance/`, `interviews/`, `projects/`, `vacancies/`, `team/`, `users/`, `profile/`, `documents.tsx`, `stats.tsx` — то есть волны (b)–(e) целиком, вопреки §7 спеки, которая явно распределяет их по другим волнам. Прогон:

```bash
git ls-files apps/web/app | grep -E '^apps/web/app/(components/(ui|layout)|lib|hooks|routes/(__root|index|login|_auth)[^/]*|router)' | wc -l
# 269 файлов — это ВСЯ apps/web/app/routes/_authenticated, не только каркас
```

Дальше: буквальный список **пропускает** файлы, которые аудит и сама спека относят к «каркасу» — `apps/web/app/components/crm/nav-sidebar.tsx` (весь `NAV_ITEMS`, `aria-label`-ы навигации — COPY-M-core-\*, самый цитируемый файл среза) и `StickyPageHeader.tsx` не попадают под `components/(ui|layout)`, а лежат в `components/crm/`; `apps/web/app/client.tsx` (SPA-вход, PWA-обвязка) не подпадает ни под один из перечисленных префиксов вовсе.

**Скорректированный периметр** — пересечение (а) буквального намерения задания («каркас, навигация, вход, общие компоненты `ui`/`layout`, `lib`/`hooks`»), (б) фактического содержания среза `web-core` аудита (209 файлов, 56 продуктовых с кириллицей вне комментариев — строки 138–152 аудита) и (в) §7 спеки, где волна (a) явно НЕ включает `finance`/`interviews`/`projects`/`vacancies`/`team`/`users`/`profile`/`documents`/`stats`/`pending` (это волны b–e). Это A1-решение — обратимо, docs-only, зафиксировано в «Допущения» ниже.

Итоговый периметр — **69 файлов разобраны** по трём PR (полные таблицы — в каждой задаче ниже; счёт — построчно по таблицам Task 1–3, не оценкой), из них **61 реально мигрирует текст**, 8 — проверены (`grep -noP` по кавычкам с кириллицей) и оставлены как есть (только комментарии, либо уже переведены этапом 2):

| PR      | Директории                                                                                                                                                                                                                                                                | Разобрано / мигрирует                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **PR1** | `components/{ui,layout,crm,archive}/**`, `components/admin/TosPdfPreview.tsx`, `routes/_authenticated/{index,route,routing}.tsx` + `routing/components/**`, `routes/_authenticated/admin/{route,login-as,tos.index,tos.new}.tsx`, `router.tsx`, `public/site.webmanifest` | 37 / 37 (список — Task 1)                        |
| **PR2** | `lib/**` (кроме `axios.ts`, `axios-utils.ts`, `axios-unsafe-settle.d.ts`, `use-logout.ts`, `telemetry/**`, `pwa-runtime-caching.ts`, `preload-reload.ts`, `sw-reload.ts`, `i18n.ts` — уже готов), `hooks/**`                                                              | 25 / 21 (список — Task 2, 4 без видимого текста) |
| **PR3** | `routes/login.tsx`, `routes/__root.tsx`, `client.tsx`, `lib/axios.ts`, `lib/axios-utils.ts`, `lib/telemetry/ErrorBoundary.tsx`, `index.html` (уже готов этапом 2 — только сверка)                                                                                         | 7 / 3 (список — Task 3, 4 без видимого текста)   |

`components/user-profile/**` (`UserProfileHeader.tsx`, `TeamTab.tsx`) уже частично тронуты этапом 2 (Task 8 — консолидация `ROLE_LABELS`), но остаются **вне периметра волны (a)**: это `web-people`, волна (b). Task 1 ниже вводит транзитный `useRoleLabel()` именно для того, чтобы не тянуть их правку сюда (см. «Опасность: ROLE_LABELS» в Task 1).

---

## Шаблоны миграции (легенда — по одному коду на паттерн, дальше в задачах — только ссылка на букву)

**A. Модульная константа → `msg` + `i18n._()` в рендере.**

```tsx
// было (apps/web/app/components/ui/role-select.tsx)
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  // ...
}

// стало
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'

export const ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor> = {
  ADMIN: msg`Адміністратор`,
  SENIOR: msg`Синьйор`,
  JUNIOR: msg`Джун`,
  HR: msg`HR`,
  ACCOUNTANT: msg`Бухгалтер`,
  DROP: msg`Дроп`,
}

export function useRoleLabel(role: Role): string {
  const { i18n } = useLingui()
  return i18n._(ROLE_LABEL_MESSAGES[role])
}
```

**B. JSX-текст → `<Trans>`.**

```tsx
// было
;<h3>Валидация выплат</h3>

// стало
import { Trans } from '@lingui/react/macro'
;<h3>
  <Trans>Приходи на перевірку</Trans>
</h3>
```

**C. Атрибут / императивная строка (`aria-label`, `toast.error`, `placeholder`) → `t` из `useLingui()`.**

```tsx
// было
<nav aria-label="Основная навигация">

// стало
import { useLingui } from '@lingui/react/macro'
function NavSidebar() {
  const { t } = useLingui()
  return <nav aria-label={t`Основна навігація`}>
}
```

**D. Числовая форма → `plural` (не-JSX) / `<Plural>` (JSX).**

```tsx
// было
count === 1 ? 'начисление' : 'начисления'

// стало (JSX — компонент, реагирует на смену локали через контекст)
import { Plural } from '@lingui/react/macro'
;<Plural
  value={count}
  one="# нарахування"
  few="# нарахування"
  many="# нарахувань"
  other="# нарахувань"
/>
```

```ts
// стало (не-JSX, внутри компонента — через useLingui().t, шаблон с plural)
import { useLingui } from '@lingui/react/macro'
const { t } = useLingui()
const label = t`${plural(count, { one: '# команда', few: '# команди', many: '# команд', other: '# команди' })}`
```

**E. Родовая форма, зависящая от роли (не число) → `select`.**

```tsx
// было
const roleGenitive = role === 'SENIOR' ? 'синьора' : 'дропа'

// стало
import { Trans } from '@lingui/react/macro'
;<Trans>
  Ви підтверджуєте архівацію {role === 'SENIOR' ? <Trans>синьйора</Trans> : <Trans>дропа</Trans>}
</Trans>
// либо, если варианты > 2, select-макрос:
import { select } from '@lingui/core/macro'
const roleGenitive = select(role, { SENIOR: 'синьйора', DROP: 'дропа', other: 'співробітника' })
```

**F. Форматирование даты/денег/чисел → `packages/shared/src/i18n/format.ts` вместо `toLocale*('ru-RU'|'en-US'|'uk-UA')`.**

```ts
// было (apps/web/app/lib/format-bytes.ts)
return `${rounded.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${units[unitIndex]}`

// стало
import { formatNumber, type Locale } from '@crm/shared'
export function formatBytes(bytes: number, locale: Locale): string {
  // ...
  return `${formatNumber(rounded, locale)} ${unitLabel(unitIndex, locale)}`
}
```

---

## Task 1 (PR1): каркас — `ui`/`layout`/`crm`/`archive`, навигация, дашборды, admin-guard

**Files:**

- Modify (полный список с числом строк-кандидатов, `grep -cP '[А-Яа-яЁё]'`, продуктовые файлы без тестов):

| Файл                                                    | Кир. строк | Паттерн(ы)                                        | Примечание                                                           |
| ------------------------------------------------------- | ---------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| `components/layout/notifications-bell.tsx`              | 66         | B, C, F (date-fns→Intl)                           | `date-fns/locale/ru` → `formatRelativeTime` (новая, см. Step 3)      |
| `components/archive/ArchiveConfirmDialog.tsx`           | 59         | B, D, E                                           | Самый дорогой файл — Step 6, отдельно                                |
| `routes/_authenticated/index.tsx`                       | 52         | B, C                                              | Роль-зависимый рендер дашборда                                       |
| `components/crm/nav-sidebar.tsx`                        | 44         | A, B, C                                           | `NAV_ITEMS` — Step 2                                                 |
| `routing/components/SeniorDashboard.tsx`                | 32         | B, C, F                                           | `fmtUsd` на `en-US` → `formatMoney`                                  |
| `routing/components/EarningsStatsBlock.tsx`             | 32         | B, F                                              | `RU_MONTHS`/`ruMonthYear` → `Intl.DateTimeFormat` через `formatDate` |
| `routing/components/DropDashboard.tsx`                  | 32         | B, C, D, F                                        | «Начислений: N» — plural                                             |
| `routing/components/DropBalanceCard.tsx`                | 24         | B, D, F                                           | COPY-H-core-1 (направление долга) — Step 4                           |
| `routing/components/AccountantDashboard.tsx`            | 24         | B, F                                              | COPY-H-core-3 («Валидация выплат» → «приходи»)                       |
| `routing/components/PendingProjectApprovalsPanel.tsx`   | 20         | B                                                 | —                                                                    |
| `routing/components/InProgressPanel.tsx`                | 17         | B                                                 | —                                                                    |
| `routes/_authenticated/admin/tos.new.tsx`               | 16         | B, C                                              | —                                                                    |
| `routing/components/HRDashboard.tsx`                    | 15         | B                                                 | —                                                                    |
| `routing/components/EarningsSparkline.tsx`              | 15         | B, D, F                                           | `MONTH_ABBR` → `formatDate`; «Нет данных за период» COPY-L-core-25   |
| `routes/_authenticated/admin/login-as.tsx`              | 12         | A (ROLE_LABEL_MESSAGES), B                        | COPY-M-core-12 (текст ссылается на подпись баннера дословно)         |
| `components/ui/image-upload-field.tsx`                  | 12         | B, C                                              | COPY-M-core-11 — MIME/предел из `DOCUMENT_MAX_BYTES`                 |
| `components/admin/TosPdfPreview.tsx`                    | 11         | B, C                                              | 429-текст — Step 5 (дедуп с PR3)                                     |
| `routes/_authenticated/admin/tos.index.tsx`             | 9          | B                                                 | —                                                                    |
| `routes/_authenticated/admin/route.tsx`                 | 9          | C                                                 | COPY-M-core-18 — Step 4                                              |
| `components/archive/CascadeUnarchiveModal.tsx`          | 9          | B                                                 | —                                                                    |
| `routes/_authenticated/route.tsx`                       | 8          | B                                                 | —                                                                    |
| `components/ui/upload-progress.tsx`                     | 8          | B, C                                              | —                                                                    |
| `routes/_authenticated/routing.tsx`                     | 7          | B                                                 | —                                                                    |
| `components/ui/role-select.tsx`                         | 7          | A                                                 | Канон — Step 2                                                       |
| `components/ui/share-slider.tsx`                        | 6          | A, E                                              | COPY-M-core-10 — своя локальная карта, падеж                         |
| `components/archive/ArchivePendingTransactionsList.tsx` | 5          | B, F                                              | `formatPeriod` — COPY-M-core-13                                      |
| `components/ui/amount-currency-input.tsx`               | 4          | C, F                                              | `uk-UA` → `formatMoney`                                              |
| `components/layout/ImpersonationBanner.tsx`             | 4          | A (заменить `ROLE_LABELS[...]` на `useRoleLabel`) | —                                                                    |
| `components/ui/tech-autocomplete-input.tsx`             | 3          | C                                                 | COPY-M-core-5, склейка `aria-label`                                  |
| `components/ui/phone-input.tsx`                         | 3          | C                                                 | —                                                                    |
| `components/ui/crm-dialog.tsx`                          | 3          | B                                                 | —                                                                    |
| `components/ui/command.tsx`                             | 2          | B                                                 | —                                                                    |
| `components/ui/calendar.tsx`                            | 2          | A, F                                              | `MONTHS_SHORT`/`MONTHS_FULL` → `Intl.DateTimeFormat` месяцы          |
| `components/ui/segmented-toggle.tsx`                    | 1          | B                                                 | —                                                                    |
| `components/ui/dialog.tsx`                              | 1          | B                                                 | —                                                                    |
| `components/ui/date-picker.tsx`                         | 1          | B                                                 | —                                                                    |
| `public/site.webmanifest`                               | —          | статика                                           | COPY-M-core-14 — Step 7                                              |

- Test (обновить существующие, текст из каталога `uk` вместо литерала): `components/crm/__tests__/nav-sidebar.test.tsx`, `components/crm/__tests__/nav-sidebar.route-access.test.tsx`, `components/layout/__tests__/{ImpersonationBanner.spec.tsx,notifications-bell.footer-link.test.tsx,notifications-bell.render.test.tsx}`, `components/ui/__tests__/{date-picker,tech-autocomplete-input,amount-currency-input,upload-progress}.test.tsx`, `components/archive/__tests__/ArchivePendingTransactionsList.test.tsx`, `routing/components/__tests__/{AccountantDashboard,DropBalanceCard,DropDashboard,EarningsSparkline,HRDashboard,PendingProjectApprovalsPanel,SeniorDashboard}.test.tsx`, `routes/_authenticated/admin/__tests__/login-as.spec.tsx`.
- E2E (`grep -l` по кириллице в файлах, покрывающих затронутые роуты — некоторые ассерты бьют по тексту вне волны (a) и НЕ трогаются, см. Step 8): `apps/e2e/tests/navigation.spec.ts`, `apps/e2e/tests/dashboard-russian-strings.spec.ts`, `apps/e2e/tests/accountant-dashboard.spec.ts`, `apps/e2e/tests/hr-dashboard.spec.ts`, `apps/e2e/tests/drop-routing-hub.spec.ts`, `apps/e2e/tests/auth.spec.ts` (частично — nav-текст на странице после входа).

**Interfaces:**

- Consumes: `formatDate`, `formatNumber`, `formatMoney`, `compareNames`, `type Locale` из `@crm/shared` (этап 2, Task 2); `useLocale()` из `@/lib/i18n` (этап 2, Task 6); `activateLocale` не используется здесь напрямую.
- Produces: `formatRelativeTime(value: Date | string, locale: Locale): string` — добавляется в `packages/shared/src/i18n/format.ts` этим PR (единственное расширение shared-пакета в волне a; используется PR1 и, в будущем, волной (e) для `notifications`/`/pending`). `ROLE_LABEL_MESSAGES: Record<Role, MessageDescriptor>` + `useRoleLabel(role: Role): string` из `@/components/ui/role-select` — новый канон для JSX; **старый** `ROLE_LABELS: Record<Role, string>` остаётся экспортированным БЕЗ ИЗМЕНЕНИЙ (см. «Опасность» ниже) для консумеров вне волны (a).

### Опасность: `ROLE_LABELS` — общий экспорт, часть потребителей вне волны (a)

`role-select.tsx`'s `ROLE_LABELS: Record<Role, string>` импортируют **10 файлов**, из них только 2 (`ImpersonationBanner.tsx`, сам `role-select.tsx`) в периметре этой волны. Остальные восемь — `components/user-profile/{UserProfileHeader,tabs/TeamTab,contract/ContractTab}.tsx`, `components/users/{constants.ts,UserRow.tsx,UserDialog.tsx}`, `routes/_authenticated/{projects/$projectId.tsx,admin/{contracts.index,contracts.$role}.tsx,team/$teamId.tsx,users/index.tsx}`, `routes/_authenticated/interviews/components/CreateProjectFromHiredDialog.tsx` — принадлежат волнам (b)/(c), которые ещё не написаны. Если поменять **тип** `ROLE_LABELS` на `Record<Role, MessageDescriptor>`, все восемь ломаются на typecheck (`{ROLE_LABELS[role]}` в JSX ожидает `ReactNode`-совместимую строку, получает объект) и в рантайме покажут `[object Object]`.

**Решение — Шаблон A с транзитным дублем, не заменой:** `ROLE_LABEL_MESSAGES` + `useRoleLabel()` — НОВЫЙ экспорт. `ROLE_LABELS` остаётся как есть (русский, eager) до тех пор, пока волны (b)/(c) не переведут своих восьмерых потребителей на `useRoleLabel()` — тогда `ROLE_LABELS` удаляется отдельной задачей той волны. Эта волна трогает **только** свои два файла (`role-select.tsx` — сам рендер `<SelectItem>`, `ImpersonationBanner.tsx` — `const roleName = ...`).

- [ ] **Step 1: Тест на `useRoleLabel` (падает)**

```tsx
// apps/web/app/components/ui/__tests__/role-select.locale.test.tsx (новый файл)
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { I18nProvider } from '@lingui/react'
import { i18n } from '@lingui/core'
import { messages as ukMessages } from '@crm/shared/i18n/locales/uk/messages'
import { messages as enMessages } from '@crm/shared/i18n/locales/en/messages'
import { useRoleLabel } from '../role-select'

function withLocale(locale: 'uk' | 'en') {
  i18n.loadAndActivate({ locale, messages: locale === 'uk' ? ukMessages : enMessages })
  return ({ children }: { children: React.ReactNode }) => (
    <I18nProvider i18n={i18n}>{children}</I18nProvider>
  )
}

describe('useRoleLabel', () => {
  it('translates ADMIN per active locale', () => {
    const { result: uk } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: withLocale('uk') })
    expect(uk.current).toBe('Адміністратор')
    const { result: en } = renderHook(() => useRoleLabel('ADMIN'), { wrapper: withLocale('en') })
    expect(en.current).toBe('Admin')
  })
  it('leaves the legacy ROLE_LABELS export untouched (type: string) for not-yet-migrated consumers', async () => {
    const { ROLE_LABELS } = await import('../role-select')
    expect(typeof ROLE_LABELS.ADMIN).toBe('string')
  })
})
```

- [ ] **Step 2: Run → FAIL, затем реализация `role-select.tsx` + `nav-sidebar.tsx`**

Run: `pnpm --filter @crm/web test -- role-select.locale.test.tsx` → FAIL (`useRoleLabel` не экспортирован).

`role-select.tsx`: добавить `ROLE_LABEL_MESSAGES`/`useRoleLabel` по Шаблону A (код выше в «Шаблоны миграции»); `RoleSelect`'s `<SelectItem>` переключить на `useRoleLabel(role)`; `ariaLabel` default (`'Роль'`) → `t`\`Роль\` через `useLingui()`.

`nav-sidebar.tsx`: `NAV_ITEMS` → `label: MessageDescriptor` (Шаблон A, `msg` на каждую подпись — «Мій проект», «Легенда», «Дашборд», «Чекають рішення», «Користувачі», «Адмін», «Команда», «Проєкти», «Фінанси», «Статистика», «Співбесіди», «Документи», «Вакансії», «Профіль»); в `.map()`, где рендерятся пункты, — `i18n._(item.label)` через `useLingui()`. Два `aria-label="Основная навигация"` → Шаблон C (`t`\`Основна навігація\`); `aria-label={collapsed ? 'Развернуть' : 'Свернуть'}` → `t`\`Розгорнути\`/`t`\`Згорнути\`.

- [ ] **Step 3: `formatRelativeTime` + `notifications-bell.tsx`**

```ts
// packages/shared/src/i18n/format.ts — добавить
export function formatRelativeTime(value: Date | string, locale: Locale): string {
  const d = typeof value === 'string' ? new Date(value) : value
  const diffSeconds = Math.round((d.getTime() - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: 'auto' })
  const abs = Math.abs(diffSeconds)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ]
  for (const [unit, secondsPerUnit] of units) {
    if (abs >= secondsPerUnit || unit === 'second') {
      return rtf.format(Math.round(diffSeconds / secondsPerUnit), unit)
    }
  }
  return rtf.format(0, 'second')
}
```

```ts
// packages/shared/src/i18n/format.spec.ts — добавить кейс
it('formatRelativeTime renders "X minutes ago" per locale', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
  expect(formatRelativeTime(fiveMinAgo, 'en')).toBe('5 minutes ago')
})
```

`notifications-bell.tsx`: удалить `import { formatDistanceToNow } from 'date-fns'` и `import { ru } from 'date-fns/locale'`; заменить вызов на `formatRelativeTime(iso, locale)` (локаль — `useLocale()` из `@/lib/i18n`). Остальные JSX-строки — Шаблон B/C.

- [ ] **Step 4: `DropBalanceCard.tsx` (COPY-H-core-1) и `admin/route.tsx` (COPY-M-core-18)**

`DropBalanceCard.tsx`: подпись «Долг компании» → `<Trans>Ви маєте сплатити компанії</Trans>`, подсказка → `<Trans>Підтверджені прибутки, які ви ще не перерахували</Trans>` — направление долга исправлено согласно находке, не просто переведено дословно. «начисление»/«начисления» (COPY-M-core-6, слово из `_Избегать_`) → `<Trans>Зобов'язання</Trans>` + Шаблон D для числа.

`admin/route.tsx`:

```tsx
// было: toast.error('Доступ только для ADMIN')
import { useLingui } from '@lingui/react/macro'
// внутри компонента-guard'а:
const { t } = useLingui()
const roleLabel = useRoleLabel('ADMIN') // из '@/components/ui/role-select'
toast.error(t`Розділ доступний лише для ролі «${roleLabel}»`)
```

- [ ] **Step 5: `TosPdfPreview.tsx` — 429-текст, канон с PR3**

COPY-M-core-16: `TosPdfPreview.tsx` и `lib/axios-utils.ts` (`STATUS_MESSAGES[429]`) говорят про 429 двумя разными фразами. Канон живёт в PR3 (Task 3, `axios-utils.ts` — это файл, отвечающий за коды статусов). Здесь, в PR1: `TosPdfPreview.tsx` получает СВОЙ `msg`-дескриптор с окончательным текстом сейчас (PR1 landing первым), а PR3 (Task 3, Step 2) при миграции `STATUS_MESSAGES[429]` **обязан** взять тот же текст дословно (не изобретать заново) — проверяется `grep` в Step 2 Task 3.

```tsx
// TosPdfPreview.tsx
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
const RATE_LIMIT_MESSAGE = msg`Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз.`
// в компоненте:
const { i18n } = useLingui()
if (getAxiosStatus(err) === 429) toast.error(i18n._(RATE_LIMIT_MESSAGE))
```

- [ ] **Step 6: `ArchiveConfirmDialog.tsx` — самый дорогой файл (Шаблоны B, D, E)**

`ROLE_RU: Record<string, string>` (родительный падеж, ключа `DROP` нет — баг, `.SENIOR` читается для DROP тоже) → удалить, заменить точечными `<Trans>`/`select` в месте использования (Шаблон E) — DROP получает СВОЮ форму, а не читает чужую. `roleGenitive` тернарка → `select` (Шаблон E). `renderImpactText`'s числа (`impact.projectsCount`, `impact.hrAccountantsOnTeam`, `impact.juniorsAffected`) → `<Plural>` (Шаблон D) вместо голых `{n}`, т. к. окружающий текст на uk обязан склоняться («0 проєктів» / «1 проєкт» / «2 проєкти» / «5 проєктів» — 4 формы, не 2 английские). Остальные 16 JSX-склеек файла — тот же приём (`<Trans>` со слотами `{impact.teamName}` и т. п., по образцу `renderImpactText` — не переписывать логику ветвления, только текстовые узлы).

- [ ] **Step 7: `site.webmanifest`**

```json
{
  "name": "CRM CheekyCheeseIT",
  "short_name": "CRM CheekyCheeseIT",
  "description": "Робочий простір команди: проєкти, фінанси, документи",
  "lang": "uk",
  ...
}
```

Манифест — статический JSON, не React; локализовать под `en` пока некуда встраивать (PWA-манифест не перезагружается по смене языка в рантайме) — оставить украинский текст с явным `lang: "uk"` (было: ни текста о продукте, ни `lang` вовсе) и зафиксировать это как техническое ограничение в PR body, не как недоделку.

- [ ] **Step 8: E2E — точечная сверка, не файл целиком**

Для каждого файла из списка E2E выше: `grep -n '[А-Яа-яЁё]'` → для строк, ссылающихся на **мигрированный** в этом PR текст (навигация, дашборды, admin-guard), заменить литерал на импорт из скомпилированного `uk`-каталога:

```ts
// apps/e2e/tests/navigation.spec.ts — было
await expect(page.getByRole('link', { name: 'Дашборд' })).toBeVisible()
// стало
import { messages } from '@crm/shared/i18n/locales/uk/messages'
const dashboardLabel = messages['<id из lingui extract для "Дашборд">']
await expect(page.getByRole('link', { name: dashboardLabel })).toBeVisible()
```

Строки, ссылающиеся на ЕЩЁ не мигрированные страницы (`/finance`, `/projects` содержимое, а не только заголовок в nav) — **не трогать**, они останутся красными до соответствующей волны только если реально проверяют мигрированный текст; иначе они и сейчас зелёные на русском и таковыми остаются.

- [ ] **Step 9: Прогон, гейты, коммит**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales  # идемпотентность
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
pnpm --filter @crm/shared test -- src/i18n/format.spec.ts
DATABASE_URL= pnpm --filter @crm/e2e test -- navigation dashboard-russian-strings accountant-dashboard hr-dashboard drop-routing-hub auth
pnpm mutation:changed
# Явный список (git-policy.md — НЕ добавлять директориями целиком, чтобы не
# подмести чужие debug-артефакты из worktree). Продуктовые файлы — 36 из
# таблицы выше (37-й, site.webmanifest, отдельно) + новый role-select.locale.test.tsx:
git add \
  apps/web/app/components/layout/notifications-bell.tsx \
  apps/web/app/components/archive/ArchiveConfirmDialog.tsx \
  apps/web/app/components/archive/CascadeUnarchiveModal.tsx \
  apps/web/app/components/archive/ArchivePendingTransactionsList.tsx \
  apps/web/app/routes/_authenticated/index.tsx \
  apps/web/app/routes/_authenticated/route.tsx \
  apps/web/app/routes/_authenticated/routing.tsx \
  apps/web/app/routes/_authenticated/routing/components/SeniorDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/EarningsStatsBlock.tsx \
  apps/web/app/routes/_authenticated/routing/components/DropDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/DropBalanceCard.tsx \
  apps/web/app/routes/_authenticated/routing/components/AccountantDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/PendingProjectApprovalsPanel.tsx \
  apps/web/app/routes/_authenticated/routing/components/InProgressPanel.tsx \
  apps/web/app/routes/_authenticated/routing/components/HRDashboard.tsx \
  apps/web/app/routes/_authenticated/routing/components/EarningsSparkline.tsx \
  apps/web/app/routes/_authenticated/admin/tos.new.tsx \
  apps/web/app/routes/_authenticated/admin/tos.index.tsx \
  apps/web/app/routes/_authenticated/admin/route.tsx \
  apps/web/app/routes/_authenticated/admin/login-as.tsx \
  apps/web/app/components/crm/nav-sidebar.tsx \
  apps/web/app/components/ui/image-upload-field.tsx \
  apps/web/app/components/admin/TosPdfPreview.tsx \
  apps/web/app/components/ui/upload-progress.tsx \
  apps/web/app/components/ui/role-select.tsx \
  apps/web/app/components/ui/share-slider.tsx \
  apps/web/app/components/ui/amount-currency-input.tsx \
  apps/web/app/components/layout/ImpersonationBanner.tsx \
  apps/web/app/components/ui/tech-autocomplete-input.tsx \
  apps/web/app/components/ui/phone-input.tsx \
  apps/web/app/components/ui/crm-dialog.tsx \
  apps/web/app/components/ui/command.tsx \
  apps/web/app/components/ui/calendar.tsx \
  apps/web/app/components/ui/segmented-toggle.tsx \
  apps/web/app/components/ui/dialog.tsx \
  apps/web/app/components/ui/date-picker.tsx \
  apps/web/app/router.tsx \
  apps/web/public/site.webmanifest \
  apps/web/app/components/ui/__tests__/role-select.locale.test.tsx \
  apps/web/app/components/crm/__tests__/nav-sidebar.test.tsx \
  apps/web/app/components/crm/__tests__/nav-sidebar.route-access.test.tsx \
  apps/web/app/components/layout/__tests__/ImpersonationBanner.spec.tsx \
  apps/web/app/components/layout/__tests__/notifications-bell.footer-link.test.tsx \
  apps/web/app/components/layout/__tests__/notifications-bell.render.test.tsx \
  apps/web/app/components/ui/__tests__/date-picker.test.tsx \
  apps/web/app/components/ui/__tests__/tech-autocomplete-input.test.tsx \
  apps/web/app/components/ui/__tests__/amount-currency-input.test.tsx \
  apps/web/app/components/ui/__tests__/upload-progress.test.tsx \
  apps/web/app/components/archive/__tests__/ArchivePendingTransactionsList.test.tsx \
  apps/web/app/routes/_authenticated/admin/__tests__/login-as.spec.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/AccountantDashboard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/DropBalanceCard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/DropDashboard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/EarningsSparkline.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/HRDashboard.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/PendingProjectApprovalsPanel.test.tsx \
  apps/web/app/routes/_authenticated/routing/components/__tests__/SeniorDashboard.test.tsx \
  packages/shared/src/i18n/format.ts \
  packages/shared/src/i18n/format.spec.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/navigation.spec.ts \
  apps/e2e/tests/dashboard-russian-strings.spec.ts \
  apps/e2e/tests/accountant-dashboard.spec.ts \
  apps/e2e/tests/hr-dashboard.spec.ts \
  apps/e2e/tests/drop-routing-hub.spec.ts \
  apps/e2e/tests/auth.spec.ts
git commit -m "$(cat <<'EOF'
feat(web,shared,i18n): stage 3a wave (a) part 1 — shell, nav, dashboards, admin guard to uk/en

ac_verified: n/a (see task file AC list)
EOF
)"
```

Design tier 2 (правка существующего экрана): скриншоты 320/1440 для nav-sidebar (collapsed/expanded), каждый из пяти дашбордов, admin-guard toast, ArchiveConfirmDialog — на `uk` и `en`. `copy-reviewer` вердикт по обоим языкам отдельно (`Copy Review: PASS|ISSUES|BLOCK`).

---

## Task 2 (PR2): `lib`/`hooks` — форматирование, сортировка, множественные формы

**Files:**

| Файл                              | Кир. строк | Паттерн(ы) | Примечание                                                                                                                                                                             |
| --------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/use-user-profile.ts`       | 50         | B, C       | COPY-M-core-8 — «хвост» в переменной, Step 4                                                                                                                                           |
| `lib/pwa-runtime-caching.ts`      | 36         | —          | **Только комментарии, видимого текста нет** — проверено `grep` по кавычкам, 0 совпадений. НЕ мигрировать, пропустить                                                                   |
| `hooks/use-document-blob.ts`      | 31         | —          | Тоже только комментарии — пропустить                                                                                                                                                   |
| `lib/format-bytes.ts`             | 8          | F          | `formatBytes(bytes, locale)` — Step 2                                                                                                                                                  |
| `hooks/use-vacancies.ts`          | 10         | B, C       | Общие toast-и (не вакансии-контент — тот в волне c)                                                                                                                                    |
| `hooks/use-documents.ts`          | 10         | B, C       | Общие toast-и (не документы-контент — тот в волне e)                                                                                                                                   |
| `hooks/use-archive.ts`            | 9          | B, C       | —                                                                                                                                                                                      |
| `hooks/use-credentials.ts`        | 8          | B, C       | COPY-M-core-8 — Step 4                                                                                                                                                                 |
| `lib/notification-type-icon.tsx`  | 7          | B          | Общий helper, не сами уведомления                                                                                                                                                      |
| `hooks/use-legend.ts`             | 4          | B, C       | COPY-M-core-8 — Step 4                                                                                                                                                                 |
| `lib/documents-filter-sort.ts`    | 6          | A          | `SORT_OPTIONS` — Step 3 (`compareNames` уже мигрирован этапом 2, Task 8)                                                                                                               |
| `hooks/use-senior-resume.ts`      | 6          | B, C       | —                                                                                                                                                                                      |
| `hooks/use-project-approvals.ts`  | 6          | B, C       | —                                                                                                                                                                                      |
| `hooks/use-pending-items.ts`      | 6          | B, C       | —                                                                                                                                                                                      |
| `lib/invoice-labels.ts`           | 5          | A          | COPY-H-core-4 — Step 5, дедуп с `ArchivePendingTransactionsList.TYPE_LABEL` (PR1, уже смёржен)                                                                                         |
| `hooks/use-job-sourcing.ts`       | 5          | B, C       | —                                                                                                                                                                                      |
| `lib/format-amount.ts`            | 2          | F          | `formatAmount`/`formatAmountUsd` → `formatMoney` — Step 2                                                                                                                              |
| `hooks/use-invoices.ts`           | 2          | B          | COPY-M-core-7 — «Инвойс» → «Рахунок»                                                                                                                                                   |
| `hooks/use-admin-summary.ts`      | 2          | B, C       | —                                                                                                                                                                                      |
| `hooks/use-active-team.ts`        | 2          | B, C       | —                                                                                                                                                                                      |
| `hooks/use-accountant-summary.ts` | 2          | B, C       | —                                                                                                                                                                                      |
| `hooks/use-senior-summary.ts`     | 1          | B, C       | —                                                                                                                                                                                      |
| `hooks/use-hr-summary.ts`         | 1          | B, C       | —                                                                                                                                                                                      |
| `lib/route-access.ts`             | 59         | —          | **Все 59 строк — JSDoc-комментарии, 0 видимого текста** (подтверждено аудитом, строки 150–152: «route-access.ts — 59 кириллических строк и ноль видимых пользователю»). НЕ мигрировать |
| `lib/use-logout.ts`               | 10         | —          | Только комментарии — пропустить                                                                                                                                                        |

- Test: обновить `documents-filter-sort.spec.ts` (labels), `hooks/__tests__/use-invoices.test.ts`, `hooks/__tests__/use-notification-preferences.test.tsx` (если ссылается на toast-текст use-хуков), `lib/format-bytes.test.ts`, добавить `lib/format-amount.spec.ts` (файл сейчас без теста — новый).
- E2E: `apps/e2e/tests/crm/documents-search-sort.spec.ts` (16 строк кириллицы — сортировка-лейблы).

**Interfaces:**

- Consumes: `formatMoney`, `formatNumber`, `compareNames`, `type Locale`, `useLocale()` (уже есть).
- Produces: `formatBytes(bytes: number, locale: Locale): string` (сигнатура меняется — добавляется обязательный `locale`; все 6 вызовов по `apps/web` обновляются в этом же PR, `grep -rn 'formatBytes('`), `SORT_OPTIONS: Array<{ value: SortKey; label: MessageDescriptor }>`, `useInvoiceTypeLabel(type: InvoiceTypeForLabel): string` — НОВЫЙ хук в `invoice-labels.ts` (Шаблон A); легаси `getInvoiceTypeLabel(type): string` остаётся БЕЗ ИЗМЕНЕНИЙ (см. «Опасность» в Step 5 — те же основания, что и `ROLE_LABELS` в Task 1).

- [ ] **Step 1: Тест `formatBytes` с локалью (падает)**

```ts
// apps/web/app/lib/format-bytes.test.ts
import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes'

describe('formatBytes', () => {
  it('formats with locale-appropriate decimal separator and unit', () => {
    expect(formatBytes(2_345_678, 'uk')).toBe('2,2 МБ')
    expect(formatBytes(2_345_678, 'en')).toBe('2.2 MB')
  })
  it('uses English unit abbreviations for en', () => {
    expect(formatBytes(1024, 'en')).toBe('1.0 KB')
  })
})
```

- [ ] **Step 2: Run → FAIL, реализация `formatBytes` + `format-amount.ts`**

```ts
// apps/web/app/lib/format-bytes.ts
import { formatNumber, type Locale } from '@crm/shared'

const UNITS: Record<Locale, readonly string[]> = {
  uk: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'],
  en: ['B', 'KB', 'MB', 'GB', 'TB'],
}

export function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `0 ${UNITS[locale][0]}`
  if (bytes < 1024) return `${bytes} ${UNITS[locale][0]}`

  const units = UNITS[locale]
  let value = bytes / 1024
  let unitIndex = 1

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = Math.round(value * 10) / 10
  return `${formatNumber(rounded, locale)} ${units[unitIndex]}`
}
```

`format-amount.ts`: `formatAmount(amount)` (было `ru-RU`) и `formatAmountUsd(amount)` (было `en-US`) переписать через `formatMoney(amount, currency, locale)` из `@crm/shared`, добавив параметр `locale: Locale` каждой функции; обновить все вызовы (`grep -rln "formatAmount\|formatAmountUsd" apps/web/app` — дашборды PR1 уже мигрируют свои вызовы туда же в Task 1 Step, здесь — только определения функций и вызовы вне PR1-файлов).

- [ ] **Step 3: `documents-filter-sort.ts` — `SORT_OPTIONS`**

```ts
// apps/web/app/lib/documents-filter-sort.ts
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

export const SORT_OPTIONS: Array<{ value: SortKey; label: MessageDescriptor }> = [
  { value: 'date_desc', label: msg`Спочатку нові` },
  { value: 'date_asc', label: msg`Спочатку старі` },
  { value: 'name_asc', label: msg`За ім'ям: за зростанням` },
  { value: 'name_desc', label: msg`За ім'ям: за спаданням` },
  { value: 'size_desc', label: msg`Розмір: більше` },
  { value: 'size_asc', label: msg`Розмір: менше` },
]
```

Убраны буквы алфавита («А-Я»/«Я-А») из лейблов — COPY-M-core-15, второй пункт находки (не только коллация, но и сама формулировка называла русский алфавит). Место рендера (toolbar документов, волна e) резолвит через `i18n._(option.label)` — здесь только определение; сам toolbar не трогается (вне периметра волны a), но компилируется корректно, т.к. `label` меняет тип с `string` на `MessageDescriptor` и **этот** toolbar-файл ещё не существует в мигрированном виде (он появится в волне e) — фиксируется как cross-wave допущение ниже.

- [ ] **Step 4: `use-credentials.ts`, `use-documents.ts`, `use-legend.ts`, `use-user-profile.ts` — единый паттерн тоста об ошибке**

COPY-M-core-8: 14 вхождений ``toast.error(`Ошибка: ${e.message}`)`` в этих 4 файлах. `e.message` после интерцептора (`axios.ts`) уже человекочитаемая фраза — префикс «Ошибка: » лишний, а какое действие сорвалось — не сказано.

```ts
// было (use-credentials.ts, 4 похожих места)
onError: (e) => toast.error(`Ошибка: ${e.message}`)

// стало — паттерн C, действие называет вызывающий код
import { useLingui } from '@lingui/react/macro'
// внутри hook-фабрики или компонента, использующего мутацию:
const { t } = useLingui()
onError: (e: Error) => toast.error(t`Не вдалося зберегти пароль: ${e.message}`)
```

Каждое из 14 мест получает своё название действия («Не вдалося зберегти пароль» / «Не вдалося видалити документ» / т.п.) по контексту конкретной мутации — не один общий текст на все.

- [ ] **Step 5: `invoice-labels.ts` — дедуп с архивом (COPY-H-core-4), легаси-экспорт сохранён**

`ArchivePendingTransactionsList.tsx` (PR1, уже смёржен) держит свой `TYPE_LABEL` с `SENIOR_INCOME: 'Доход синьора (неоплаченная доля)'`; `invoice-labels.ts` — `SENIOR_INCOME: 'Выплата синьора'`. Один enum — два текста, «выплата» на запрещённом месте.

**Опасность — та же, что у `ROLE_LABELS` в Task 1:** `getInvoiceTypeLabel(type): string` (текущий экспорт `invoice-labels.ts`) импортируют `components/invoices/invoice-card.tsx` и `components/invoices/invoice-detail-dialog.tsx` (`git grep -rn getInvoiceTypeLabel apps/web/app`) — это `web-finance` (волна d, аудит строка 415), НЕ волна (a). Менять сигнатуру `getInvoiceTypeLabel` сломало бы typecheck и рендер в этих двух файлах на несколько волн раньше их собственной миграции. Решение — Шаблон A с транзитным дублем: новый `useInvoiceTypeLabel()` для консумеров волны (a), легаси `getInvoiceTypeLabel` не трогается.

```ts
// apps/web/app/lib/invoice-labels.ts
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { useLingui } from '@lingui/react/macro'

const INVOICE_TYPE_MESSAGES: Record<InvoiceTypeForLabel, MessageDescriptor> = {
  SENIOR_INCOME: msg`Дохід синьйора`,
  SALARY: msg`Зарплата`,
}

/** Новый канон для консумеров волны (a)+; легаси `getInvoiceTypeLabel` (ниже,
 *  без изменений) обслуживает `components/invoices/**` (волна d) до их миграции. */
export function useInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  const { i18n } = useLingui()
  return i18n._(INVOICE_TYPE_MESSAGES[type])
}

export function getInvoiceTypeLabel(type: InvoiceTypeForLabel): string {
  if (type === 'SENIOR_INCOME') return 'Выплата синьора'
  if (type === 'SALARY') return 'Зарплата'
  return type
}
```

`ArchivePendingTransactionsList.tsx` (PR1, landing первым) при первом проходе получает СВОЙ `TYPE_LABEL`-текст «Дохід синьйора» уже согласованным дословно с `INVOICE_TYPE_MESSAGES` этого Step (тот же приём, что и 429-текст в Task 1 Step 5 — PR1 фиксирует канон текста заранее, PR2 при введении `useInvoiceTypeLabel` берёт его дословно, проверяется `grep` при ревью PR2); заменять локальный `TYPE_LABEL` в `ArchivePendingTransactionsList.tsx` на импорт `useInvoiceTypeLabel` — задача волны, где мигрирует `components/invoices/**` целиком (волна d), чтобы не оставлять хук с единственным потребителем наполовину смигрированным.

- [ ] **Step 6: Прогон, гейты, коммит**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- documents-search-sort
pnpm mutation:changed
# Явный список — 20 мигрирующих файлов из таблицы Task 2 (комментарий-only
# файлы route-access.ts/use-document-blob.ts/use-logout.ts/pwa-runtime-caching.ts
# не входят — их код не менялся):
git add \
  apps/web/app/hooks/use-user-profile.ts \
  apps/web/app/lib/format-bytes.ts \
  apps/web/app/lib/format-bytes.test.ts \
  apps/web/app/hooks/use-vacancies.ts \
  apps/web/app/hooks/use-documents.ts \
  apps/web/app/hooks/use-archive.ts \
  apps/web/app/hooks/use-credentials.ts \
  apps/web/app/hooks/use-legend.ts \
  apps/web/app/lib/notification-type-icon.tsx \
  apps/web/app/lib/documents-filter-sort.ts \
  apps/web/app/lib/documents-filter-sort.spec.ts \
  apps/web/app/hooks/use-senior-resume.ts \
  apps/web/app/hooks/use-project-approvals.ts \
  apps/web/app/hooks/use-pending-items.ts \
  apps/web/app/lib/invoice-labels.ts \
  apps/web/app/hooks/use-job-sourcing.ts \
  apps/web/app/lib/format-amount.ts \
  apps/web/app/lib/format-amount.spec.ts \
  apps/web/app/hooks/use-invoices.ts \
  apps/web/app/hooks/__tests__/use-invoices.test.ts \
  apps/web/app/hooks/use-admin-summary.ts \
  apps/web/app/hooks/use-active-team.ts \
  apps/web/app/hooks/use-accountant-summary.ts \
  apps/web/app/hooks/use-senior-summary.ts \
  apps/web/app/hooks/use-hr-summary.ts \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/crm/documents-search-sort.spec.ts
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3a wave (a) part 2 — lib/hooks formatting, sort labels, error toasts to uk/en

ac_verified: n/a (see task file AC list)
EOF
)"
```

Design tier 2: скриншоты toast-ов (ошибки credentials/documents/legend/profile) и sort-dropdown на 320/1440, `uk`+`en`. `copy-reviewer` по обоим языкам.

---

## Task 3 (PR3): вход, `__root`, ошибки, `ErrorBoundary`

**Files:**

| Файл                              | Кир. строк        | Паттерн(ы) | Примечание                                                                           |
| --------------------------------- | ----------------- | ---------- | ------------------------------------------------------------------------------------ |
| `routes/login.tsx`                | 27                | A          | `ERROR_MESSAGES` — Step 1                                                            |
| `lib/axios-utils.ts`              | 17                | A, B       | `STATUS_MESSAGES` + фолбэки — Step 2                                                 |
| `lib/telemetry/ErrorBoundary.tsx` | 6                 | B          | Реальная fallback-UI, единственный видимый текст в `telemetry/**`                    |
| `client.tsx`                      | 37                | —          | Только комментарии (SW/PWA reload-логика) — пропустить, проверено `grep` по кавычкам |
| `lib/axios.ts`                    | 0                 | —          | Нет кириллицы вовсе — не трогать                                                     |
| `routes/__root.tsx`               | 0                 | —          | Нет кириллицы — только сверить `I18nProvider` обёртку (уже сделано этапом 2)         |
| `index.html`                      | 0 (после этапа 2) | —          | `lang="uk"` уже выставлен Task 6 этапа 2 — только regression-сверка                  |

`lib/telemetry/{transport,form-abandon,error-dedupe,batcher,use-visibility-flush,state,validate-events,use-click-delegation,route-duration,config}.ts`, `lib/{preload-reload,sw-reload,use-logout}.ts`, `hooks/use-document-blob.ts`, `lib/pwa-runtime-caching.ts` — **все проверены `grep -noP` по строкам в кавычках с кириллицей: ноль реальных строковых литералов**, только JSDoc-комментарии (цитаты спек, объяснения алгоритма). Эти файлы — **вне периметра извлечения**; ESLint `lingui/no-unlocalized-strings` их не тронет (правило смотрит JSX-текст и строковые литералы в коде UI, не комментарии).

- Test: `lib/telemetry/ErrorBoundary.test.tsx` (уже существует — обновить ассерты), `routes/__tests__/login.search-schema.spec.ts` (см. Step 1 — держит per-code мутационные пины на прежних русских литералах `ERROR_MESSAGES`).
- E2E: `apps/e2e/tests/auth.spec.ts` (3 строки кириллицы — `?error=` коды из `ERROR_MESSAGES`, довершает то, что PR1 Step 8 оставил).

**Interfaces:**

- Consumes: `useLingui`, `i18n` (глобальный, из `@/lib/i18n`).
- Produces: `ERROR_MESSAGES: Record<string, MessageDescriptor>` (тип меняется с `Record<string,string>`; `ERROR_CODES = Object.keys(ERROR_MESSAGES)` — работает без изменений, ключи не меняются); канонический текст 429 (см. Task 1 Step 5) в `STATUS_MESSAGES`.

- [ ] **Step 1: `login.tsx` — `ERROR_MESSAGES`**

```tsx
// apps/web/app/routes/login.tsx
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

export const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
  unauthorized: msg`Ваш email не авторизовано. Зверніться до адміністратора.`,
  google_error: msg`Помилка Google OAuth. Спробуйте ще раз.`,
  invalid_state: msg`Сесія закінчилася. Спробуйте ще раз, будь ласка.`,
  invite_email_mismatch: msg`Ви увійшли в інший акаунт Google. Відкрийте посилання з листа ще раз і виберіть акаунт тієї адреси, на яку воно прийшло. Якщо акаунта Google на цій адресі немає — увійти по ньому не можна, напишіть адміністратору.`,
  invite_expired: msg`Термін дії запрошення закінчився. Попросіть адміністратора надіслати його ще раз.`,
  invite_used: msg`Запрошення вже використано — особисту адресу підтверджено. Увійдіть через Google кнопкою нижче.`,
  invite_invalid: msg`Посилання не працює. Відкрийте посилання з останнього листа, а якщо його немає — попросіть адміністратора надіслати запрошення ще раз.`,
  invite_account_taken: msg`Цей акаунт Google вже використовується для входу з іншої адреси. Зверніться до адміністратора.`,
  account_mismatch: msg`Ця адреса вже прив'язана до іншого акаунта Google. Увійдіть тим акаунтом, яким входили раніше, або напишіть адміністратору.`,
  account_disabled: msg`Доступ до CRM закрито. Якщо це помилка, напишіть адміністратору.`,
} as const satisfies Record<string, MessageDescriptor>

const ERROR_CODES = Object.keys(ERROR_MESSAGES) as [string, ...string[]]
```

Место рендера (компонент, показывающий `ERROR_MESSAGES[code]` рядом с `AlertCircle`) переключается на `i18n._(ERROR_MESSAGES[code])` через `useLingui()`.

`routes/__tests__/login.search-schema.spec.ts` пинит каждый код `ERROR_MESSAGES` отдельным мутационным тестом (мутация `StringLiteral` — см. комментарий в `login.tsx`, PR #623). Эти тесты проверяли РУССКИЙ текст напрямую литералом — после Step 1 текста-литералов в `ERROR_MESSAGES` больше нет (это `msg`-дескрипторы), поэтому тесты пина переключаются на проверку **ключей** (`Object.keys(ERROR_MESSAGES)` содержит ровно эти 10 кодов — сам список кодов, не их текст, остаётся тем, что мутация может испортить) плюс ОДИН новый тест «каждый код резолвится в непустую строку через `i18n._()` на обеих локалях» (закрывает то же наблюдаемое поведение, что раньше давали 10 отдельных строковых пинов, без копирования текста в тест — текст живёт только в `.po`-каталоге).

- [ ] **Step 2: `axios-utils.ts` — `STATUS_MESSAGES` + унификация фолбэков (COPY-L-core-22, COPY-M-core-16)**

```ts
// apps/web/app/lib/axios-utils.ts
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

const STATUS_MESSAGES: Readonly<Record<number, MessageDescriptor>> = {
  400: msg`Некоректний запит. Перевірте введені дані і спробуйте знову.`,
  401: msg`Потрібно увійти в систему знову.`,
  403: msg`Недостатньо прав для цієї дії.`,
  404: msg`Запитувані дані не знайдено.`,
  409: msg`Конфлікт даних. Оновіть сторінку і спробуйте знову.`,
  413: msg`Файл занадто великий.`,
  415: msg`Формат файлу не підтримується.`,
  // Канон 429 — тот же текст, что TosPdfPreview.tsx получил в PR1 Step 5:
  // "Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз." — сверить дословно.
  429: msg`Забагато запитів поспіль. Зачекайте трохи і спробуйте ще раз.`,
}

const SERVER_ERROR_MESSAGE = msg`Помилка на нашій стороні. Ми вже знаємо про проблему — спробуйте трохи пізніше.`
const GENERIC_HTTP_FALLBACK = msg`Не вдалося виконати запит. Спробуйте ще раз.`
const NETWORK_ERROR_MESSAGE = msg`Немає зв'язку із сервером. Перевірте підключення до інтернету і спробуйте знову.`
// COPY-L-core-22: было ДВА разных текста последнего рубежа
// (getApiErrorMessage's default param 'Произошла ошибка' vs
// UNKNOWN_ERROR_FALLBACK 'Произошла ошибка. Попробуйте ещё раз.') —
// один и тот же текст в обоих местах теперь.
const UNKNOWN_ERROR_FALLBACK = msg`Сталася помилка. Спробуйте ще раз.`

function messageForStatus(status: number, i18n: I18n): string {
  const known = STATUS_MESSAGES[status]
  if (known !== undefined) return i18n._(known)
  if (status >= 500) return i18n._(SERVER_ERROR_MESSAGE)
  return i18n._(GENERIC_HTTP_FALLBACK)
}
```

`getApiErrorMessage(err, fallback = i18n._(UNKNOWN_ERROR_FALLBACK))` — дефолт больше не хардкод `'Произошла ошибка'`, использует `UNKNOWN_ERROR_FALLBACK` (тот же текст, что и последний рубеж `getUserFacingErrorMessage`); `getUserFacingErrorMessage`, `messageForStatus` принимают `i18n` из глобального `@/lib/i18n` импорта (не через `useLingui()` — эта пара функций уже вызывается вне React-компонентов, из `axios.ts`-интерцептора, поэтому единственный корректный источник — глобальный singleton-инстанс `i18n`, тот же, что активирует `activateLocale`).

- [ ] **Step 3: `ErrorBoundary.tsx`**

```tsx
// apps/web/app/lib/telemetry/ErrorBoundary.tsx — fallback UI (было русским)
import { Trans } from '@lingui/react/macro'
// в render() fallback-ветке класс-компонента ErrorBoundary:
;<Trans>Щось пішло не так. Оновіть сторінку.</Trans>
```

Класс-компонент (React `ErrorBoundary` не может быть функциональным, `useLingui()` недоступен) — `<Trans>` работает и в классовых компонентах (это JSX-макрос, не хук), так что паттерн B применим напрямую без обёртки.

- [ ] **Step 4: Прогон, гейты, коммит**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v22' | tail -1)/bin:$PATH"
pnpm i18n:extract && pnpm i18n:extract && git diff --exit-code -- packages/shared/src/i18n/locales
pnpm i18n:compile
pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test
DATABASE_URL= pnpm --filter @crm/e2e test -- auth
pnpm mutation:changed
git add \
  apps/web/app/routes/login.tsx \
  apps/web/app/routes/__tests__/login.search-schema.spec.ts \
  apps/web/app/lib/axios-utils.ts \
  apps/web/app/lib/axios-utils.spec.ts \
  apps/web/app/lib/telemetry/ErrorBoundary.tsx \
  apps/web/app/lib/telemetry/ErrorBoundary.test.tsx \
  packages/shared/src/i18n/locales/uk/messages.po \
  packages/shared/src/i18n/locales/en/messages.po \
  apps/e2e/tests/auth.spec.ts
git commit -m "$(cat <<'EOF'
feat(web,i18n): stage 3a wave (a) part 3 — login errors, HTTP status messages, error boundary to uk/en

ac_verified: n/a (see task file AC list)
EOF
)"
```

Design tier 2: скриншоты login-страницы с каждым `?error=` кодом, error boundary fallback, на 320/1440, `uk`+`en`. `copy-reviewer` по обоим языкам. **Финальная сверка волны (a):** `git grep -n "includes('" apps/web/app` не находит ветвлений по тексту ошибки внутри периметра волны (аудит §4, второй пункт проверки); `git grep -c '[А-Яа-яЁё]'` по всем 69 разобранным файлам волны, за вычетом файлов, помеченных «только комментарии» в таблицах Task 1–3, даёт 0.

---

## Замена `ru-RU`/`en-US`/`uk-UA`/`date-fns/locale/ru` — полный список из аудита и куда переезжает

Аудит (табл. B, web-core) называет «9 мест» фиксированной локали денег/чисел + «4 массива» месяцев + «1 date-fns/ru» в этом срезе. Итого 14 точек в 12 файлах — все ниже, с указанием PR:

| #   | Файл                                                    | Что было                                                                                      | Заменяется на                                                                             | PR  |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --- |
| 1   | `components/ui/calendar.tsx`                            | `MONTHS_SHORT` (руками)                                                                       | `Intl.DateTimeFormat(locale, {month:'short'})` цикл по 12 месяцам                         | PR1 |
| 2   | `components/ui/calendar.tsx`                            | `MONTHS_FULL` (руками)                                                                        | `Intl.DateTimeFormat(locale, {month:'long'})`                                             | PR1 |
| 3   | `routing/components/EarningsSparkline.tsx`              | `MONTH_ABBR` (руками)                                                                         | `formatDate(d, locale, 'short')` на 1 число месяца                                        | PR1 |
| 4   | `routing/components/EarningsStatsBlock.tsx`             | `RU_MONTHS` + `ruMonthYear` (руками, именительный)                                            | `formatDate(d, locale, 'long')`                                                           | PR1 |
| 5   | `lib/format-amount.ts`                                  | `formatAmount` → `toLocaleString('ru-RU')`                                                    | `formatMoney(amount, 'UAH', locale)`                                                      | PR2 |
| 6   | `lib/format-amount.ts`                                  | `formatAmountUsd` → `toLocaleString('en-US')`                                                 | `formatMoney(amount, 'USD', locale)`                                                      | PR2 |
| 7   | `routing/components/AccountantDashboard.tsx`            | собственный `fmtUsd` на `en-US`                                                               | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 8   | `routing/components/DropBalanceCard.tsx`                | собственный `fmtUsd` на `en-US`                                                               | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 9   | `routing/components/DropDashboard.tsx`                  | собственный `fmtUsd` на `en-US`                                                               | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 10  | `routing/components/SeniorDashboard.tsx`                | собственный `fmtUsd` на `en-US`                                                               | `formatMoney(amount, 'USD', locale)`                                                      | PR1 |
| 11  | `components/ui/amount-currency-input.tsx`               | `toLocaleString('uk-UA')`                                                                     | `formatMoney`/`formatNumber(…, locale)`                                                   | PR1 |
| 12  | `components/archive/ArchivePendingTransactionsList.tsx` | `formatPeriod` → `toLocaleDateString('ru-RU')` (COPY-M-core-13, смешан с сырым `salaryMonth`) | `formatDate(d, locale, 'long')` для обеих веток (зарплата и дата) — единый формат, не два | PR1 |
| 13  | `lib/format-bytes.ts`                                   | `toLocaleString('ru-RU')` + кириллические единицы                                             | `formatNumber(rounded, locale)` + `UNITS[locale]` (Task 2 Step 2)                         | PR2 |
| 14  | `components/layout/notifications-bell.tsx`              | `date-fns/locale/ru` + `formatDistanceToNow`                                                  | `formatRelativeTime(iso, locale)` (Task 1 Step 3, новая функция в `format.ts`)            | PR1 |

`documents-filter-sort.ts`'s `localeCompare(…, 'ru')` — **уже заменён** этапом 2 (Task 8, `compareNames(locale)`), не входит в этот список повторно.

---

## Что НЕ входит

- **Волны (b)–(e)** целиком: `web-people` (команда, профиль, `UserDialog.tsx` ~2 500 строк, контракты), `web-projects` (проекты, собеседования, вакансии-контент), `web-finance` (финансы, `EXPENSE_CATEGORIES`, статистика, счета), `web-docs-notify` (документы-контент, уведомления, `/pending`-страница, routing уведомлений). Их файлы **не редактируются**, даже когда содержат дублирующиеся карты (`ROLE_LABELS`-консумеры вне волны — см. «Опасность» Task 1).
- **`apps/api`**, **`packages/shared`** (кроме одного расширения `format.ts` — `formatRelativeTime`) — этап 4 спеки.
- **PDF счетов** — этап 5.
- **`ESLint` error-режим, guard на русские буквы, финальный `extract --clean` как хард-гейт** — этап 6 (`lingui/no-unlocalized-strings` остаётся `warn` весь этап 3).
- **`share-slider.tsx`'s собственная ROLE_LABELS `.side`-карта** — трогается (COPY-M-core-10, паттерн E, падеж выровнен), но НЕ объединяется с каноном `role-select.tsx` (разная форма данных — `side`/`aria` пара, не простой ярлык); объединение — не задача этой волны.
- **`components/user-profile/**`, `components/users/**`, `routes/\_authenticated/{team,users,profile,projects,finance,interviews,vacancies,documents,stats,pending,onboarding,admin/{contracts.\*,wallet.index,ChangeWalletAddressDialog}}.tsx`** — волны (b)/(c)/(d)/(e), ROLE_LABELS-консумеры среди них остаются на легаси-экспорте до своей волны.
- **`LanguageSection.tsx`** (переключатель языка в профиле, этап 2 Task 7) — не подтверждён смёрженным на момент этого плана (не найден на `origin/main`); если ещё не смёржен к моменту исполнения — не блокирует эту волну, оба независимы.

---

## Допущения (A1 — обратимые, зафиксированы под запись)

1. **Периметр волны (a) скорректирован** относительно буквальной grep-команды задания (over-match на `_authenticated/**` из-за отсутствия `$`-якоря) в пользу пересечения аудита `web-core` + §7 спеки: добавлены `components/crm/**`, `components/archive/**`, `routing/components/**` (дашборды), `admin/{route,login-as,tos.*}.tsx`, `client.tsx`; исключены все файлы `_authenticated/{finance,interviews,projects,vacancies,team,users,profile,documents,stats,pending,onboarding}/**`.
2. **`ROLE_LABELS` (легаси, `Record<Role,string>`) не удаляется и не переименовывается** в этой волне — восемь консумеров вне периметра сломались бы на typecheck. Новый канон `ROLE_LABEL_MESSAGES`/`useRoleLabel()` — добавка, не замена; удаление легаси — задача волны (b)/(c), когда последний внешний консумер мигрирует. **Тот же приём и по той же причине** — для `getInvoiceTypeLabel`/`useInvoiceTypeLabel` в `invoice-labels.ts` (Task 2, Step 5): `components/invoices/**` (волна d) остаётся на легаси-экспорте.
3. **`formatBytes`, `formatAmount`, `formatAmountUsd`, `getInvoiceTypeLabel` меняют сигнатуру** (обязательный `locale`/`i18n` параметр) — все вызовы внутри периметра волны обновляются в том же PR; вызовов вне периметра на момент аудита не найдено (`grep -rln`, проверено выше), но это стоит перепроверить исполнителю непосредственно перед Step 2 каждой задачи (код мог измениться между планированием и исполнением).
4. **Комментарий-only файлы** (`route-access.ts`, `use-document-blob.ts`, `use-logout.ts`, `client.tsx`, `preload-reload.ts`, `pwa-runtime-caching.ts`, `sw-reload.ts`, большая часть `telemetry/**`) исключены из миграции по факту проверки (`grep -noP` по кавычкам с кириллицей — ноль совпадений), а не пропущены по недосмотру. ESLint `no-unlocalized-strings` их не флагует, т.к. правило смотрит на JSX/строковые литералы UI, не на комментарии.
5. **`site.webmanifest` остаётся одноязычным (uk)** — PWA-манифест не перезагружается при смене языка в рантайме браузера, второй манифест под `en` не заводится в рамках этой волны; зафиксировано как техническое ограничение, не недоделка.
6. **429-текст и `SENIOR_INCOME`-текст** — по одному канону каждый, установленному ПЕРВЫМ PR, который его трогает (PR1 landing первым); второй PR берёт готовый текст дословно (проверяется `grep` при ревью второго PR), вместо централизации в общий модуль — не создаётся новый общий файл ради двух текстов.
7. **`SORT_OPTIONS`** в `documents-filter-sort.ts` (PR2) меняет тип экспорта на `MessageDescriptor`, хотя единственный текущий консумер (`/documents` toolbar) сам ещё не мигрирован (волна e) — компилируется корректно (toolbar просто получает `MessageDescriptor` вместо `string` и продолжит рендерить его некорректно как `[object Object]` до своей волны). Это **временная регрессия на непереведённой странице**, которая уже показывает русский текст и попадёт под починку в волне (e) вместе с остальным модулем; альтернатива (не трогать `SORT_OPTIONS` до волны e) оставила бы аудиторскую находку COPY-M-core-15 незакрытой без причины — раз файл уже в периметре волны (a) по расположению (`lib/`), логичнее закрыть его целиком. Отмечается явно в PR2 body, чтобы `spec-reviewer` не спутал с настоящей регрессией.

## Вопросы владельцу (A2)

Нет. Все развилки этой волны — файловые границы, транзитные шимы и порядок PR — обратимы (docs-only план, ничего не задеплоено) и не затрагивают деньги/RBAC/прод-данные/публикацию наружу; классифицированы A1 выше.

---

## Проверка готовности волны (a)

- `pnpm --filter @crm/web typecheck && pnpm --filter @crm/web lint && pnpm --filter @crm/web test` — зелёные после каждого PR.
- `DATABASE_URL= pnpm --filter @crm/e2e test` на затронутых шардах — зелёные.
- `pnpm i18n:extract` дважды подряд — второй прогон не меняет `.po`.
- `pnpm mutation:changed` — без новых `Survived`/`NoCoverage` без объяснения (см. `mutation-gate-integration-specs.md` — `NoCoverage` с integration-hint допустим, без — нет).
- `git grep -c '[А-Яа-яЁё]'` по всем продуктовым файлам волны (69 разобрано, 61 реально мигрирует — «только комментарии» не считаются) — 0.
- `copy-reviewer`: `PASS` на `uk` и на `en` для каждого из 3 PR.
- Скриншоты 320/1440, `uk`+`en`, для каждого мигрированного экрана — в теле каждого PR.
