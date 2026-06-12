# Design Spec: Пароли проекта (ProjectCredentialsSection)

**Slug:** `project-credentials`
**Статус:** Ready for implementation
**Дата:** 2026-06-12
**Автор:** ui-ux-designer (Mode A)
**Task-источник:** `.claude/tasks/task-project-credentials.md`

---

## 1. Design Direction

### Purpose

Интерфейс позволяет управлять паролями рабочих аккаунтов проекта (GitHub, Jira, Slack, CRM-клиента…).

- **JUNIOR** — активный участник проекта — просматривает список, делает reveal пароля нужного сервиса, копирует в буфер чтобы войти. Workflow — открытие хаба, поиск строчки, один клик глаза, копирование.
- **ADMIN/HR** — добавляет, редактирует, удаляет записи при онбординге джуна или ротации паролей.

Критическое ограничение: пароли — **чувствительные данные**. Список не содержит plaintext даже в виде маски `*` из DOM. Reveal — отдельный запрос, plaintext в UI только пока пользователь явно смотрит (max 30с).

### Audience

| Пользователь | Частота | Главный сценарий |
|---|---|---|
| JUNIOR | ежедневно | Скопировать пароль нужного ресурса |
| ADMIN | 1-2 раза/нед | Добавить/обновить аккаунт при онбординге |
| HR | 1-2 раза/нед | Добавить/обновить при ротации пароля |

### Tone

**Dense / quiet / secure.** Операционный SaaS-инструмент с акцентом на безопасность.

- Никакого визуального «шума» — секция органично встраивается в существующий стиль хаба (`border-border/40 bg-card`), не выделяется цветом.
- Пароли — чувствительные данные: UI транслирует это через сдержанность, а не яркость.
- Reveal-состояние — единственная «особая» визуальная зона: моноширинный фон-«сейф».

### Memorable detail

Revealed пароль отображается в **`font-mono tabular-nums tracking-wider`** на фоне `bg-muted/40` (визуальный «сейф» — инверсный box относительно строки). Авто-скрытие через 30с сопровождается тонкой **progress-bar CSS-анимацией** под паролем — визуальный таймер без JS-интервала (`animation: shrink 30s linear`). Пользователь видит «окно», которое закрывается.

### Constraints

- Tailwind v4 + shadcn/ui (существующие компоненты)
- Russian UI (все user-facing тексты)
- WCAG 2.2 Level AA
- Responsive: 320px — 1440px
- Существующие design tokens из `apps/web/app/styles/globals.css` (нет новых tokens)
- Паттерн: `ProjectLegendSection.tsx` (Card + CardHeader + CardContent, border-border/40)

---

## 2. Состояния компонента

### 2.1. Empty (нет записей)

```
┌─ Card border-border/40 ──────────────────────────┐
│  [Key icon 3.5px] ПАРОЛИ ПРОЕКТА     [+ Добавить]│
│                                                    │
│  Нет сохранённых паролей             (italic muted)│
└────────────────────────────────────────────────────┘
```

- Кнопка «+ Добавить» только для ADMIN/HR (prop `canEdit`). JUNIOR видит empty-message без кнопки.
- Иконка: `KeyRound` (lucide-react).
- Text: `text-sm text-muted-foreground/60 italic`.

### 2.2. List (пароли загружены)

```
┌─ Card border-border/40 ──────────────────────────────────────────┐
│  [Key icon] ПАРОЛИ ПРОЕКТА                         [+ Добавить]  │
│  ─────────────────────────────────────────────────────────────── │
│  [G] GitHub                                                        │
│       login: john.doe@company.com  · github.com    [👁] [✏] [🗑]  │
│       ••••••••                                                     │
│  ─────────────────────────────────────────────────────────────── │
│  [J] Jira                                                          │
│       login: john.doe             · jira.company.com [👁] [✏] [🗑]│
│       ••••••••                                                     │
└────────────────────────────────────────────────────────────────── ┘
```

