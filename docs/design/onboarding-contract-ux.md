# Design Spec — Onboarding: Contract PDF Preview + Signature Simplification

**Slug:** `onboarding-contract-ux`
**Mode:** A — Design Direction (pre-feature)
**Status:** DRAFT — awaiting User decision on Pending Decisions (§7)
**Branch:** `claude/heuristic-payne-c95cdb`
**Date:** 2026-06-04

---

## 1. Direction (frontend-design-direction)

### 1.1 Purpose

Пользователь (SENIOR / JUNIOR / HR / ACCOUNTANT / DROP) проходит onboarding wizard.
Шаг «Подписание контракта» должен:

1. Показать **оформленный PDF-документ** вместо сырого markdown-блока — чтобы пользователь
   видел именно то, что будет в архиве, включая эмблему, номер, signature block.
2. Позволить **подписать одним действием** (checkbox + кнопка) — без лишнего поля
   ввода имени: имя берётся из legal-полей, заданных ADMIN при создании аккаунта.
3. Сохранить полную **WCAG 2.2 AA** доступность.

### 1.2 Audience

**Первичный:** не-ADMIN пользователь при первом входе (проходит wizard 1 раз).
**Вторичный:** ADMIN при просмотре аудит-трейла подписанных контрактов (`/crm/profile/audit`).

Частота: wizard — 1 раз за всё время; аудит — редко, по запросу.
Паттерн: пользователь читает документ, убеждается что данные корректны, нажимает «Подписать».

### 1.3 Tone

`Dense / quiet / scannable` — SaaS-инструмент. Не landing, не onboarding-wizard в игривом стиле.

Контракт — юридический документ, tone должен быть **серьёзным, офисным**.
Wizard-шаг выглядит как «служебный документ для просмотра и подписания»,
а не как «marketing feature reveal».

### 1.4 Memorable detail

**Единая design idea:** PDF-viewer встроен прямо в wizard step, без лишних iframe рамок —
пользователь видит реальный документ с корпоративным брендингом (лого, номер, дата).
Под viewer — compact confirmation row: аватар + read-only имя из legal-поля + checkbox + кнопка.
Подписание ощущается как «я вижу конкретно свой документ и подтверждаю его».

### 1.5 Constraints

- Tailwind v4 + shadcn/ui. Только существующие design tokens (`globals.css` `@theme inline`).
- Russian UI — все лейблы, ошибки, подсказки на русском.
- WCAG 2.2 Level AA — target size ≥ 24×24, focus visible, contrast 4.5:1 / 3:1.
- Responsive: 320 / 768 / 1440px.
- Нет новых npm-пакетов > 50 KB gzip без явного согласования (бюджет PDF-viewer).
- `apps/web/**` только — Coder не трогает `apps/api/**` без отдельного task.

---

## 2. PDF Preview в Wizard

### 2.1 Новый API endpoint — preview-rendered PDF

**Проблема:** контракт-превью нужно показать ДО подписания. Сейчас существует только
`GET /api/contracts/:id/pdf` — скачивание уже подписанного контракта (требует `signedContractId`).

**Нужен новый endpoint:** `GET /api/contracts/preview-pdf` (или `POST` с телом role).

**Критично:** этот endpoint ДОЛЖЕН быть в bypass-листе `OnboardingGuard` (`onboarding.guard.ts`),
иначе пользователь mid-onboarding получит 403. История: в PR предыдущей итерации `preview-rendered`
падал с 403 именно из-за этого.

**Реализация preview endpoint (для Coder):**

```
GET /api/contracts/preview-pdf   (bypass-listed)
Auth: JWT required (пользователь залогинен, но ещё не onboarded)
Response: application/pdf — stream

Логика:
1. Взять активный шаблон для user.role (как в `GET /api/contracts/templates/current/:role`)
2. Заполнить placeholders через `SignedContractsService.interpolateVariables(template.body, user, new Date())`
   с реальными данными пользователя (legal-поля из §3)
3. Сгенерировать PDF через ContractPdfService.generateContractPdf()
   С параметрами:
     contractNumber: 'PREVIEW' (или локализовано: 'ПРЕДВАРИТЕЛЬНЫЙ ПРОСМОТР')
     signedTypedName: user.legalFullName (новое поле — §3) или fallback: '...'
     signedAt: new Date() (текущий момент для preview)
     signedIpLastOctet: null
     verifyUrl: '' (пустая строка — QR не рендерится в preview)

Throttle: 5 req/min (preview дороже чем JSON)
```

**Bypass добавить в `onboarding.guard.ts`:**

