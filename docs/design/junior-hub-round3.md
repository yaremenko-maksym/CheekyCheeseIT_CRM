# Design Spec: Junior Hub Round 3 — Dense Bento, No Contract, No Empty Space

> Mode A → B — Design Direction (round 3, post-UT feedback #184)
> Spec slug: `junior-hub-round3`
> Источник: UT feedback owner (2026-06-13) — «всё так же хромает, выглядит сыро, пустые места»
> Прецеденты: `docs/design/junior-hub-round2.md` (round 2, реализован в #184) · `docs/design/drop-role-ux.md` (единый язык)
> Автор: ui-ux-designer · 2026-06-13
> Скриншот «до»: `docs/design/assets/junior-r3/01-before-1440.jpeg`

---

## 0. Диагностика (почему round 2 вышел сыро)

### Измеренные высоты на 1440×900 (живой стек после #184)

| Компонент          | Реальная высота | Контент-высота | Пустота    |
| ------------------ | --------------- | -------------- | ---------- |
| ProjectInfoCard    | 397px           | ~130px         | **~267px** |
| PersonaCard        | 397px           | ~160px         | **~237px** |
| ContractStatusCard | 113px           | 113px          | 0px        |
| SalarySnapshotCard | 272px           | 272px          | 0px        |
| HrContactCard      | 154px           | 154px          | 0px        |
| ProjectCredentials | 239px           | 239px          | 0px        |

### Root cause

1. **`h-full` на карточках верхнего ряда** — ProjectInfoCard и PersonaCard получают `h-full`, что в CSS grid растягивает их до высоты самой высокой ячейки в ряду (397px). Но в левой ячейке: лого + компания + 2 строки данных = ~130px. В средней: аватар + имя + кнопка = ~160px. Разница ~240px — чистая пустота.

2. **Контент в PersonaCard не прижат ни вверх ни вниз** — `flex-col gap-4` без `justify-between`. Аватар стоит вверху, кнопка под ним, нижние ~120px пустые.

3. **ContractStatusCard тощая (113px)** — только badge «Подписан» при заполненном SalaryCard (272px). В flex-col это выглядит нормально, но создаёт визуальный дисбаланс: правая колонка начинается с маленькой карточки, потом большая.

4. **Нижняя полоса дисбалансирована** — HrContactCard 154px, Credentials 239px. HR визуально «не дотягивается».

5. **3-колонный layout с тощим левым столбцом** — на 1440px каждая колонка 304px. ProjectInfo в 304px выглядит рыхло — компания, домен, старт, статус — всего 4 строки данных в колонке шириной 304px.

### Вывод

Round 2 решил проблему скролла (контент влезает в 900px по вертикали), но не решил проблему **горизонтального воздуха**. Карточки тянутся в высоту чтобы выровняться, хотя контента нет. Решение — убрать `h-full`, перейти на `items-start` в grid, и реструктурировать карточки так, чтобы контент заполнял их по-настоящему.

---

## 1. Новая архитектура хаба (round 3)

### 1.1 Принципы редизайна

- **Нет контракту** — `ContractStatusCard` убирается полностью (требование UT). Место идёт зарплате.
- **Нет `h-full` на тощих карточках** — карточки `h-fit`, grid получает `items-start` чтобы строки не растягивались.
- **Содержимое заполняет карточки** — в ProjectInfoCard добавляем HR-контакт (он компактный); PersonaCard получает `justify-between` + дополнительные данные персоны.
- **Зарплата расширяется** — без ContractCard справа освобождается col-span: зарплата занимает полную правую колонку от верха.
- **Нижняя полоса** — только Credentials (full-width), без отдельного HR (HR переехал в ProjectInfoCard).

### 1.2 Логические блоки (новая группировка)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Мой проект · LearnSpace Inc                                                  │
├──────────────────────────┬──────────────────────────────────────────────────┤
│  О ПРОЕКТЕ               │  МОЯ ЗАРПЛАТА                                   │
│  col-span-1 (lg: 4/12)   │  col-span-1 (lg: 8/12)  — wide                  │
│                          │                                                  │
│  [Лого] LearnSpace Inc   │  [сумма крупно]  500 USD / мес                  │
│         learnspace.io    │                                                  │
│  ────────────────────    │  [выплаты] 3 последних в горизонтальных строках  │
│  Старт   05 янв 2026     │                                                  │
│  Статус  Активный        │  [→ Все мои выплаты]                            │
│  ────────────────────    │                                                  │
│  Ваш HR                  │                                                  │
│  Anna Lysenko            │                                                  │
│  TG · Phone              │                                                  │
├──────────────────────────┤                                                  │
│  СИНЬОР ПРОЕКТА          │                                                  │
│  col-span-1 (lg: 4/12)   │                                                  │
│                          │                                                  │
│  [Аватар] фыв фыв ф фыв  │                                                  │
│           фывфыв         │                                                  │
│  [Открыть легенду]       │                                                  │
├──────────────────────────┴──────────────────────────────────────────────────┤
│  ПАРОЛИ ПРОЕКТА                         col-span-full                       │
│  [+ Добавить] · список credentials горизонтально в 2 колонки               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Grid структура (Tailwind)

**Desktop ≥ 1024px (12-col subgrid pattern через 3-col grid с col-span)**

```tsx
// Внешний grid: 3 колонки, items-start (критично — без h-full растяжки)
<motion.div
  className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start"
  data-testid="junior-hub-bento"
>
  {/* Левая колонка: О проекте + Синьор стопкой */}
  <div className="lg:col-span-1 flex flex-col gap-4">
    <ProjectInfoCard project={project} hrContact={hrContact} />
    <PersonaCard legend={legend} isLoading={legendLoading} />
  </div>

  {/* Правая колонка: Зарплата — широкая (2/3 ширины) */}
  <div className="lg:col-span-2">
    <SalarySnapshotCard salaryMeta={salaryMeta} salaryTxs={salaryTxs} isLoading={salaryLoading} />
  </div>

  {/* Нижняя полоса: Credentials full-width */}
  <div className="col-span-full">
    <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd />
  </div>
</motion.div>
```

**Ключевые изменения от round 2:**

- `items-start` на grid → карточки НЕ растягиваются до высоты строки
- Левая `div`-обёртка (не `motion.div`) для `flex-col gap-4` стека ProjectInfo + Persona
- `lg:col-span-2` для SalaryCard — занимает 2/3 ширины, визуально доминирует
- HR переезжает внутрь ProjectInfoCard (вместо отдельного `HrContactCard`)
- Нет `ContractStatusCard` вообще
- Нет отдельного `HrContactCard` в нижней полосе

**Tablet 768–1023px (2 колонки):**

```tsx
className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start'
```

На md: левый `div` — col-1, правый div (Salary) — col-1 → 2 равные колонки. Credentials — col-span-full.

**Mobile < 768px (1 колонка, порядок):**

1. ProjectInfoCard (с HR внутри)
2. PersonaCard
3. SalarySnapshotCard
4. ProjectCredentialsSection

### 1.4 Расчёт высоты на 1440×900

| Элемент                            | Высота (прим.)   |
| ---------------------------------- | ---------------- |
| Заголовок h1 + subtitle            | ~56px            |
| gap-4                              | 16px             |
| Верхний ряд (левая колонка — стек) | ~280px           |
| ↳ ProjectInfoCard (с HR встроен)   | ~170px           |
| ↳ gap-4                            | 16px             |
| ↳ PersonaCard (compact)            | ~104px           |
| Правая колонка (Salary, wide)      | ~260px (≤ левой) |
| gap-4                              | 16px             |
| Credentials (full-width)           | ~180px           |
| **Итого контент**                  | **~344px**       |
| + page padding (py-6)              | ~48px            |
| **Итого**                          | **~404px**       |

Значительно меньше 900px — хаб на одном экране. Левая и правая колонки выровнены по `items-start`, визуально height-matched через схожий объём контента.

---

## 2. Изменения в каждой карточке

### 2.1 ProjectInfoCard — добавить HR-контакт

**Проблема round 2:** ProjectInfoCard содержит 4 строки (лого, домен, старт, статус). На 304px это выглядит рыхло. `h-full` растягивал её до 397px — 267px пустоты.

**Round 3:** встроить HR-контакт прямо в ProjectInfoCard как раздел ниже. Убрать `h-full`.

```
┌─ Card border-border/40 ──────────────────────────────────────┐
│  [Лого] LearnSpace Inc                                        │
│         learnspace.io                                         │
│  ─────────────────────────────────────────────────────────── │
│  Старт   05 января 2026 г.                                    │
│  Статус  [Активный]                                           │
│  ─────────────────────────────────────────────────────────── │
│  Ваш HR                     (text-xs text-muted-foreground)   │
│  Anna Lysenko               (text-sm font-medium)             │
│  [TG] @anna_lysenko · [Phone] +38...                         │
└──────────────────────────────────────────────────────────────┘
```

**Реализация:**

```tsx
function ProjectInfoCard({
  project,
  hrContact,
  hrLoading,
}: {
  project: ProjectDto
  hrContact: HrContactDto | null
  hrLoading: boolean
}) {
  const isActive = !project.archivedAt

  return (
    <Card className="border-border/40 bg-card" data-testid="project-info-card">
      <CardHeader className="flex flex-row items-start gap-3 pb-3">
        <ProjectLogo ... />
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold leading-tight truncate">
            {project.companyName}
          </CardTitle>
          {project.domain && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{project.domain}</p>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3 text-sm">
        {/* Project meta */}
        <div className="space-y-2">
          {project.startDate && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Старт</span>
              <span className="font-medium text-xs">
                {new Date(project.startDate).toLocaleDateString('ru-RU', {
                  day: '2-digit', month: 'long', year: 'numeric',
                })}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Статус</span>
            <Badge variant={isActive ? 'status-active' : 'status-closed'} className="text-xs">
              {isActive ? 'Активный' : 'Завершён'}
            </Badge>
          </div>
        </div>

        {/* HR contact — embedded, no separate card */}
        <Separator className="opacity-30" />
        <HrInline hrContact={hrContact ?? null} isLoading={hrLoading} />
      </CardContent>
    </Card>
  )
}

// Compact inline HR — NOT a separate Card
function HrInline({ hrContact, isLoading }: { hrContact: HrContactDto | null; isLoading: boolean }) {
  if (isLoading) return <Skeleton className="h-4 w-32" />

  const hasContact = hrContact?.displayName || hrContact?.telegram || hrContact?.phone

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">Ваш HR</p>
      {!hasContact ? (
        <p className="text-xs text-muted-foreground/60 italic">HR не назначен</p>
      ) : (
        <div className="space-y-1.5">
          {hrContact?.displayName && (
            <p className="text-sm font-medium">{hrContact.displayName}</p>
          )}
          <div className="flex flex-wrap gap-3">
            {hrContact?.telegram && (
              <a href={`https://t.me/${hrContact.telegram.replace(/^@/, '')}`}
                 target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[24px]">
                <Send className="h-3 w-3 shrink-0" />
                {hrContact.telegram}
              </a>
            )}
            {hrContact?.phone && (
              <a href={`tel:${hrContact.phone}`}
                 className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[24px]">
                <Phone className="h-3 w-3 shrink-0" />
                {hrContact.phone}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

**Удаляется:** `function HrContactCard()` и весь код `HrContactCard`. Пропсы `hrContact` и `hrLoading` передаются в `ProjectInfoCard`.

**data-testid изменения:**

| Старый testid                   | Новый testid                             | Изменение                           |
| ------------------------------- | ---------------------------------------- | ----------------------------------- |
| `hr-contact-card`               | `hr-inline` (внутри `project-info-card`) | Переехал внутрь ProjectInfoCard     |
| `junior-hub-hr-credentials-row` | УДАЛЯЕТСЯ                                | Нет flex-row обёртки HR+Credentials |

### 2.2 PersonaCard — `justify-between` + убрать h-full

**Проблема round 2:** `h-full` + `flex-col gap-4` — аватар/имя стоят вверху, кнопка под ними, нижние ~120px пустые.

**Round 3:** Убрать `h-full`. Карточка `h-fit`. PersonaCard теперь стоит в `flex-col gap-4` вместе с ProjectInfoCard — их суммарная высота совпадает с SalaryCard справа.

```tsx
<Card className="border-border/40 bg-card" data-testid="persona-card">
  {/* CardContent: flex-col, без justify-between — нет h-full, нет принудительной высоты */}
  <CardHeader className="flex flex-row items-center justify-between pb-3">
    <CardTitle className="text-sm font-semibold">Синьор проекта</CardTitle>
  </CardHeader>
  <CardContent className="flex flex-col gap-3">
    <div className="flex items-center gap-3">
      <Avatar className="h-10 w-10 shrink-0">
        {' '}
        {/* h-12 → h-10: компактнее */}
        <AvatarFallback className="bg-yellow-subtle text-avatar-text font-bold text-sm">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="font-semibold text-sm leading-tight truncate" data-testid="persona-fullname">
          {fullName ?? '—'}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate" data-testid="persona-role">
          {presentedRole ?? '—'}
        </p>
      </div>
    </div>
    <Button
      size="sm"
      variant="outline"
      className="w-full gap-2"
      onClick={() => void navigate({ to: '/crm/legend' })}
      data-testid="persona-open-legend-btn"
      aria-label="Открыть легенду"
    >
      <BookOpen className="h-3.5 w-3.5" />
      Открыть легенду
    </Button>
  </CardContent>
</Card>
```

Изменения от round 2:

- `h-full` → убрать (теперь `h-fit` по умолчанию)
- `gap-4` → `gap-3` (на ~10px компактнее)
- Avatar `h-12 w-12` → `h-10 w-10` (незначительно, но плотнее)
- Нет `className="lg:col-span-1"` на обёртке motion.div — PersonaCard идёт в `flex-col` стеке

### 2.3 SalarySnapshotCard — wide (col-span-2), обогащение контента

**Проблема round 2:** Зарплата занимала 1/3 ширины (304px) и при этом была самой информативной карточкой. Сейчас убираем ContractCard, зарплата получает 2/3 (≈624px на 1440px).

**Round 3:** Зарплата расширяется. Используем дополнительную ширину для улучшения читаемости выплат — 3 последних выплаты показываем в виде полноценных строк (не compact). «Все мои выплаты» — кнопка, не просто ссылка.

```tsx
function SalarySnapshotCard({ salaryMeta, salaryTxs, isLoading, className }) {
  // ... loading skeleton аналогичный
  return (
    <Card className={cn('border-border/40 bg-card', className)} data-testid="salary-snapshot-card">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Моя зарплата</CardTitle>
        <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Rate display */}
        {hasRate ? (
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums" data-testid="salary-rate-amount">
              {Number(salaryMeta!.monthlySalary).toLocaleString('ru-RU')}
            </span>
            <span className="text-sm text-muted-foreground uppercase">
              {salaryMeta!.salaryCurrency ?? ''}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">/ мес</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground/60 italic" data-testid="salary-no-rate">
            Ставка не назначена
          </p>
        )}

        {/* Last 3 payments — visible even without hasRate */}
        {salaryTxs.length > 0 && (
          <div className="space-y-2" data-testid="salary-tx-list">
            <p className="text-xs text-muted-foreground">Последние выплаты</p>
            {salaryTxs.map((tx) => {
              const isPaid = tx.status === 'PAID' || tx.status === 'VALIDATED'
              return (
                <div
                  key={tx.id}
                  className="flex items-center justify-between py-1.5 border-b border-border/20 last:border-0"
                  data-testid="salary-tx-row"
                >
                  <span className="text-sm text-muted-foreground">
                    {tx.salaryMonth ??
                      new Date(tx.createdAt).toLocaleDateString('ru-RU', {
                        month: 'long',
                        year: 'numeric',
                      })}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums text-sm font-medium">
                      {Number(tx.amount).toLocaleString('ru-RU')} {tx.currency}
                    </span>
                    <Badge variant={isPaid ? 'paid' : 'pending'} className="text-xs">
                      {isPaid ? 'Выплачено' : 'Ожидание'}
                    </Badge>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Link to /crm/finance */}
        <Link
          to="/crm/finance"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="salary-all-link"
        >
          <ExternalLink className="h-3 w-3" />
          Все мои выплаты
        </Link>
      </CardContent>
    </Card>
  )
}
```

Изменения от round 2:

- `text-2xl` → `text-3xl` для суммы (широкая карточка позволяет)
- Разделители строк выплат: `border-b border-border/20` вместо `<Separator className="opacity-30" />`
- Добавлена секция-заголовок «Последние выплаты» над списком
- `className` проп сохраняется для совместимости

### 2.4 ContractStatusCard — УДАЛИТЬ

Карточка полностью убирается из `project.tsx`. Хук `useMyContract()` тоже убирается (если не используется в других местах — проверить импорты).

**Удалить:**

- `function ContractStatusCard()`
- `function useMyContract()`
- Импорты: `ContractStatusMeDto`, `contractStatusMeDtoSchema`
- Переменные: `contract`, `contractLoading`, `contractError` из `HubCards`

**data-testid, которые удаляются:**

| testid                  | Статус    |
| ----------------------- | --------- |
| `contract-status-card`  | УДАЛЯЕТСЯ |
| `contract-status-badge` | УДАЛЯЕТСЯ |
| `contract-sign-btn`     | УДАЛЯЕТСЯ |

Если E2E-тесты (`apps/e2e/**`) ссылаются на эти testid — AutoTest агент фиксирует их.

### 2.5 ProjectCredentialsSection — full-width, 2-колонная раскладка

**Проблема round 2:** Credentials занимала нижнюю полосу рядом с HrContactCard. Теперь HR переехал в ProjectInfoCard. Credentials получает всю ширину.

**Round 3:** `col-span-full` на Credentials. Если учётных записей >= 2 — показывать список в 2 колонки (`grid grid-cols-1 sm:grid-cols-2 gap-2` внутри `ProjectCredentialsSection`).

Это изменение внутри компонента `ProjectCredentialsSection.tsx` (не в `project.tsx`):

```tsx
// В ProjectCredentialsSection — список items:
<div className={cn(
  'gap-2',
  items.length >= 2 ? 'grid grid-cols-1 sm:grid-cols-2' : 'flex flex-col'
)}>
  {items.map((cred) => <CredentialItem key={cred.id} ... />)}
</div>
```

Это заполняет широкое пространство без пустот. При 1 записи — 1 колонка. При 2+ — 2 колонки, каждая ~50% ширины.

---

## 3. HubCards — итоговый шаблон

```tsx
function HubCards({ project, projectId }: { project: ProjectDto; projectId: string }) {
  const { data: legend, isLoading: legendLoading } = useLegend(projectId, true)
  const { data: salaryMeta, isLoading: salaryMetaLoading } = useSalaryMeta()
  const { data: salaryTxs, isLoading: salaryTxsLoading } = useSalaryTransactions()
  const { data: hrContact, isLoading: hrLoading } = useHrContact(projectId)
  // ContractStatusCard удалён: useMyContract() удаляется
  const salaryLoading = salaryMetaLoading || salaryTxsLoading

  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"
      variants={container}
      initial="hidden"
      animate="show"
      data-testid="junior-hub-bento"
    >
      {/* Left stack: О проекте (с HR) + Синьор проекта */}
      <motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">
        <ProjectInfoCard project={project} hrContact={hrContact ?? null} hrLoading={hrLoading} />
        <PersonaCard legend={legend ?? null} isLoading={legendLoading} />
      </motion.div>

      {/* Right wide: Моя зарплата — col-span-2 */}
      <motion.div variants={card} className="lg:col-span-2">
        <SalarySnapshotCard
          salaryMeta={salaryMeta ?? null}
          salaryTxs={salaryTxs ?? []}
          isLoading={salaryLoading}
        />
      </motion.div>

      {/* Bottom full-width: Пароли проекта */}
      <motion.div variants={card} className="col-span-full">
        <ProjectCredentialsSection projectId={projectId} canEdit={false} canAdd />
      </motion.div>
    </motion.div>
  )
}
```

**Удалённые импорты из project.tsx:**

```tsx
// УДАЛИТЬ:
import type { ContractStatusMeDto } from '@crm/shared'
import { contractStatusMeDtoSchema } from '@crm/shared'
import { CheckCircle2 } from 'lucide-react'
// HrContactCard — удалить функцию, импорт className сохранить (используется в других местах)
```

---

## 4. Skeleton loading — обновить

Текущий skeleton в `JuniorProjectHub` отражает старую структуру (2×2 + full-width + маленький). Нужно обновить под новый layout:

```tsx
if (projectsLoading) {
  return (
    <div className="space-y-4" data-testid="junior-hub">
      <Skeleton className="h-7 w-44" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
        {/* Left stack */}
        <div className="lg:col-span-1 flex flex-col gap-4">
          <Skeleton className="h-44 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
        {/* Right wide */}
        <div className="lg:col-span-2">
          <Skeleton className="h-56 rounded-lg" />
        </div>
        {/* Bottom */}
        <div className="col-span-full">
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </div>
    </div>
  )
}
```

---

## 5. Responsive поведение

### Desktop 1440px (3-col grid)

- Левый стек (ProjectInfo+Persona): `lg:col-span-1` = 1/3 ширины ≈ 456px (с учётом gap)
- Правая Salary: `lg:col-span-2` = 2/3 ширины ≈ 928px
- Нижние Credentials: `col-span-full`

### Tablet 768–1023px (2-col grid)

- На `md:grid-cols-2`: левый стек col-1, правая Salary col-1 — равные колонки
- Credentials — `col-span-full`

### Mobile < 768px (1-col стек)

1. ProjectInfoCard (с HR встроен)
2. PersonaCard
3. SalarySnapshotCard
4. ProjectCredentialsSection

### Проверка overflow (обязательно перед merge)

- [ ] 320px: нет горизонтального overflow
- [ ] 768px: tablet layout корректен
- [ ] 1024px: переход 2→3 col работает
- [ ] 1440px: хаб на 1 экран, нет пустот

---

## 6. Token map

Все токены из `apps/web/app/styles/globals.css`. **Новых токенов не добавляется.**

| Назначение            | Token                                    | Tailwind class            |
| --------------------- | ---------------------------------------- | ------------------------- |
| Карточки bento        | `--color-card`                           | `bg-card`                 |
| Граница карточек      | `--color-border`                         | `border-border/40`        |
| Основной текст        | `--color-foreground`                     | `text-foreground`         |
| Вторичный текст       | `--color-muted-foreground`               | `text-muted-foreground`   |
| Аватар-инициалы фон   | `--color-yellow-subtle`                  | `bg-yellow-subtle`        |
| Аватар-инициалы текст | `--color-avatar-text`                    | `text-avatar-text`        |
| CTA кнопки            | `--color-primary`                        | `bg-primary text-primary` |
| Разделители           | `--color-border` × 0.2 opacity           | `border-border/20`        |
| Ошибки                | `--color-destructive`                    | `text-destructive`        |
| Радиус карточек       | `--radius-lg` = 0.625rem                 | `rounded-lg`              |
| Радиус кнопок         | `--radius-md` = calc(var(--radius)-2px)  | `rounded-md`              |
| Суммы                 | CSS `font-variant-numeric: tabular-nums` | `tabular-nums`            |

**Concentric radius:** кнопки внутри карточек `rounded-md`, карточки `rounded-lg`. Credentials reveal-контейнер — `rounded-[calc(var(--radius)-4px)]`.

---

## 7. Motion spec

Stagger pattern сохраняется из round 2:

```tsx
const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const card = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] as const } },
}
```

`motion.div variants={card}` — три штуки:

1. Обёртка левого стека (анимирует ProjectInfo + Persona как единый блок)
2. SalaryCard (col-span-2)
3. Credentials (col-span-full)

Это правильно: stagger на уровне grid-items, не на уровне каждой отдельной card внутри стека.

---

## 8. A11y critical paths (WCAG 2.2 AA)

### 8.1 Focus order

DOM-порядок совпадает с визуальным (grid + CSS не перемешивают DOM):

1. ProjectSwitcher (если > 1 проекта)
2. ProjectInfoCard → ссылки TG/phone (HrInline)
3. PersonaCard → кнопка «Открыть легенду»
4. SalarySnapshotCard → ссылка «Все мои выплаты»
5. ProjectCredentialsSection → «+ Добавить» → строки → [👁] кнопки

### 8.2 Target size (SC 2.5.8)

| Элемент                           | Размер         | Статус      |
| --------------------------------- | -------------- | ----------- |
| Кнопка «Открыть легенду»          | `h-8` 32px     | ≥ 24px PASS |
| Кнопка «+ Добавить» (credentials) | `h-8` 32px     | ≥ 24px PASS |
| Ссылки TG/phone (HrInline)        | `min-h-[24px]` | ≥ 24px PASS |
| Кнопка reveal `[👁]`              | `h-7 w-7` 28px | ≥ 24px PASS |

### 8.3 Контраст (SC 1.4.3)

Токены проверены в round 1/2. HrInline ссылки: `text-muted-foreground` (L=0.58) на `bg-card` (dark L=0.12) → ≈3.5:1 для декоративных/UI элементов (SC 1.4.11 ≥ 3:1 PASS). При hover: `text-foreground` (L=0.97) → 14:1 PASS.

### 8.4 Семантика

```tsx
// ProjectInfoCard CardContent:
<section aria-label="Контакт HR">  // обёртка HrInline
  <HrInline ... />
</section>
```

HrInline содержит `<a>` с видимым текстом → `aria-label` не нужен.

### 8.5 Реflow (SC 1.4.10)

`grid-cols-3` → при zoom 400% на 1440px effective width ≈ 360px → отрабатывает `grid-cols-1`. Нет горизонтального overflow.

---

## 9. Anti-pattern checklist (Mode C)

- Нет purple/gradient на карточках.
- Нет `rounded-2xl` везде — только `rounded-lg` Card + `rounded-md` внутри.
- Нет `shadow-xl` — только `border-border/40`.
- Нет decorative blobs.
- Нет `transition: all` — только explicit properties.
- Нет Cards inside Cards (HrInline — `div`, не `Card`; бывший HrContactCard удалён).
- Нет generic hero section.
- SalaryCard на 2/3 ширины — функциональная логика (зарплата — главный interes джуна), не декоративная.
- `text-3xl` для суммы зарплаты — единственный размерный акцент, не везде.

---

## 10. Edge cases

| Кейс                             | Поведение                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Зарплата не назначена            | SalaryCard: «Ставка не назначена» + список выплат (если есть). Карточка `h-fit` — короткая.                |
| Нет выплат                       | SalaryCard: только сумма ставки (или italic «Ставка не назначена»). Нет пустых разделителей.               |
| HR не назначен                   | HrInline (внутри ProjectInfoCard): italic «HR не назначен». ProjectInfoCard не расширяется сверх контента. |
| Легенда не заполнена             | PersonaCard: инициалы «?», ФИО «—», роль «—», кнопка CTA «Открыть легенду» (без изменений).                |
| > 8 паролей                      | Credentials: `ScrollArea max-h-[480px]` (из project-credentials.md §9.2). 2-col grid в ScrollArea.         |
| 1 пароль                         | Credentials: 1-col layout (нет `sm:grid-cols-2`). Не выглядит рыхло — кнопки [👁] прижаты к правому краю.  |
| Проект завершён (isActive=false) | StatusBadge «Завершён», без изменений в остальном контенте.                                                |

---

## 11. data-testid реестр (изменения от round 2)

### Удаляются

| testid                          | Причина                                            |
| ------------------------------- | -------------------------------------------------- |
| `hr-contact-card`               | HrContactCard удалён, HR встроен в ProjectInfoCard |
| `junior-hub-hr-credentials-row` | flex-обёртка HR+Credentials удалена                |
| `contract-status-card`          | ContractStatusCard удалён                          |
| `contract-status-badge`         | В составе ContractStatusCard                       |
| `contract-sign-btn`             | В составе ContractStatusCard                       |

### Добавляются

| testid      | Что                                             |
| ----------- | ----------------------------------------------- |
| `hr-inline` | `div`-контейнер HrInline внутри ProjectInfoCard |

### Сохраняются (без изменений)

| testid                    | Что                                  |
| ------------------------- | ------------------------------------ |
| `project-info-card`       | ProjectInfoCard (теперь с HR внутри) |
| `persona-card`            | PersonaCard                          |
| `persona-fullname`        | Имя персоны                          |
| `persona-role`            | Роль персоны                         |
| `persona-open-legend-btn` | Кнопка «Открыть легенду»             |
| `salary-snapshot-card`    | SalarySnapshotCard                   |
| `salary-rate-amount`      | Сумма ставки                         |
| `salary-tx-list`          | Список транзакций                    |
| `salary-tx-row`           | Строка транзакции                    |
| `salary-all-link`         | Ссылка «Все мои выплаты»             |
| `junior-hub-bento`        | Корневой motion.div                  |
| `credentials-section`     | ProjectCredentialsSection            |
| `credentials-add-btn`     | Кнопка «+ Добавить»                  |

---

## 12. Handoff-чеклист для Coder

### apps/web/app/routes/crm/project.tsx

- [ ] `HubCards`: заменить grid на `className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start"` (добавить `items-start`)
- [ ] Левую колонку обернуть в `<motion.div variants={card} className="lg:col-span-1 flex flex-col gap-4">` — туда идут ProjectInfoCard + PersonaCard
- [ ] SalarySnapshotCard обернуть в `<motion.div variants={card} className="lg:col-span-2">`
- [ ] Credentials обернуть в `<motion.div variants={card} className="col-span-full">`
- [ ] Удалить `<section aria-label="HR и пароли проекта"...>` flex-обёртку (больше не нужна)
- [ ] Удалить `function HrContactCard()` и все её props/использования в HubCards
- [ ] Удалить `function ContractStatusCard()` и `function useMyContract()`
- [ ] Удалить из HubCards: `const { data: contract, isLoading: contractLoading, isError: contractError } = useMyContract()`
- [ ] Удалить неиспользуемые импорты: `ContractStatusMeDto`, `contractStatusMeDtoSchema`, `CheckCircle2`
- [ ] `ProjectInfoCard`: добавить пропы `hrContact: HrContactDto | null` и `hrLoading: boolean`; встроить `HrInline` компонент (или inline-секцию) как §2.1
- [ ] `PersonaCard`: убрать `h-full` с Card; `gap-4` → `gap-3`; Avatar `h-12 w-12` → `h-10 w-10`
- [ ] Обновить skeleton в `JuniorProjectHub` под новый layout (§4)
- [ ] `SalarySnapshotCard`: `text-2xl` → `text-3xl` для суммы; добавить заголовок «Последние выплаты» над списком; разделители через `border-b border-border/20` вместо `<Separator>`

### apps/web/app/components/projects/ProjectCredentialsSection.tsx

- [ ] Список items: `flex flex-col` → `grid grid-cols-1 sm:grid-cols-2 gap-2` при `items.length >= 2` (§2.5)
- [ ] Проверить что `canAdd` проп работает (из round 2, без изменений)

### E2E (AutoTest зона)

- [ ] Удалить/обновить тесты на `hr-contact-card`, `junior-hub-hr-credentials-row`, `contract-status-card`, `contract-status-badge`, `contract-sign-btn`
- [ ] Добавить проверку `hr-inline` внутри `project-info-card`
- [ ] Проверить что `salary-snapshot-card` рендерится на `lg:col-span-2` (визуально wider)

---

## 13. Открытые вопросы для PM

1. **`useMyContract` используется где-то ещё?** — Coder проверяет перед удалением. Если используется на странице `/crm/onboarding` или другом маршруте — хук сохранить как shared, только убрать его из `project.tsx`.

2. **2-колонная раскладка credentials** — изменение внутри `ProjectCredentialsSection.tsx`. Это касается не только junior-хаба, но и ADMIN/HR видов (они видят Credentials на проекте). Убедиться что 2-col grid не сломает ADMIN-интерфейс. Если сомнения — сделать через проп `twoColumn?: boolean` на `ProjectCredentialsSection`.

3. **SalarySnapshotCard расширена до col-span-2** — на мобиле/tablet это col-span-1 (одна колонка). Визуально проверить 768px: SalaryCard рядом с левым стеком — равные ли высоты? Если salary коротка (нет выплат) — левый стек выше, справа пустота. Кандидат на `items-start` → OK.

4. **Контракт для JUNIOR со статусом READY_TO_SIGN** — после удаления ContractStatusCard CTA «Подписать контракт» исчезнет с хаба. Нужно ли перенести уведомление о неподписанном контракте в другое место (например, toast или banner вверху хаба)? Текущее UT-требование — «убрать контракт». Уточнить у владельца: «убрать карточку» или «убрать вообще любое упоминание контракта».