**Строка записи:**
- `label` — `text-sm font-medium` (GitHub, Jira…)
- `login` — `text-xs text-muted-foreground` (если заполнен)
- `url` — `text-xs text-muted-foreground` в виде ссылки `<a target="_blank" rel="noopener noreferrer">` с иконкой `ExternalLink h-3 w-3` (если заполнен)
- Маска: строка `••••••••` (`text-sm text-muted-foreground/50 tracking-widest font-mono`) — статичный текст, НЕ input
- Кнопки: [👁 reveal] [✏ edit] [🗑 delete] — icon-only, ghost, h-7 w-7

**Разделитель:** `<Separator className="my-1" />` между строками (только для ≥2 записей).

**RBAC видимость кнопок:**
- JUNIOR: только `[👁]` (без edit/delete)
- ADMIN, HR: `[👁] [✏] [🗑]`

### 2.3. Reveal (plaintext виден)

```
┌─ строка credential ────────────────────────────────────────────┐
│  [G] GitHub                                                     │
│       login: john.doe@company.com  · github.com  [👁▪] [📋] [✏] [🗑]│
│       ┌─── bg-muted/40 rounded-md px-3 py-1.5 ──────────────┐  │
│       │  p4ssw0rd!2024$             font-mono tracking-wider  │  │
│       │  ░░░░░░░░░░░░░░░░░░░░░░░ progress (30s shrink)       │  │
│       └────────────────────────────────────────────────────── ┘  │
└─────────────────────────────────────────────────────────────── ┘
```

**Детали reveal-зоны:**
- Container: `bg-muted/40 rounded-[calc(var(--radius)-4px)] px-3 py-2` (concentric radius: Card radius - padding = 6px)
- Пароль: `font-mono text-sm font-medium tabular-nums tracking-[0.12em] text-foreground select-text`
- Progress-bar: `h-0.5 w-full bg-primary/30 rounded-full overflow-hidden`
  - Inner bar: `h-full bg-primary/60 animate-[shrink_30s_linear_forwards]`
  - Keyframe: `@keyframes shrink { from { width: 100% } to { width: 0% } }`
  - После 30с: авто-скрытие (через `onAnimationEnd` callback)
- Кнопка-глаз в reveal-состоянии: `aria-pressed="true"` + `aria-label="Скрыть пароль"` + `data-testid="credentials-hide-btn-{id}"`
- Кнопка «Копировать» (clipboard): появляется только когда пароль показан. `aria-label="Копировать пароль"`. После успешного копирования — иконка `Check` вместо `Copy` на 2с (CSS transition opacity).

### 2.4. Loading (список загружается)

Два Skeleton-блока:
```tsx
<Skeleton className="h-12 w-full rounded-md" />
<Skeleton className="h-12 w-full rounded-md" />
```

### 2.5. Error (reveal вернул 403/throttle)

Inline error под строкой, `text-xs text-destructive`. Тексты:
- 403: `«Нет доступа к этому паролю»`
- 429: `«Слишком много запросов. Попробуйте через минуту.»`
- Сетевая ошибка: `«Не удалось получить пароль. Попробуйте ещё раз.»`

Ошибка исчезает при следующей попытке reveal (не нужен явный dismiss).

---

## 3. Component List

### Из shadcn/ui (apps/web/app/components/ui/)

| Компонент | Где применяется |
|---|---|
| `Card`, `CardContent`, `CardHeader`, `CardTitle` | Секция целиком (паттерн ProjectLegendSection) |
| `Button` (variant="ghost", size="sm") | Все кнопки-действия (reveal, copy, edit, delete) |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` | Добавление / редактирование записи |
| `AlertDialog`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogAction`, `AlertDialogCancel` | Confirm удаления |
| `Input` | Поля label, login, password, url |
| `Label` | Подписи полей формы |
| `Textarea` | Поле notes |
| `Separator` | Разделитель между строками |
| `Skeleton` | Loading-состояние |
| `Tooltip` (TooltipProvider, TooltipContent, TooltipTrigger) | Подсказки для icon-only кнопок |