```typescript
private readonly bypassPrefixes = [
  '/api/auth/',
  '/api/onboarding/status',
  '/api/tos/current',
  '/api/tos/accept',
  '/api/contracts/templates/current/',
  '/api/contracts/sign',
  '/api/contracts/preview-pdf',  // НОВЫЙ — preview до подписания
]
```

### 2.2 Способ embed — варианты с pros/cons

#### Вариант A — `<iframe src="blob-url">` (рекомендуется)

```tsx
// Frontend: fetch PDF → createObjectURL → set в iframe src
const res = await api.get('/contracts/preview-pdf', { responseType: 'blob' })
const url = URL.createObjectURL(res.data)
// <iframe src={url} title="Предварительный просмотр контракта" />
```

**Pros:**
- Нативный PDF-рендер браузера — нет доп. зависимостей.
- Полный контроль скролла, zoom, print (пользователь видит именно документ).
- URL освобождается через `revokeObjectURL` при unmount.
- Safari, Chrome, Firefox — все поддерживают iframe + blob PDF.
- CSP-безопасно: blob: URL не нарушает политику `frame-src 'self'`.

**Cons:**
- На мобильных (iOS Safari) iframe с PDF иногда не встраивается, показывает download-кнопку.
  Fix: детект iOS → fallback к варианту C.
- Нет кастомной loading skeleton — iframe показывает пустой прямоугольник пока PDF грузится.
  Fix: показывать `<Skeleton />` поверх iframe пока `load` event не сработает.

#### Вариант B — PDF.js (`pdfjs-dist`)

**Pros:**
- Полный контроль рендера, кастомная UI поверх (page numbers, zoom controls).
- Стабильный cross-platform (включая iOS).

**Cons:**
- Зависимость: `pdfjs-dist` ≈ 260 KB gzip. Критически нарушает бюджет 300 KB для App pages.
- Нужен `workerSrc` config — дополнительная настройка Vite (может конфликтовать с Vite 6 pin).
- Избыточная сложность для wizard step (one-time read).

**Вывод: НЕ рекомендуется** для этого use case.

#### Вариант C — `<object data="blob-url" type="application/pdf">`

```tsx
<object data={blobUrl} type="application/pdf" width="100%" height="480">
  <p>Браузер не поддерживает встроенный просмотр PDF.
     <a href={blobUrl} download>Скачать контракт</a>
  </p>
</object>
```

**Pros:**
- Семантически корректно (embedded object).
- Fallback content внутри `<object>` для браузеров без PDF support.
- iOS Safari рендерит `<object type="application/pdf">` лучше чем iframe.

**Cons:**
- Accessibility: screen-reader не читает содержимое PDF через `<object>`.
  Требует aria-label + текстовый fallback.
- Поведение немного отличается от iframe между браузерами (Chrome / Firefox / Safari).

**Рекомендация:** вариант A (iframe + blob) как основной + Вариант C как iOS fallback.
Детект iOS: `navigator.platform.includes('iPhone') || navigator.userAgent.includes('iPhone')`.

### 2.3 Layout PDF-viewer в wizard step

```
┌─────────────────────────────────────────────────────────────────┐
│ [FileText icon] Ваш контракт                       [Badge: PREVIEW] │
│ Ознакомьтесь с документом перед подписанием                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                                                           │   │
│  │          [Skeleton overlay или iframe PDF]                │   │
│  │              высота: 480px desktop / 360px mobile         │   │
│  │                                                           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [Alert info] Данные в контракте: имя, email, реквизиты —        │
│  задаются администратором. При ошибке обратитесь к ADMIN.        │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ [checkbox]  Подтверждаю что ознакомился с MSA-контрактом │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  [Avatar initials]  Дмитро Марченко                              │
│  Подпись — имя из admin-полей (read-only)                        │
│                                                                   │
│  [ Подписать контракт ← primary button, full-width ]             │
└─────────────────────────────────────────────────────────────────┘
```

**Responsive:**

- **1440:** viewer height 520px, wizard max-width `max-w-2xl`.
- **768:** viewer height 480px, wizard max-width `max-w-xl`.
- **320:** viewer height 340px. На iOS → `<object>` или download-link fallback.

**Loading state (перед загрузкой PDF blob):**

```tsx
// Skeleton поверх iframe зоны
<div className="relative w-full rounded-md border border-border bg-muted/20" style={{ height: '480px' }}>
  {isLoadingPdf && (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-md bg-muted/30">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Загрузка контракта...</p>
    </div>
  )}
  {blobUrl && (
    <iframe
      src={blobUrl}
      title="Предварительный просмотр контракта"
      className={cn('w-full h-full rounded-md border-0', isLoadingPdf && 'invisible')}
      onLoad={() => setIsLoadingPdf(false)}
      aria-label="Предварительный просмотр MSA-контракта"
    />
  )}
</div>
```

