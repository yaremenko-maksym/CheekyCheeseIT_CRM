# Design Spec — Per-project Drop Share Override + Income Receiver Selector

> **Design tier:** 2 (правка существующих экранов)
> **design-gate:** degraded (Tier 2 conformance, Claude Design не задействован — текстовая спека)
> **Status:** coder-ready
> **Ветка фичи:** `feature/drop-share-override-and-receiver`
> **Референс брифа:** `.claude/briefs/pm-brief-drop-share-override-and-receiver.md`
> **Задача дизайнера:** `task-drop-share-design`

---

## Контекст и UX-принцип

Обе поверхности — **conformance к уже существующим паттернам**, не новый визуальный язык:

- **Surface A** (`dropSharePercentOverride` слайдер) повторяет `seniorSharePercentOverride` ShareSlider.
  Различие только в label/role/hint. Никаких новых компонентов.
- **Surface B** (получатель прихода) повторяет SALARY-receiver Select в `CreateTransactionDialog`.
  Различие — опции из двух групп (дроп + ADMIN'ы) и пояснительный hint.

Coder строит строго по этим референс-паттернам из `$projectId.tsx` и `CreateTransactionDialog.tsx`.
`design-gate: degraded` — генерация нового макета не требуется.

---

## Token map

Используются исключительно существующие семантические токены из `apps/web/app/styles/globals.css`.
Новые токены не вводятся.

| Назначение                               | Tailwind / CSS token                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Фон страницы / канвас                    | `bg-background`                                                  |
| Поднятая поверхность (карточка)          | `bg-card` / `border-border`                                      |
| Вторичный / подписи                      | `text-muted-foreground`                                          |
| Основной текст                           | `text-foreground`                                                |
| Ошибка / деструктив                      | `text-destructive` / `border-destructive`                        |
| Бренд / CTA                              | `bg-primary` / `text-primary`                                    |
| Инпут / бордер                           | `border-input` / `bg-background` / `bg-muted`                    |
| Радиус                                   | `rounded-md` (вложенные контролы) / `rounded-lg` (карточки)      |
| Disabled-состояние                       | `opacity-60` (как в ShareSlider)                                 |
| Визуальный акцент слайдера (company-bar) | `bg-primary/20 text-primary`                                     |
| Визуальный акцент слайдера (role-bar)    | `bg-emerald-500/20 text-emerald-400` (эталон ShareSlider)        |
| Hint-текст                               | `text-xs text-muted-foreground`                                  |
| Ошибка валидации                         | `text-[11px] text-destructive` (паттерн CreateTransactionDialog) |

---

## Surface A — слайдер «Доля дропа (%)» в форме редактирования проекта

### Референс-паттерн

`apps/web/app/routes/_authenticated/projects/$projectId.tsx` — `ProjectEditFields` (строки 339–397),
поле `seniorSharePercentOverride` с `ShareSlider`.

`apps/web/app/components/ui/share-slider.tsx` — компонент `ShareSlider` (строки 41–126).

### Компонент

Используется существующий `ShareSlider` из `@/components/ui/share-slider`.
**Новых компонентов не требуется.**

Параметры вызова `ShareSlider` для доли дропа:

```tsx
<ShareSlider
  value={sliderValue} // dropSharePercentOverride ?? effectiveDropSharePercent
  min={0}
  max={100}
  disabled={!canEditOverride} // canEditOverride = role ADMIN | ACCOUNTANT
  onChange={(v) => field.handleChange(v)}
  onBlur={field.handleBlur}
  error={!!err}
  inputTestId="project-edit-drop-share-override"
  role="DROP" // уже поддерживается ShareSlider (ROLE_LABELS['DROP'])
/>
```

Компонент `ShareSlider` уже поддерживает `role="DROP"` — правый bar подпишется «дропу», aria-label
будет «Доля дропа в процентах» (из `ROLE_LABELS['DROP']` в share-slider.tsx:38).

### Расположение в `ProjectEditFields`

Новую секцию размещать **сразу после** секции `seniorSharePercentOverride` (строка 392 в `$projectId.tsx`).

Обёртка секции:

```tsx
{/* Per-project DROP share — только для drop-проектов, только ADMIN/ACCOUNTANT.
    Паттерн — полный аналог seniorSharePercentOverride выше. */}
{viewerRole !== 'HR' && viewerRole !== 'JUNIOR' && project.dropId != null && (
  <form.Field name="dropSharePercentOverride" validators={...}>
    {(field) => {
      const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
      const raw = field.state.value as number | null
      const hasOverride = raw !== null && raw !== undefined
      const sliderValue = hasOverride ? (raw as number) : effectiveDropSharePercent
      return (
        <div className="space-y-2" data-testid="project-edit-drop-share-section">
          <Label className={cn(err && 'text-destructive')}>Доля дропа (%)</Label>
          <ShareSlider
            value={sliderValue}
            min={0}
            max={100}
            disabled={!canEditOverride}
            onChange={(v) => field.handleChange(v)}
            onBlur={field.handleBlur}
            error={!!err}
            inputTestId="project-edit-drop-share-override"
            role="DROP"
          />
          <p className="text-xs text-muted-foreground">
            По умолчанию: {effectiveDropSharePercent}%. Установите те же значение, чтобы сбросить
            переопределение.
          </p>
          {!canEditOverride && (
            <p className="text-xs text-muted-foreground italic">
              Менять может только ADMIN или ACCOUNTANT.
            </p>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      )
    }}
  </form.Field>
)}
```

### Условие видимости (RBAC)

| Роль       | Условие показа                            | Состояние                     |
| ---------- | ----------------------------------------- | ----------------------------- |
| ADMIN      | `dropId != null`                          | enabled                       |
| ACCOUNTANT | `dropId != null`                          | enabled                       |
| SENIOR     | `dropId != null`                          | disabled (`!canEditOverride`) |
| DROP       | `dropId != null`                          | disabled (`!canEditOverride`) |
| HR         | скрыто (фильтр `viewerRole !== 'HR'`)     | —                             |
| JUNIOR     | скрыто (фильтр `viewerRole !== 'JUNIOR'`) | —                             |

Не-drop-проекты (`project.dropId == null`): секция полностью скрыта для всех.

### Значение для формы

- `dropSharePercentOverride` = `null | number` (аналог `seniorSharePercentOverride`).
- `effectiveDropSharePercent` — текущая эффективная доля, резолвится: `project.dropSharePercentOverride ?? user.dropSharePercent ?? 5`.
  Backend передаёт её в ProjectDetailDto (задача backend).
- **Implicit-null-reset:** если пользователь устанавливает значение === `effectiveDropSharePercent`,
  frontend отправляет `null` (или backend резолвит это как сброс). Паттерн строго как у senior.

### info-row «Доля дропа» в Обзоре

Рядом с `InfoRow` «Доля синьора» (строка 999 в `$projectId.tsx`) добавить строку для drop-проектов:

```tsx
{
  canSeeProjectFinance && project.dropId != null && (
    <InfoRow icon={<Percent className="h-3.5 w-3.5" />} label="Доля дропа">
      <ProjectDropShareInfo project={project} />
    </InfoRow>
  )
}
```

`ProjectDropShareInfo` — компонент по образцу `ProjectShareInfo` (существующий для senior).
Показывает: текущую эффективную долю + источник (`PROJECT` / `USER_DEFAULT`), бейдж «Override»
при наличии override. Паттерн: `text-sm font-medium tabular-nums` для числа.

### Панель `ProjectDropDistribution`

Компонент уже читает `project.dropSharePercent ?? 5` (строка 1412 в `$projectId.tsx`).
После backend-задачи DTO будет возвращать эффективную долю (с учётом override).
**UI-правок не требуется** — данные придут обновлёнными в DTO. Дизайнер отмечает:
панель показывает эффективную долю (снапшот на момент рендеринга), не хранимый override отдельно.

---

## Surface B — селектор «Получатель» в диалоге создания прихода (DROP_INCOME)

### Референс-паттерн

`apps/web/app/routes/_authenticated/finance/components/dialogs/CreateTransactionDialog.tsx` —
ветка `type === 'SALARY'`, Select receiver (строки 572–634).

Тот же паттерн: `Select` + `SelectTrigger` + `SelectContent` + `SelectItem` + error-параграф.

### Компонент

Используется существующий `Select` из `@/components/ui/select`.
**Новых компонентов не требуется.**

### Разметка (в ветке `type === 'DROP_INCOME'`)

```tsx
{
  type === 'DROP_INCOME' && (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Получатель прихода</Label>
      <Select
        value={dropIncomeReceiverId}
        onValueChange={(v) => {
          setDropIncomeReceiverId(v)
          clearFieldError('receiver')
        }}
      >
        <SelectTrigger
          className={cn('h-9 text-sm', fieldErrors.receiver && 'border-destructive')}
          data-testid="create-transaction-drop-receiver-trigger"
        >
          <SelectValue placeholder="Выберите получателя" />
        </SelectTrigger>
        <SelectContent>
          {/* Группа 1: дроп проекта */}
          <SelectItem value={dropUser.id} className="text-sm">
            Дроп проекта
            <span className="ml-1 text-[10px] text-muted-foreground">— {dropUser.displayName}</span>
          </SelectItem>
          {/* Группа 2: все ADMIN */}
          {adminUsers.map((u) => (
            <SelectItem key={u.id} value={u.id} className="text-sm">
              Админ
              <span className="ml-1 text-[10px] text-muted-foreground">— {u.displayName}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Пояснительный hint */}
      <p className="text-xs text-muted-foreground">
        Кому фактически пришли деньги. Если админу — компания создаст обязательство выплатить дропу
        его долю.
      </p>
      {/* Ошибка валидации */}
      {fieldErrors.receiver && (
        <p className="text-[11px] text-destructive" data-testid="create-transaction-error-receiver">
          {fieldErrors.receiver}
        </p>
      )}
    </div>
  )
}
```

### Данные для селектора

- `dropUser` — пользователь с ролью DROP, привязанный к выбранному проекту через `projects.dropId`.
  Backend / query возвращает через ProjectDetailDto или отдельный endpoint (задача backend).
- `adminUsers` — динамический список пользователей с ролью ADMIN. Загружается через
  существующий endpoint пользователей с фильтрацией по роли (задача frontend — использовать
  существующий `useQuery` по пользователям, как в SALARY-ветке).

### Предвыбор по роли декларатора

| Роль                           | Дефолт `dropIncomeReceiverId`               |
| ------------------------------ | ------------------------------------------- |
| DROP (декларирует свой приход) | `dropUser.id` (предвыбран сам дроп)         |
| ADMIN                          | `''` (пустой — заставить выбрать осознанно) |

Логика предвыбора:

```tsx
// При открытии диалога / смене проекта для DROP_INCOME:
useEffect(() => {
  if (type === 'DROP_INCOME' && viewer.role === 'DROP') {
    setDropIncomeReceiverId(viewer.id)
  } else {
    setDropIncomeReceiverId('')
  }
}, [type, projectId, viewer.role])
```

### Валидация

- Поле обязательно при `type === 'DROP_INCOME'`.
- Ошибка при пустом значении: `'Выберите получателя'`.
- `data-testid="create-transaction-error-receiver"` — паттерн строки 628 в диалоге.
- Submit-кнопка НЕ disabled'ится отдельно — стандартный флоу: `validate()` при submit показывает ошибку.

### data-testid

| Элемент                             | `data-testid`                                      |
| ----------------------------------- | -------------------------------------------------- |
| SelectTrigger получателя            | `create-transaction-drop-receiver-trigger`         |
| Ошибка валидации получателя         | `create-transaction-error-receiver` (существующий) |
| Слайдер доли дропа (числовой инпут) | `project-edit-drop-share-override`                 |
| Секция слайдера (обёртка)           | `project-edit-drop-share-section`                  |

---

## Responsive (4 класса устройств)

**Подход: mobile-first.** Оба контрола наследуют поведение своих референс-паттернов.

### Surface A — ShareSlider в edit-диалоге проекта

| Класс            | Поведение                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Мобайл 320–639   | `space-y-2` = стандартный vertical stack. Визуальный bar 100% ширина контейнера — адаптируется автоматически. Числовой инпут `w-16` не меняется. Hit-area слайдера: `h-2` track → thumb нативный браузерный (≥44px в большинстве мобильных браузеров). Range-инпут `accent-primary`. Весь блок не обрезается — нет фиксированных горизонтальных размеров. |
| Планшет 640–1023 | Идентично мобайлу, ширина контейнера больше — bar читается лучше.                                                                                                                                                                                                                                                                                         |
| Ноутбук 1024+    | Полная ширина внутри `space-y-3` формы. Числовые значения чёткие.                                                                                                                                                                                                                                                                                         |
| Большой 1440+    | Контент-колонка формы с `max-w` — нет растяжки.                                                                                                                                                                                                                                                                                                           |

**Нет обрезания на мобайле:** `ShareSlider` использует `flex items-center gap-3` для ряда
с range + числовым инпутом — адаптируется. Визуальный bar — `overflow-hidden rounded-md` —
адаптируется к ширине родителя.

### Surface B — Select «Получатель» в диалоге CREATE_TRANSACTION

| Класс          | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Мобайл 320–639 | `CrmDialog` на мобайле = full-screen (`max-h-[90dvh]` body скроллится). Select-дропдаун открывается через `SelectContent` (Radix Portal) — позиционируется вверх/вниз автоматически. `SelectTrigger h-9` — hit-area 36px при закрытом состоянии; SelectItem в листе — стандартный padding Radix `py-1.5 px-2` (~32px) — допустимо, поскольку лист скроллируем и элементы крупнее. На мобайле SelectContent рендерится через Portal (Radix), покрывая весь viewport — это штатное поведение. |
| Планшет 640+   | Диалог 90dvh, Select нормальный.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Ноутбук 1024+  | Стандартный диалог.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Большой 1440+  | Без изменений.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Длинные имена в SelectItem:** использовать `truncate` или wrap — Radix SelectItem по умолчанию
wrap (нет overflow hidden), имена могут быть длиннее — это корректно.

---

## Edge-cases

### Surface A

| Кейс                                               | Поведение                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Не-drop-проект (`dropId == null`)                  | Секция «Доля дропа» полностью скрыта для всех ролей                                                          |
| Дроп-проект, но `dropSharePercent` не пришло в DTO | Показывать `effectiveDropSharePercent` = `5` (дефолт `DEFAULT_DROP_SHARE_PERCENT`); hint: «По умолчанию: 5%» |
| Override = null (сброшен)                          | Слайдер показывает `effectiveDropSharePercent` (из user-default), не 0                                       |
| Пользователь не ADMIN/ACCOUNTANT                   | Слайдер `disabled` (opacity-60), hint «Менять может только ADMIN или ACCOUNTANT.»                            |
| HR / JUNIOR                                        | Секция `dropSharePercentOverride` скрыта (`viewerRole !== 'HR' && viewerRole !== 'JUNIOR'`)                  |
| Значение > 100 или < 0                             | Validator: «Введите целое число от 0 до 100» (паттерн senior)                                                |

### Surface B

| Кейс                                                  | Поведение                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Пустой список ADMIN (edge-case — компания без ADMIN)  | SELECT пустой кроме дропа; показываем только дроп. Это системно-невалидная ситуация, но UI не ломается                                    |
| Имя дропа или ADMIN-пользователя длиннее ~30 символов | `SelectItem` допускает wrap — текст переносится, ничего не обрезается                                                                     |
| Проект без дропа (`dropId == null`)                   | `type === 'DROP_INCOME'` для не-drop-проекта недоступен на бизнес-уровне (уже не показывается); на UI — не рендерить секцию получателя    |
| Диалог закрыт/сброшен                                 | `dropIncomeReceiverId` сбрасывается в `''`; предвыбор переустанавливается при следующем открытии                                          |
| DROP-пользователь декларирует, `projectId` не выбран  | Нет проекта → нет данных о дропе → получатель показывает пустой список или не рендерится; Submit заблокирован валидацией проекта раньше   |
| Ошибка загрузки ADMIN-списка                          | Показать только дропа (если данные частично), или пустой Select с сообщением — frontend обрабатывает по стандартному паттерну query error |

---

## A11y (WCAG 2.2 AA)

### Surface A — ShareSlider

| Требование                      | Реализация                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `aria-label` на range-инпуте    | ShareSlider передаёт `aria-label={labels.aria}` = «Доля дропа в процентах» (из `ROLE_LABELS['DROP']`)                   |
| `aria-label` на числовом инпуте | Аналогично — уже в компоненте                                                                                           |
| Label / for                     | `<Label>` над блоком — визуальный; range и number инпуты не `id`-связаны (паттерн компонента) — aria-label компенсирует |
| Contrast                        | `text-muted-foreground` на `bg-card` — 4.5:1 в dark-mode (выверено в tokens)                                            |
| Focus                           | Range инпут: нативный `focus` браузера + `accent-primary`; number инпут: `focus-visible:ring-1 focus-visible:ring-ring` |
| Target size                     | Range thumb нативный — варьируется по браузеру (обычно 20–28px нативно); acceptable (SC 2.5.8 минимум 24px)             |
| Disabled state                  | `aria-disabled` не нужен — `disabled` атрибут на инпутах достаточен; `opacity-60` — визуальный индикатор                |

### Surface B — Select получателя

| Требование                | Реализация                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Label>` над селектором  | `<Label className="text-xs text-muted-foreground">Получатель прихода</Label>` — визуальный                                                   |
| Radix Select a11y         | `Select` (Radix) автоматически: `role="combobox"`, `aria-expanded`, `aria-haspopup`, `role="option"` на items                                |
| Focus trap                | Radix `SelectContent` trap focus внутри себя — штатное поведение Radix UI                                                                    |
| Escape close              | Radix закрывает Select по Escape — штатно                                                                                                    |
| Contrast                  | `text-muted-foreground` hints — ≥4.5:1; `text-destructive` ошибки — ≥4.5:1                                                                   |
| Target size SelectTrigger | `h-9` = 36px height; ширина full-width контейнера — более чем 44px в ширину → ок. На мобайле: tap target крупный (full-width)                |
| SelectItem target size    | Radix `py-1.5` ≈ 32px высота элемента — допустимо (SC 2.5.8 минимум 24px); на мобайле Radix SelectContent — оверлей позволяет комфортный tap |
| Обязательное поле         | `aria-required` не добавляется явно — ошибка валидации через `fieldErrors.receiver` + screen reader читает error-параграф                    |
| Error сообщение           | `<p data-testid="create-transaction-error-receiver">` — визуальный + screen reader (inline после trigger)                                    |

---

## Список компонентов

| Компонент                                                               | Тип                              | Источник                                                              |
| ----------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `ShareSlider`                                                           | Существующий                     | `apps/web/app/components/ui/share-slider.tsx`                         |
| `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue` | Существующие                     | `apps/web/app/components/ui/select.tsx` (shadcn/Radix)                |
| `Label`                                                                 | Существующий                     | `apps/web/app/components/ui/label.tsx`                                |
| `ProjectDropShareInfo`                                                  | **НОВЫЙ** компонент (если нужен) | По образцу `ProjectShareInfo` — read-only строка доли дропа с бейджем |

### `ProjectDropShareInfo` — эскиз API

```tsx
// По образцу существующего ProjectShareInfo
function ProjectDropShareInfo({ project }: { project: ProjectDetailDto }) {
  const override = project.dropSharePercentOverride
  const effective = project.dropSharePercent ?? 5 // effective из DTO
  return (
    <span className="text-sm font-medium tabular-nums">
      {effective}%
      {override !== null && override !== undefined && (
        <Badge variant="outline" className="ml-1.5 text-[10px]">
          Override
        </Badge>
      )}
    </span>
  )
}
```

Если архитектурно проще встроить inline — допустимо, отдельный компонент не обязателен.

---

## Motion

Никакого дополнительного motion. Переходы слайдера (bar width) — `transition-all duration-150` уже в ShareSlider (строки 72 и 80). Select-анимации — из shadcn/Radix (стандартные `fade-in`). Новых анимаций не добавлять.

---

## Инструкция для кодера (КРИТИЧНО)

1. **Строй нашими компонентами** по этой спеке — `ShareSlider`, `Select` из shadcn/ui.
   **НЕ** копируй generic HTML, **НЕ** вводи новые CSS-переменные / hardcoded hex.
2. **Surface A** — полный аналог `seniorSharePercentOverride` (строки 339–397 в `$projectId.tsx`).
   Различия: имя поля, label, `role="DROP"`, условие `project.dropId != null`.
3. **Surface B** — полный аналог SALARY-receiver Select (строки 572–634 в `CreateTransactionDialog.tsx`).
   Различия: опции из двух групп (drop + ADMIN), предвыбор по роли, пояснительный hint.
4. **`ProjectDropShareInfo`** — опциональный компонент по образцу `ProjectShareInfo`. Если `ProjectShareInfo`
   уже абстрагирован достаточно, используй его с `role="DROP"` параметром.
5. **data-testid** строго по таблице выше — AutoTest использует их.
6. **Responsive** — нет фикс-ширин, нет overflow. Проверь на 320px (ShareSlider bar + Select full-width).
7. **Implicit-null-reset для Surface A** — логика на frontend/backend согласно брифу (backend-задача задаёт контракт).