### Lucide-react icons

| Иконка | Где |
|---|---|
| `KeyRound` | Заголовок секции |
| `Eye`, `EyeOff` | Reveal / hide toggle |
| `Copy`, `Check` | Clipboard button (swap on success) |
| `Pencil` | Edit кнопка |
| `Trash2` | Delete кнопка |
| `Plus` | Добавить запись |
| `ExternalLink` | URL-ссылка |
| `Loader2` | Pending state в кнопках |

### Новые файлы (Coder создаёт)

```
apps/web/app/components/projects/ProjectCredentialsSection.tsx
apps/web/app/hooks/use-credentials.ts
```

Образцы: `ProjectLegendSection.tsx` + `use-legend.ts` соответственно.

---

## 4. Token Map

Все токены из `apps/web/app/styles/globals.css` (`@theme inline {}`). **Новые токены не добавляются.**

| Токен | Применение |
|---|---|
| `var(--border)` / `border-border/40` | Card border (паттерн секций хаба) |
| `var(--card)` | Card background |
| `var(--muted-foreground)` | login, url, маска, caption-текст |
| `var(--muted)` / `bg-muted/40` | Reveal-контейнер (secure zone) |
| `var(--foreground)` | Revealed пароль (полная непрозрачность) |
| `var(--primary)` | Progress-bar fill (`bg-primary/60`), трек (`bg-primary/30`) |
| `var(--destructive)` | Inline error messages |
| `var(--ring)` | Focus indicator (через Tailwind `focus-visible:ring-2 focus-visible:ring-ring`) |
| `var(--radius)` → `calc(var(--radius) - 4px)` | Reveal-контейнер (concentric radius) |
| `--font-sans` | Весь текст (default) |
| `font-mono` (Tailwind utility → browser monospace) | Revealed password display |

**Radius concentric:** Card `--radius` = 0.625rem (10px). Padding Card = 24px. Reveal-контейнер вложен внутрь CardContent → outer radius - 4px = 6px = `calc(var(--radius) - 4px)` = `rounded-[calc(var(--radius)-4px)]`.

---

## 5. Dialog: Добавление / Редактирование записи

### Поля формы

| Поле | Тип | Обязательность | Placeholder |
|---|---|---|---|
| Название* | `Input` | Required | `GitHub, Jira, Slack...` |
| Логин | `Input` | Optional | `john.doe@company.com` |
| Пароль* | `Input type="password"` + toggle show/hide | Required при создании, Optional при редактировании | `Пароль аккаунта` |
| URL | `Input type="url"` | Optional | `https://github.com` |
| Заметки | `Textarea rows={3}` | Optional | `Дополнительная информация...` |

**Password field:** нативный `<input type="password">` (браузер скрывает по умолчанию) + кнопка-глаз для toggle внутри поля. При редактировании — поле пустое с `placeholder="Оставьте пустым чтобы не менять пароль"`. Если поле пустое при PATCH — пароль не обновляется (бэк игнорирует absent `password`).

### Dialog поведение

- Trigger: кнопка «+ Добавить» (пустой state) или `[✏]` на записи.
- `DialogTitle`: `"Добавить аккаунт"` / `"Редактировать аккаунт"`.
- Escape → закрытие без сохранения. Focus restore на trigger-кнопку.
- Submit → `<button type="submit">`. Enter в text-полях → submit формы. **Исключение:** textarea notes — Enter добавляет новую строку, не сабмитит (нативное поведение textarea).
- Pending: submit-кнопка `disabled + <Loader2 animate-spin />`.
- После успешного submit → диалог закрывается, список обновляется через `queryClient.invalidateQueries`.

### Layout формы (Dialog)