**Error state (PDF endpoint упал):**

```tsx
// Если fetch завершился с ошибкой — показать fallback-блок
<div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
  <AlertTriangle className="inline h-4 w-4 mr-2" />
  Не удалось загрузить предварительный просмотр контракта.
  Обратитесь к администратору.
</div>
```

**Empty state (шаблон не найден для роли):**

- Backend `GET /api/contracts/templates/current/:role` вернул 404 → preview endpoint вернёт 404.
- Показать тот же компонент что сейчас в `SignContractStep` при `!template`:
  `FileText` icon + «Шаблон контракта для вашей роли не найден. Обратитесь к администратору.»

### 2.4 Консистентность с audit trail

`/crm/profile/audit` — там пользователь скачивает подписанный PDF через
`GET /api/contracts/:id/pdf`. Этот endpoint уже существует и работает (PR #108).

Дополнительно: рассмотреть добавление **inline preview** на audit-странице (Pending Decision #2).

---

## 3. Admin legal-поля (новая секция в UserDialog)

### 3.1 Проблема

`users.displayName` = "Dmytro Marchenko" (английский, из Google OAuth).
В юридическом контракте (MSA) нужно: ФИО кириллицей в порядке Фамилия Имя Отчество.

В `interpolateVariables()` сейчас: `employeeName: user.displayName ?? 'не указано'` — НЕВЕРНО.

### 3.2 Новое поле в schema `users`

Нужно **одно новое поле**:

```typescript
// apps/api/src/database/schema.ts — добавить в таблицу users:
legalFullName: text('legal_full_name'),
// Legal ФИО (кириллица, порядок: Фамилия Имя Отчество).
// Задаётся ADMIN при создании/редактировании.
// Используется в контракте вместо displayName.
// NULL = не задано → interpolateVariables вернёт 'не указано'.
```

**Почему одно поле, а не три (firstName/lastName/patronymic):**
- В юридическом тексте ФИО всегда используется целиком.
- Разбивать на части не нужно для контракта.
- Admin знает полный порядок (ФИО или ИО Фамилия — вводит как нужно).
- Проще валидация: `min(5, 'ФИО минимум 5 символов')`.

**Реквизиты банка / USDT кошелёк:** поля уже есть (`walletUsdtErc20`, `bankUahRecipient`,
`bankUahIban`, `bankUahRnokpp`, `bankUahBankName`). Не дублировать.

### 3.3 Drizzle migration

```sql
-- Новая миграция (следующий номер после 0027):
ALTER TABLE users ADD COLUMN legal_full_name TEXT;
COMMENT ON COLUMN users.legal_full_name IS
  'Legal full name (Cyrillic, order: Surname First Patronymic). Set by ADMIN.';
```

Схема Drizzle уже включает поля payment requisites — добавляется только `legal_full_name`.

### 3.4 Форма в UserDialog.tsx — новая секция «Данные для контракта»

Новая Section добавляется **после Section 1 (Идентичность)** и **до Section 2 (Контакты)**.
Visibility: показывать для всех ролей кроме ADMIN (ADMIN не подписывает контракт).

```
┌─ Section: Данные для контракта ─────────────────────────────────┐
│  Информация для MSA-контракта. Задаётся администратором.         │
│  Используется в юридическом документе (не для отображения в UI). │
│                                                                   │
│  Поле: Юридическое ФИО                     [required for signing] │
│  Placeholder: «Марченко Дмитро Олексійович»                      │
│  Hint: Кириллица, порядок: Фамилия Имя Отчество                  │
│  Validation: min 5 символов, max 200                             │
│  data-testid: "user-dialog-legal-full-name"                      │
└─────────────────────────────────────────────────────────────────┘
```

**Добавить в `defaultValues` формы:**

```typescript
legalFullName: editingUser?.legalFullName ?? '',
```

**В payload создания (CreateUserDto) / обновления (AdminUpdateUserDto):**

```typescript
legalFullName: value.legalFullName.trim() || undefined,
```

**Shared schema обновление** (`packages/shared/src/schemas/users.ts`):

```typescript
// Добавить в createUserSchema и adminUpdateUserSchema:
legalFullName: z.string().min(5).max(200).optional(),
// Добавить в userSchema (UserProfileDto):
legalFullName: z.string().nullable().optional(),
```

### 3.5 Обновление interpolateVariables

```typescript
// signed-contracts.service.ts — interpolateVariables():
// БЫЛО:
employeeName: user.displayName ?? 'не указано',

// СТАЛО:
employeeName: user.legalFullName?.trim() || user.displayName || 'не указано',
// Fallback-цепочка: legal ФИО → displayName (platform name) → 'не указано'
// Fallback через displayName сохраняет backward compatibility для старых рядов без legalFullName.
```

**Тип User в `interpolateVariables` pick:**

```typescript
static interpolateVariables(
  bodyMarkdown: string,
  user: Pick<
    User,
    | 'displayName'
    | 'legalFullName'  // ДОБАВИТЬ
    | 'email'
    | 'role'
    | 'walletUsdtErc20'
    | 'walletUsdtLabel'
    | 'bankUahRecipient'
    | 'bankUahIban'
    | 'bankUahRnokpp'
    | 'bankUahBankName'
    | 'paymentMethod'
  >,
  signedAt: Date,
)
```

---

## 4. Simplification подписания (SignContractStep.tsx)

### 4.1 Убрать typed-name input

Поле `<Input placeholder="Ваше полное имя" />` и связанный `nameError` state — удалить.

**Что заменяет:**

Под зоной PDF-viewer добавить **read-only signature identification block**:

```tsx
<div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-4 py-3">
  {/* Аватар с инициалами */}
  <Avatar className="h-8 w-8 shrink-0">
    <AvatarFallback className="text-xs">
      {getInitials(user.legalFullName ?? user.displayName)}
    </AvatarFallback>
  </Avatar>
  <div className="min-w-0 flex-1">
    <p className="text-sm font-medium leading-none truncate">
      {user.legalFullName || user.displayName}
    </p>
    <p className="text-xs text-muted-foreground mt-1">
      Подпись — юридическое ФИО из профиля
    </p>
  </div>
</div>
```

**Если `legalFullName` не заполнен (guard, §6):**
Показать `<Alert variant="destructive">` + блокировать кнопку «Подписать».

### 4.2 Обновление submit flow

```typescript
// БЫЛО: signMutation.mutate({ typedName })
// СТАЛО:
signMutation.mutate() // тело пустое, или: { typedName: '' }
```

**Изменения в shared schema:**

`signContractSchema` (`packages/shared/src/schemas/contracts.ts`):

```typescript
// БЫЛО:
export const signContractSchema = z.object({
  typedName: z.string().min(1, 'Введите ваше имя').max(200),
})

// СТАЛО:
export const signContractSchema = z.object({
  // typedName опционален — backend берёт из legalFullName
  typedName: z.string().max(200).optional(),
})
```

### 4.3 Что происходит с `signed_contracts.signedTypedName`

`signedTypedName text NOT NULL` — поле существует в схеме БД.

**Рекомендуемый подход (Coder должен решить):**

Option A — Заполнять из `legalFullName` server-side:

```typescript
// signed-contracts.service.ts, sign():
signedTypedName: user.legalFullName?.trim() || user.displayName || '',
// Аудит-трейл сохраняет имя которое было в профиле на момент подписания.
// Колонка не меняется в schema — NOT NULL сохраняется.
```

Option B — Переименовать семантику: `signedTypedName` → хранит resolved legal name.
Требует migration для изменения comment в БД (data остаётся).

**Рекомендация: Option A** — нет migration, backward compatible, аудит-трейл сохраняется.
`variablesFilled.employeeName` в JSONB тоже обновится т.к. `interpolateVariables` обновлён.

### 4.4 Новый UI SignContractStep

**Итоговый layout (после изменений):**

```
[FileText] Ваш контракт

┌────────────────────────────────────┐
│     iframe PDF preview (520px)     │
│     loading skeleton overlay       │
└────────────────────────────────────┘

[info alert] Данные задаются администратором...

[checkbox label]
┌─────────────────────────────────────────────────────────────┐
│ [ ] Я ознакомился и подтверждаю условия MSA-контракта       │
└─────────────────────────────────────────────────────────────┘

[signature block — read-only]
┌─────────────────────────────────────────────────────────────┐
│ [DM]  Марченко Дмитро Олексійович                           │
│       Подпись — юридическое ФИО из профиля                  │
└─────────────────────────────────────────────────────────────┘

[ Подписать контракт ]  ← disabled пока !confirmed || !blobUrl || legalNameMissing
```

**State variables (упрощённый, без typed-name):**

```typescript
const [confirmed, setConfirmed] = useState(false)
const [blobUrl, setBlobUrl] = useState<string | null>(null)
const [isLoadingPdf, setIsLoadingPdf] = useState(true)
const [pdfError, setPdfError] = useState(false)
```

---

## 5. Accessibility (WCAG 2.2 AA critical paths)

### 5.1 Focus order в wizard step

```
1. Heading "Ваш контракт" (h3 или роль в stepper)
2. PDF viewer iframe — focusable (tabIndex=0), title="Предварительный просмотр контракта"
3. Info alert (если есть)
4. Checkbox "Я ознакомился" — natively focusable
5. Signature block (read-only, role="group", aria-label="Подписант")
6. Button "Подписать контракт"
```

### 5.2 Target sizes

| Элемент           | Текущий (оценка) | Требование SC 2.5.8 | Fix                        |
| ----------------- | ---------------- | ------------------- | -------------------------- |
| Checkbox `h-4 w-4` (16px) | 16×16px | 24×24px             | `min-h-6 min-w-6` (24px)  |
| Кнопка «Подписать» | full-width, h-10 (40px) | OK           | Без изменений              |
| Info alert link «к ADMIN» | inline text | 24px height    | Обернуть в `<button>` или сделать `<a>` с `py-1` |

### 5.3 Contrast

Существующие design tokens `--foreground` / `--muted-foreground` — уже проверены в системе.
Новые элементы:

- Signature block text: `text-sm font-medium` на `bg-muted/20` → token `foreground` на `muted` bg.
  Светлый режим: `oklch(0.12 0 0)` на `oklch(0.94 0 0)` ≈ 8:1. OK.
  Тёмный режим: `oklch(0.97 0 0)` на `oklch(0.16 0 0)` ≈ 12:1. OK.
- Muted hint text `text-xs text-muted-foreground` на `bg-muted/20`:
  Светлый: `oklch(0.50)` на `oklch(0.94)` ≈ 3.8:1. Borderline — это small text, нужно 4.5:1.
  **Fix:** использовать `text-muted-foreground` напрямую без `/20 overlay`, или повысить до
  `oklch(0.40)` в light mode hint-тексте. Либо сделать hint 14px (не small text).

- Skeleton overlay `bg-muted/30` с loading text: `text-muted-foreground` — OK.

### 5.4 Screen-reader fallback для PDF viewer

`<iframe>` с PDF недоступен для screen-readers. Добавить `aria-describedby`:

```tsx
<div role="region" aria-label="Контракт для подписания">
  <iframe
    src={blobUrl}
    title="Предварительный просмотр MSA-контракта"
    aria-label="Предварительный просмотр MSA-контракта"
  />
  <p id="pdf-sr-note" className="sr-only">
    PDF-документ. При необходимости используйте кнопку «Скачать» ниже для
    просмотра контракта во внешней программе.
  </p>
</div>
```

Добавить кнопку / ссылку «Скачать для просмотра» (только когда `blobUrl` есть):

```tsx
<a href={blobUrl} download="contract-preview.pdf" className="text-xs underline text-muted-foreground">
  Скачать для просмотра
</a>
```

### 5.5 Checkbox accessibility

Нативный `<input type="checkbox">` — сохранить (не заменять на Radix). Сейчас в `AcceptTosStep`
и `SignContractStep` используется `<input type="checkbox" class="h-4 w-4 accent-primary">`.

Fix для SC 2.5.8: `className="mt-0.5 h-6 w-6 accent-primary"` (24×24px).

### 5.6 Modal/wizard a11y

Wizard рендерится в полноэкранном overlay. Проверить:
- `aria-modal="true"` на корневом контейнере wizard.
- Focus trap при открытии (первый интерактивный элемент — кнопка или checkbox).
- Escape не закрывает wizard (пользователь ОБЯЗАН завершить onboarding) — убедиться что
  `onOpenChange` не обрабатывает `Escape` в wizard container.

---

## 6. Edge Cases & Guards

### 6.1 Если `legalFullName` не заполнен

ADMIN мог создать пользователя до введения нового поля (migration backward compat).

**Behavior:**

```
├─ [Alert variant="warning" inside signature block]
│    "Юридическое ФИО не заполнено администратором.
│     Подписание контракта невозможно.
│     Обратитесь к администратору для заполнения данных."
│
└─ Кнопка «Подписать» — disabled (не только из-за checkbox, но из-за отсутствия ФИО)
   cursor-not-allowed, aria-disabled="true"
   Tooltip: "Заполните юридическое ФИО в профиле (обратитесь к администратору)"
```

**Backend guard (доп. защита):** `sign()` в `SignedContractsService` проверяет
`!user.legalFullName?.trim()` → `BadRequestException('LEGAL_NAME_REQUIRED')`.

Frontend обрабатывает это в `onError`:

```typescript
if (message.includes('LEGAL_NAME_REQUIRED')) {
  toast.error('Юридическое ФИО не заполнено. Обратитесь к администратору.')
  return
}
```

### 6.2 Если шаблон контракта не существует для роли

Сейчас: показывается `FileText icon + "Шаблон не найден"`. Сохранить это поведение.
Preview endpoint: `GET /api/contracts/preview-pdf` вернёт 404 → frontend показывает error state.

### 6.3 PDF не загрузился (network error, timeout)

Показать error state (§2.3) + кнопку «Повторить загрузку» (retry через invalidateQuery или
повторный fetch).

### 6.4 Пользователь уже подписал (idempotency)

Backend `sign()` уже idempotent (возвращает existing если есть). Frontend не меняется.
Wizard step не должен показываться если `onboarding-status` говорит `requiresContract: false`.

### 6.5 Мобильный (iOS Safari) — iframe не рендерит PDF

```typescript
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)

// Если iOS — не использовать iframe, показывать <object> или download-fallback
{isIos ? (
  <div className="rounded-md border border-border bg-muted/10 p-6 text-center space-y-3">
    <FileText className="h-10 w-10 text-muted-foreground mx-auto" />
    <p className="text-sm text-muted-foreground">
      Встроенный просмотр PDF недоступен на вашем устройстве.
    </p>
    <a href={blobUrl} download="contract-preview.pdf">
      <Button variant="outline" size="sm">Скачать контракт для просмотра</Button>
    </a>
  </div>
) : (
  <iframe src={blobUrl} ... />
)}
```

---

## 7. Pending Decisions (для выбора User'ом)

### PD-1 — Способ embed PDF на мобильном (iOS)

**Контекст:** iframe + blob-URL хорошо работает на desktop. iOS Safari — нестабильно.

**Вариант A (рекомендуется):** Детект iOS → show download-link fallback вместо iframe.
Пользователь открывает PDF во внешнем приложении (Files/Adobe), возвращается в браузер, подписывает.
- Pros: нулевая зависимость, 100% надёжность.
- Cons: flow прерывается (пользователь покидает браузер).

**Вариант B:** `<object type="application/pdf">` как fallback внутри `<iframe>`.
```html
<iframe src="...">
  <object data="..." type="application/pdf">
    <a href="...">Скачать</a>
  </object>
</iframe>
```
- Pros: Progressive enhancement, без JS detects.
- Cons: Поведение в iOS непредсказуемо, объект может всё равно не отрендериться.

**Вариант C:** Не решать сейчас — wizard используется внутри компании (non-mobile contexts).
Показать iframe без iOS fix, добавить кнопку «Скачать» всегда.

---

### PD-2 — Inline PDF preview на audit-странице (`/crm/profile/audit`)

**Контекст:** Сейчас на audit trail есть кнопка «Скачать PDF» (`GET /api/contracts/:id/pdf`).
После изменений в wizard — стоит ли также добавить inline preview там?

**Вариант A:** Оставить только download. Аудит — редкое действие, popup/download достаточно.
- Pros: ноль изменений в audit UI.
- Cons: Непоследовательно — wizard показывает inline, audit — только download.

**Вариант B:** Добавить кнопку «Открыть» рядом с «Скачать» — открывает PDF в новой вкладке
(`/api/contracts/:id/pdf` с `Content-Disposition: inline`).
- Pros: Консистентно с wizard UX.
- Cons: Требует добавления второго Content-Disposition mode на endpoint (query param `?view=1`).

**Вариант C (рекомендуется для audit):** В audit-карточке добавить inline iframe/object
в expandable accordion (collapsed по умолчанию). Click → expand → PDF загружается.
- Pros: Консистентно, не меняет backend (тот же `/pdf` endpoint, blob в iframe).
- Cons: Дополнительная работа в audit UI.

---

### PD-3 — Что показывать в preview-PDF signature block (preview watermark)

**Контекст:** Preview PDF генерируется с `contractNumber: 'PREVIEW'` и `signedAt: new Date()`.
Signature block будет выглядеть как будто контракт уже подписан.

**Вариант A (рекомендуется):** Добавить watermark «ПРЕДВАРИТЕЛЬНЫЙ ПРОСМОТР» в PDF (красный диагональный текст поверх страниц).
Требует изменения `ContractPdfService.generateContractPdf()` — опциональный `isPreview: boolean` param.
- Pros: Явно видно что это preview, не финальный документ.
- Cons: Усложняет PDF generation service.

**Вариант B:** Не добавлять watermark. В signature block написать имя пользователя,
дату «сегодня» и tooltip «это предварительный просмотр».
Badge `[PREVIEW]` в UI wizard над viewer — достаточно.
- Pros: Нет изменений в PDF service.
- Cons: PDF выглядит как финальный документ с сегодняшней датой.

**Вариант C:** Убрать signature block из preview PDF полностью.
Preview генерирует PDF без нижнего блока подписи и QR.
- Pros: Принципиально отличается от подписанного PDF.
- Cons: Более глубокое изменение PDF service — нужен режим «preview mode» без footer.

---

### PD-4 — Когда показывать предупреждение об отсутствующем `legalFullName`

**Контекст:** ADMIN мог создать пользователя до появления поля. Migration добавляет `NULL`.

**Вариант A (рекомендуется):** Блокировать подпись сразу при загрузке wizard step.
Alert warning + disabled button + tooltip «Обратитесь к администратору».
- Pros: Четкое UX — пользователь знает почему не может подписать.
- Cons: Фрустрация если admin просто не знает что нужно заполнить новое поле.

**Вариант B:** Разрешить подпись с fallback на `displayName` (как было раньше).
После перехода — в JSONB `variablesFilled.employeeName` сохранится platform-name.
Admin может исправить через new admin tool в будущем.
- Pros: Zero friction для пользователя, backward compat.
- Cons: Контракт с юридически неверным именем (en → kyr).

**Вариант C:** Показать warning (не блокировать), позволить подписать.
Рядом с signature block: «Юридическое ФИО не задано, будет использован платформенный профиль».
- Pros: Компромисс — пользователь видит проблему, но не заблокирован.
- Cons: Создаёт юридически неоднозначные документы.

---

## 8. Components используемые

Все из существующих shadcn/ui `apps/web/app/components/ui/`:

| Компонент          | Зачем                                                |
| ------------------ | ---------------------------------------------------- |
| `Avatar`, `AvatarFallback` | Инициалы подписанта в signature block       |
| `Button`           | «Подписать контракт», «Скачать для просмотра»        |
| `Skeleton`         | Loading overlay над PDF viewer                       |
| `Loader2` (lucide) | Spinner в loading state                              |
| `Alert` (если есть) / `div` с border | Warning о missing legalFullName     |
| `ScrollArea`       | НЕ нужен — заменяется на iframe PDF                  |
| `Checkbox` / native `<input type="checkbox">` | Подтверждение ознакомления    |
| `Tooltip`          | Disabled button hint                                 |
| `Badge`            | PREVIEW badge над viewer                             |

**Новые компоненты: НЕ нужны.** Всё строится из существующих.

---

## 9. Token map

Все существующие токены — из `globals.css` `@theme inline {}`. Новые не нужны.

| Token                                    | Где используется                            |
| ---------------------------------------- | ------------------------------------------- |
| `--color-border`                         | Рамка PDF-viewer, signature block, checkbox label |
| `--color-muted` / `--color-muted-foreground` | Loading overlay, hint text, error state |
| `--color-primary`                        | Кнопка «Подписать», checkbox accent         |
| `--color-destructive`                    | Error state PDF viewer, legalFullName missing alert |
| `--color-card`, `--color-card-foreground` | Signature block background если не muted   |
| `--radius-lg` (0.625rem)                 | PDF viewer container, signature block        |

---

## 10. Motion spec

Минимум motion (контракт — серьёзный контекст):

- PDF viewer появляется через `opacity: 0 → 1` (200ms, `ease-out`) когда blob загружен.
  Skeleton уходит через opacity 0 (150ms).
- Кнопка «Подписать» — нет доп. анимаций (уже есть `isPending` spinner через Loader2).
- Signature block — нет анимации. Статичный блок.

```css
/* apps/web/app/styles/globals.css уже есть transition helpers через tw-animate-css */
/* Использовать: transition-opacity duration-200 ease-out */
```

---

## 11. Data flow summary (для Coder)

```
UserDialog (ADMIN) → PATCH /api/users/:id { legalFullName: "Марченко Дмитро" }
                          ↓
                    users.legal_full_name = "Марченко Дмитро"

SignContractStep (frontend, wizard)
  → GET /api/contracts/preview-pdf  [bypass-listed]
  ← application/pdf stream (blob)
  → URL.createObjectURL(blob) → iframe src
  → user reads PDF
  → user checks checkbox
  → POST /api/contracts/sign  { typedName: "" }  [bypass-listed — уже есть]
        ↓
    sign() resolves user.legalFullName → signedTypedName
    interpolateVariables(): employeeName = legalFullName || displayName
    INSERT signed_contracts (signedTypedName = legalFullName)
  ← 201 { contractNumber: "CHK-N-2026" }

/crm/profile/audit
  → GET /api/contracts/me
  → GET /api/contracts/:id/pdf  [download signed contract]
```

---

## 12. Что НЕ меняется

- Шаблоны контрактов (ADMIN-редактируемые в `/crm/admin/templates/contracts`).
- `AcceptTosStep.tsx` — ToS preview остаётся markdown (это приемлемо для ToS).
- `TosUpdateBanner.tsx` — без изменений.
- `OnboardingGuard` bypass list — только добавляется `/api/contracts/preview-pdf`.
- Audit-trail immutability: `signedContracts.bodyMarkdownSnapshot` + `variablesFilled` — не трогаем.
- `contract_number_seq` — не трогаем.
- PDF layout (эмблема, номер, separator, QR) — уже хорошо (PR #108). Не переделывать.

---

## 13. Coder handoff checklist

**Backend (apps/api):**

- [ ] Migration: `ALTER TABLE users ADD COLUMN legal_full_name TEXT`
- [ ] Update Drizzle schema `users` — добавить `legalFullName` поле
- [ ] Update `signed-contracts.service.ts`:
  - `interpolateVariables()` — `employeeName: legalFullName || displayName || 'не указано'`
  - `sign()` — `signedTypedName: legalFullName || displayName || ''`
  - Guard: если `!legalFullName.trim()` → `BadRequestException('LEGAL_NAME_REQUIRED')` (если PD-4 = Вариант A)
- [ ] New endpoint: `GET /api/contracts/preview-pdf` (bypass-listed, auth required)
  - Генерирует PDF с `contractNumber: 'PREVIEW'` (или watermark — pending PD-3)
  - Throttle 5 req/min
- [ ] Update `OnboardingGuard.bypassPrefixes` — добавить `/api/contracts/preview-pdf`
- [ ] Update `UsersService` + Users controller — поддержка `legalFullName` в PATCH/POST

**Shared (packages/shared):**

- [ ] `schemas/users.ts` — добавить `legalFullName` в `userSchema`, `createUserSchema`, `adminUpdateUserSchema`
- [ ] `schemas/contracts.ts` — `signContractSchema.typedName` → optional

**Frontend (apps/web):**

- [ ] `UserDialog.tsx` — добавить секцию «Данные для контракта» с полем `legalFullName`
- [ ] `SignContractStep.tsx` — рефакторинг:
  - Убрать typed-name input + `nameError` state
  - Добавить PDF viewer (iframe + blob-URL + loading skeleton)
  - Добавить signature block (avatar + legalFullName read-only)
  - Добавить guard для missing legalFullName (pending PD-4)
  - Добавить iOS fallback (pending PD-1)
  - Добавить download link для a11y

---

## 14. Дополнения от User (2026-06-04) — входят в scope PR A

### 14.1 Убрать сайдбар (и шапку) из онбординга

**Проблема:** онбординг-роут `/crm/onboarding` вложен под layout `/crm` (`apps/web/app/routes/crm/route.tsx`),
который всегда рендерит `<header>` + `<NavSidebar>` + ambient background. Поэтому при онбординге виден
сайдбар и шапка, хотя сам `crm/onboarding/route.tsx` — уже full-screen карточка.

**Фикс (Coder, PR A):** в `CrmLayout` (`apps/web/app/routes/crm/route.tsx`) после auth-проверок —
ранний `return <Outlet />` когда `location.pathname.startsWith('/crm/onboarding')` (онбординг сам
даёт свой full-screen layout). Переменная `onOnboardingRoute` уже вычисляется внутри useEffect (стр. ~69) —
поднять в scope компонента. Не рендерить header / NavSidebar / background blobs на онбординг-роуте.

**Verify:** dev-login un-onboarded SENIOR (`dmytro.marchenko@cheekycheese.dev`) → `/crm/onboarding`
без сайдбара и шапки (Manual QA скриншот 320/768/1440).

### 14.2 Добавить DROP в Dev Login

**Где:** `apps/web/app/routes/crm_/login.tsx`, массив `DEV_USERS` (хардкод, стр. ~41) — сейчас нет DROP.
Добавить запись с email одного из DROP-юзеров, которых засидит PR B (взять стабильный известный email
из нового seed после merge PR B). Label формата `«<Имя> — DROP»`.

> Зависимость: email DROP-юзера фиксируется в PR B (seed). PM передаст конкретный email в task PR A
> после merge PR B.

## Ссылки

- `apps/api/src/contracts/signed-contracts.service.ts` — `interpolateVariables()`
- `apps/api/src/contracts/contract-pdf.service.ts` — `generateContractPdf()`
- `apps/api/src/common/pdf/pdf.constants.ts` — `PDF_BRAND`, `PDF_LAYOUT`, `PDF_COLORS`
- `apps/api/src/auth/onboarding.guard.ts` — bypass list
- `apps/web/app/components/onboarding/SignContractStep.tsx` — компонент для рефакторинга
- `apps/web/app/components/users/UserDialog.tsx` — форма создания/редактирования пользователя
- `apps/web/app/styles/globals.css` — design tokens
- `packages/shared/src/schemas/contracts.ts` — `signContractSchema`, `InterpolatableVariableKey`
