# Design spec: Admin impersonation («Войти как»)

**Slug:** `admin-impersonation`
**Tier:** 1 utilitarian (no Claude Design generation — utilitarian/internal tool, follows existing design-system patterns)
**Status:** coder-ready spec

---

## Brief

Инструмент для ADMIN: войти в CRM от лица другого сотрудника. Используется для поддержки и отладки.

Два компонента:

1. **Таба «Войти как»** на странице `/admin` (рядом с «Контракты», «Terms of Service», «Компания»)
2. **Глобальный баннер** — видимый на ВСЕХ страницах когда ADMIN действует как другой пользователь

---

## Token map (из globals.css)

- Фон баннера: `amber-500/10` (`bg-amber-500/10`)
- Граница баннера: `amber-500/30` (`border-amber-500/30`)
- Текст баннера: `amber-600 dark:amber-400`
- Кнопка «Вернуться»: `variant="outline"` (shadcn/ui Button)
- Список пользователей: `bg-card border border-border/60 rounded-xl` (карточки как на /users)
- Бейджи ролей: `<Badge variant={role.toLowerCase()}>` (существующая система)
- Hover строки: `hover:bg-muted/40 transition-colors`
- Кнопка «Войти как» на строке: `variant="outline" size="sm"`

---

## Компоненты

### Используемые (существующие shadcn/ui + проект)

- `Button` (variant: outline, size: sm / default)
- `Badge` (variant: роль в lowercase)
- `AlertDialog` / Dialog для confirm (вместо window.confirm — браузерный диалог не брендирован)
- `Skeleton` (loading state)
- `AnimatedTabs` (для добавления табы в admin/route.tsx)
- `UserAvatar` (аватарки в списке)
- `PageHeader` + `StickyPageHeader` (шапка страницы)

### Новые

- `ImpersonationBanner` — компонент баннера (в `apps/web/app/components/layout/`)
- `LoginAsPage` — роут-компонент (`apps/web/app/routes/_authenticated/admin/login-as.tsx`)

---

## Layout

### Таба в /admin

Добавить в `ADMIN_TABS` в `admin/route.tsx`:

```
{ value: 'login-as', label: 'Войти как', ariaLabel: 'Войти как' }
```

### Страница /admin/login-as

```
PageHeader
  "Войти как"  ← title (h2, text-lg font-semibold)
  "Войдите от лица сотрудника для поддержки"  ← description (text-sm text-muted-foreground)

Search input  ← фильтр по имени/email (placeholder: "Поиск...")

Список пользователей (grid-cols-1, gap-2):
  [Строка]
    UserAvatar (32px)
    displayName (font-medium)
    email (text-sm text-muted-foreground)
    Badge(role)
    Button("Войти как")  → confirm dialog → mutation
```

### Баннер ImpersonationBanner

```
sticky top-0 z-50 (ИЛИ z-49 если ниже header)
bg-amber-500/10 border-b border-amber-500/30

Desktop (≥640):
  [!] Вы вошли как «{displayName}» ({role})  ·  [Вернуться в свой профиль]

Mobile (<640):
  [!] Вы вошли как «{displayName}»
  [Вернуться]  ← full-width кнопка (min-h-[44px])
```

---

## Motion

- Баннер: `motion.div` fadeIn (opacity 0→1, duration 200ms) при маунте
- Confirm dialog: встроенный Radix анимация (shadcn/ui AlertDialog)

---

## A11y (WCAG 2.2)

- Баннер: `role="alert"` (screen reader announcement при появлении)
- Кнопка «Вернуться»: `aria-label="Вернуться в свой профиль"` (явный label)
- Кнопка «Войти как» на строке: `aria-label="Войти как {displayName}"`
- Тач-таргеты мобайл: `min-h-[44px]` для всех интерактивных элементов
- Confirm dialog: focus trap автоматически через Radix AlertDialog

---

## Responsive (4 класса)

| Класс          | Поведение                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Mobile 320–375 | Список одноколоночный; баннер текст переносится; кнопка «Вернуться» full-width; тач-таргет ≥44px |
| Tablet 768     | Список одноколоночный; баннер в одну строку                                                      |
| Laptop 1024    | Список с Badge и кнопкой справа в одну строку                                                    |
| Large 1440     | max-w-2xl для контента, остальное как laptop                                                     |

---

## Edge cases

- **Empty state:** «Нет сотрудников» с иконкой (нет non-ADMIN пользователей)
- **Loading:** Skeleton строки
- **Error mutation:** toast.error('Не удалось войти как...')
- **Onboarding flow:** баннер остаётся доступен ДАЖЕ на `/onboarding` (не скрывать за гейтом)
- **Фильтрация:** фронт фильтрует `role === 'ADMIN'` и `id === currentUser.id` из списка