```
DialogContent className="sm:max-w-md"
  DialogHeader
    DialogTitle
  form (TanStack Form)
    space-y-4
      Input  Название *
      Input  Логин
      Input  Пароль *  [👁 toggle]
      Input  URL
      Textarea  Заметки
    DialogFooter
      Button variant="outline"  Отмена
      Button type="submit"      Сохранить
```

---

## 6. Confirm удаления

Компонент `AlertDialog` (shadcn/ui). Trigger: кнопка `[🗑]`.

```
AlertDialogTitle:       "Удалить аккаунт?"
AlertDialogDescription: "Запись «{label}» будет удалена безвозвратно."
AlertDialogCancel:      "Отмена"   (Escape → отмена)
AlertDialogAction:      "Удалить"  variant="destructive"
```

Focus trap: Radix AlertDialog обеспечивает автоматически. После закрытия — focus restore на trigger.

---

## 7. Motion Spec

Все анимации — минимальны, функциональны (не декоративны).

### Reveal-блок (появление)

```css
/* Framer Motion variants — паттерн из project.tsx */
enter: { opacity: 0, height: 0 } → { opacity: 1, height: "auto", transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] } }
exit:  { opacity: 1, height: "auto" } → { opacity: 0, height: 0, transition: { duration: 0.15 } }
```

Использовать `<AnimatePresence>` + `motion.div` для reveal-контейнера — вход/выход.

### Progress-bar (авто-скрытие таймер)

```css
@keyframes shrink {
  from { width: 100%; }
  to   { width: 0%; }
}

.credentials-timer-bar {
  animation: shrink 30s linear forwards;
}
```

`animation-play-state: running` пока показан; при копировании — **не сбрасывать таймер** (у пользователя уже в буфере, 30с от reveal).

### Clipboard success (Check-иконка swap)

```css
transition-property: opacity, transform;
transition-duration: 150ms;
transition-timing-function: ease-out;
```

Copy → Check: `opacity 0 → 1, scale 0.8 → 1`. После 2с: Check → Copy обратно.

### Кнопки действий

```css
transition-property: background-color, opacity, color;
transition-duration: 150ms;
transition-timing-function: ease-out;
```

Никакого `transition: all`.

---

## 8. A11y Critical Paths (WCAG 2.2 AA)

### 8.1. Target size — SC 2.5.8 (min 24×24px)

Все icon-only кнопки имеют `className="h-7 w-7"` (28×28px) — превышает минимум 24px.
Padding расширяет hit-area без увеличения иконки: `p-1.5` внутри h-7 w-7.

### 8.2. Focus indicator — SC 2.4.11

Все интерактивные элементы используют shadcn/ui паттерн `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`. Кастомные элементы (inline-кнопки) — явно наследуют через Button component.

Reveal-контейнер `select-text` — не интерактивный элемент, нет focus ring нужен.

### 8.3. Color contrast — SC 1.4.3 / 1.4.11

| Элемент | Цвет | Фон | Contrast |
|---|---|---|---|
| Пароль revealed | `foreground` L=0.97 | `muted/40` ≈ L=0.18 | >7:1 ✓ |
| Маска `••••••••` | `muted-foreground/50` ≈ L=0.29 | `card` L=0.12 | ~3:1 (large UI element ✓) |
| Label record | `foreground` | `card` | >7:1 ✓ |
| Login/URL | `muted-foreground` L=0.58 | `card` L=0.12 | ~4.5:1 ✓ |
| Error text | `destructive` | `card` | ≥4.5:1 ✓ |

### 8.4. Icon-only buttons — SC 1.1.1

| Кнопка | aria-label | aria-pressed | data-testid |
|---|---|---|---|
| Reveal | `"Показать пароль"` (hidden) / `"Скрыть пароль"` (visible) | `false` / `true` | `credentials-reveal-btn-{id}` |
| Copy | `"Копировать пароль"` / `"Скопировано"` (после успеха) | — | `credentials-copy-btn-{id}` |
| Edit | `"Редактировать {label}"` | — | `credentials-edit-btn-{id}` |
| Delete | `"Удалить {label}"` | — | `credentials-delete-btn-{id}` |
| Add | — (label "Добавить" виден) | — | `credentials-add-btn` |

Tooltip обёртывает каждую icon-only кнопку: `<Tooltip><TooltipTrigger asChild>...<TooltipContent>{label}</TooltipContent></Tooltip>`.

### 8.5. Clipboard feedback — SC 4.1.3

Статус копирования объявляется через `aria-live`:

```tsx
<div
  aria-live="polite"
  aria-atomic="true"
  className="sr-only"
  data-testid="credentials-clipboard-status"
>
  {clipboardStatus} {/* "" | "Пароль скопирован" */}
</div>
```

Обнуляется через 3с чтобы повторное копирование снова объявлялось.

### 8.6. Revealed password — screen reader

Reveal-блок НЕ имеет `aria-live` — пользователь явно нажал кнопку и ожидает изменения. Пароль попадает в accessibility tree через обычный `<span>`, скринридер прочитает при фокусе/навигации. `aria-hidden="false"` явно (default).

НЕ добавлять `aria-label` на сам password-span (скринридер зачитает plaintext — это намеренно при явном действии пользователя).

### 8.7. Dialog focus management

Radix Dialog автоматически:
- Trap focus внутри открытого диалога
- Restore focus на trigger-элемент при закрытии
- Escape → close

Проверить: первый `autoFocus` в Dialog → поле «Название» (через `autoFocus` prop на Input).

### 8.8. AlertDialog

`role="alertdialog"` (Radix AlertDialog) — автоматически. Focus идёт на первую кнопку (Cancel) — безопасный default для деструктивных действий (WCAG best practice).

### 8.9. Keyboard navigation flow (секция)

```
Tab: [+ Добавить] → строка 1: [👁] → [✏] → [🗑] → строка 2: [👁] → [✏] → [🗑] → ...
```

Порядок DOM соответствует визуальному порядку. Reveal-блок вставляется **после** соответствующей строки в DOM — при появлении Tab переходит внутрь него (password span + [📋 copy]).

---

## 9. Edge Cases

### 9.1. Длинные label / login

- `label`: `truncate` (одна строка, ellipsis). Полный текст — в Tooltip при hover/focus.
- `login`: `truncate max-w-[160px] sm:max-w-[240px]`. Полный email — в `title` attribute.
- `url`: `truncate max-w-[120px] sm:max-w-[180px]`. Полный URL — в href (виден при hover в браузере).

### 9.2. Много записей (>10)

Нет пагинации на клиенте (бэк возвращает все записи проекта). Список внутри `<ScrollArea className="max-h-[480px]">` если количество записей > 8. Порог 8 — примерно 3 viewport-height на мобильном 320px.

Ориентир: credential-строка ≈ 56px. 8 × 56 = 448px + заголовок ≈ 480px max-height.

### 9.3. Throttle reveal (429)

Лимит бэка: 30 requests/мин. При 429:
- Inline error под строкой: `«Слишком много запросов. Попробуйте через минуту.»`
- Кнопка reveal: `disabled` на 60с (отсчёт на клиенте). После 60с — re-enable без перезагрузки страницы.
- `aria-disabled="true"` + `title="Доступно через {N}с"` на кнопке в disabled-состоянии.

### 9.4. Параллельные reveal (множество открытых паролей)

Разрешено: пользователь может открыть несколько паролей одновременно. Каждый reveal-блок имеет независимый таймер (30с от момента своего reveal). Нет искусственного ограничения «только 1 открытый».

### 9.5. Авто-скрытие и clipboard race

Если пользователь нажимает «Копировать» в момент когда таймер почти истёк — копирование выполняется (plaintext ещё в state). После `onAnimationEnd` state очищается. Нет race: React setState синхронен в обработчике события.

### 9.6. Empty url / login

Если `login` пустой — строка login не рендерится (не занимает место). Если `url` пустой — ссылка не рендерится. Не показывать пустые строки с прочерком.

### 9.7. Mobile (320px)

- Кнопки `[👁] [✏] [🗑]` не переносятся на новую строку: flex-row, min-width кнопки 28px, `flex-shrink-0`.
- Label + кнопки: flex layout с `flex-1 min-w-0` на label-блоке и `flex-shrink-0` на кнопках.
- Reveal-контейнер: `break-all` на пароле (длинные символы без пробелов).

### 9.8. Offline / network error на reveal

Сетевая ошибка (не 4xx): inline error `«Не удалось получить пароль. Попробуйте ещё раз.»` + кнопка reveal остаётся активной (не disable).

### 9.9. JUNIOR на чужом проекте (403 на list)

Если GET /credentials вернул 403 → секция не рендерится (аналогично паттерну `useHrContact` в project.tsx:137-143). Не показывать error state для JUNIOR — 403 означает «нет доступа», секция скрывается молча.

---

## 10. Интеграция в существующие страницы

### 10.1. Junior-хаб: `apps/web/app/routes/crm/project.tsx`

Секция добавляется в `<HubCards>` последней карточкой перед quick-links. Паттерн существующих карточек: `motion.div` с вариантами `card` + `col-span-full`.

```tsx
{/* Пароли проекта */}
<motion.div variants={card} className="col-span-full">
  <ProjectCredentialsSection
    projectId={projectId}
    canEdit={false}  {/* JUNIOR — только просмотр и reveal */}
  />
</motion.div>
```

JUNIOR всегда `canEdit={false}` — кнопки edit/delete скрыты.

### 10.2. Project detail: `apps/web/app/routes/crm/projects/$projectId.tsx`

Секция добавляется в таб «Обзор» рядом с `ProjectLegendSection`. Паттерн: grid `gap-4`, `col-span-full`.

```tsx
{/* Пароли — для ADMIN/HR */}
{canViewCredentials && (
  <ProjectCredentialsSection
    projectId={projectId}
    canEdit={canEditCredentials}
  />
)}
```

`canViewCredentials` и `canEditCredentials` вычисляются по той же логике что `canAccessLegend` в соседних секциях: `role === 'ADMIN' || (role === 'HR' && hrCanAccess)`. На 403 от бэка — скрывать секцию через `onAccessDenied` callback или тот же паттерн useHrContact (try/catch → null → скрыть).

---

## 11. Props (интерфейс компонента)

```tsx
interface ProjectCredentialsSectionProps {
  /** UUID проекта */
  projectId: string

  /**
   * Управляет видимостью кнопок добавления/редактирования/удаления.
   * JUNIOR → false (только reveal/copy)
   * ADMIN/HR → true
   */
  canEdit: boolean
}
```

Нет `canAccess` prop — компонент сам обрабатывает 403 от list-эндпоинта (скрывает себя).

---

## 12. data-testid реестр (для AutoTest)

| testid | Что |
|---|---|
| `credentials-section` | Корневая Card |
| `credentials-add-btn` | Кнопка «+ Добавить» |
| `credentials-list` | `<ul>` список записей |
| `credentials-item-{id}` | `<li>` строка записи |
| `credentials-label-{id}` | Label записи |
| `credentials-reveal-btn-{id}` | Кнопка глаза (reveal/hide) |
| `credentials-copy-btn-{id}` | Кнопка копирования (видна при reveal) |
| `credentials-password-display-{id}` | Span с plaintext паролем |
| `credentials-timer-bar-{id}` | Progress-bar авто-скрытия |
| `credentials-edit-btn-{id}` | Кнопка редактирования |
| `credentials-delete-btn-{id}` | Кнопка удаления |
| `credentials-dialog` | Dialog добавления/редактирования |
| `credentials-input-label` | Input «Название» в dialog |
| `credentials-input-login` | Input «Логин» в dialog |
| `credentials-input-password` | Input «Пароль» в dialog |
| `credentials-input-url` | Input «URL» в dialog |
| `credentials-input-notes` | Textarea «Заметки» в dialog |
| `credentials-dialog-submit` | Submit-кнопка dialog |
| `credentials-delete-confirm` | AlertDialog confirm |
| `credentials-clipboard-status` | aria-live регион статуса clipboard |
| `credentials-error-{id}` | Inline error под строкой |

---

## 13. Русские тексты (user-facing)

### Секция (без диалога)

| Элемент | Текст |
|---|---|
| Заголовок секции | `«ПАРОЛИ ПРОЕКТА»` (uppercase tracking-wider, паттерн секций) |
| Кнопка добавить | `«Добавить»` |
| Empty state | `«Нет сохранённых паролей»` |
| Маска пароля | `«••••••••»` (статичный текст) |
| Tooltip reveal | `«Показать пароль»` / `«Скрыть пароль»` |
| Tooltip copy | `«Копировать пароль»` |
| Tooltip edit | `«Редактировать»` |
| Tooltip delete | `«Удалить»` |
| Статус clipboard | `«Пароль скопирован»` |
| Error 403 | `«Нет доступа к этому паролю»` |
| Error 429 | `«Слишком много запросов. Попробуйте через минуту.»` |
| Error network | `«Не удалось получить пароль. Попробуйте ещё раз.»` |
| Disabled reveal title | `«Доступно через {N}с»` |

### Dialog

| Элемент | Текст |
|---|---|
| Title создание | `«Добавить аккаунт»` |
| Title редактирование | `«Редактировать аккаунт»` |
| Label «Название» | `«Название *»` |
| Label «Логин» | `«Логин»` |
| Label «Пароль» | `«Пароль *»` |
| Label «Пароль» (edit) | `«Новый пароль»` |
| Placeholder пароль (edit) | `«Оставьте пустым, чтобы не менять»` |
| Label «URL» | `«URL»` |
| Label «Заметки» | `«Заметки»` |
| Button cancel | `«Отмена»` |
| Button submit | `«Сохранить»` |

### AlertDialog удаления

| Элемент | Текст |
|---|---|
| Title | `«Удалить аккаунт?»` |
| Description | `«Запись «{label}» будет удалена безвозвратно.»` |
| Cancel | `«Отмена»` |
| Action | `«Удалить»` |

---

## 14. Hook: use-credentials.ts

Образец: `apps/web/app/hooks/use-legend.ts`. Все ответы через `.parse()` из `@crm/shared`.

Экспорты:
```ts
export function useCredentials(projectId: string)   // list query
export function useCreateCredential(projectId: string)  // mutation
export function useUpdateCredential(projectId: string)  // mutation
export function useDeleteCredential(projectId: string)  // mutation
export function useRevealCredential(projectId: string)  // manual query (не auto-fetch)
```

`useRevealCredential` — **manual trigger**, не `useQuery` с `enabled`. Использовать `useMutation` или `useQuery` с `enabled: false` + `refetch()` при клике на глаз. Ответ не кэшировать в QueryClient (plaintext в памяти только в компонентном state).

На 403 `useCredentials` → компонент скрывает себя (не error state). Все остальные коды ошибок → toast через sonner.

---

## 15. Антипаттерны (проверить при code review)

- Не хранить plaintext пароль в QueryClient cache — только в `useState` компонента строки.
- Не добавлять `data-password` или другие data-атрибуты с plaintext на DOM-элементы.
- Не использовать `transition: all` на кнопках — только explicit properties (make-interfaces-feel-better).
- Не делать reveal-блок `display: none` через CSS (скринридер не увидит); использовать conditional rendering.
- Не вкладывать Cards внутрь Card (anti-pattern). Reveal-блок — не Card, только styled div.
- Не копировать HR-логику доступа из legend.service — использовать новый `HrAccessService` (задача Coder §6).
