# Design spec: Admin impersonation («Войти как»)

**Slug:** `admin-impersonation`
**Tier:** 1 utilitarian (no Claude Design generation — utilitarian/internal tool, follows existing design-system patterns)
**Status:** coder-ready spec

---

## Brief

A tool for ADMIN: log in to the CRM as another employee. Used for support and debugging.

Two components:

1. **«Войти как» tab** on the `/admin` page (next to «Контракты», «Terms of Service», «Компания»)
2. **Global banner** — visible on ALL pages while the ADMIN is acting as another user

---

## Token map (from globals.css)

- Banner background: `amber-500/10` (`bg-amber-500/10`)
- Banner border: `amber-500/30` (`border-amber-500/30`)
- Banner text: `amber-600 dark:amber-400`
- «Вернуться» button: `variant="outline"` (shadcn/ui Button)
- User list: `bg-card border border-border/60 rounded-xl` (cards as on /users)
- Role badges: `<Badge variant={role.toLowerCase()}>` (existing system)
- Row hover: `hover:bg-muted/40 transition-colors`
- «Войти как» button on a row: `variant="outline" size="sm"`

---

## Components

### Used (existing shadcn/ui + project)

- `Button` (variant: outline, size: sm / default)
- `Badge` (variant: role in lowercase)
- `AlertDialog` / Dialog for confirm (instead of window.confirm — the browser dialog is not branded)
- `Skeleton` (loading state)
- `AnimatedTabs` (to add the tab in admin/route.tsx)
- `UserAvatar` (avatars in the list)
- `PageHeader` + `StickyPageHeader` (page header)

### New

- `ImpersonationBanner` — banner component (in `apps/web/app/components/layout/`)
- `LoginAsPage` — route component (`apps/web/app/routes/_authenticated/admin/login-as.tsx`)

---

## Layout

### Tab in /admin

Add to `ADMIN_TABS` in `admin/route.tsx`:

```
{ value: 'login-as', label: 'Войти как', ariaLabel: 'Войти как' }
```

### Page /admin/login-as

```
PageHeader
  "Войти как"  ← title (h2, text-lg font-semibold)
  "Войдите от лица сотрудника для поддержки"  ← description (text-sm text-muted-foreground)

Search input  ← filter by name/email (placeholder: "Поиск...")

User list (grid-cols-1, gap-2):
  [Row]
    UserAvatar (32px)
    displayName (font-medium)
    email (text-sm text-muted-foreground)
    Badge(role)
    Button("Войти как")  → confirm dialog → mutation
```

### ImpersonationBanner

```
sticky top-0 z-50 (OR z-49 if below the header)
bg-amber-500/10 border-b border-amber-500/30

Desktop (≥640):
  [!] Вы вошли как «{displayName}» ({role})  ·  [Вернуться в свой профиль]

Mobile (<640):
  [!] Вы вошли как «{displayName}»
  [Вернуться]  ← full-width button (min-h-[44px])
```

---

## Motion

- Banner: `motion.div` fadeIn (opacity 0→1, duration 200ms) on mount
- Confirm dialog: built-in Radix animation (shadcn/ui AlertDialog)

---

## A11y (WCAG 2.2)

- Banner: `role="alert"` (screen reader announcement on appearance)
- «Вернуться» button: `aria-label="Вернуться в свой профиль"` (explicit label)
- «Войти как» button on a row: `aria-label="Войти как {displayName}"`
- Mobile touch targets: `min-h-[44px]` for all interactive elements
- Confirm dialog: focus trap is automatic via Radix AlertDialog

---

## Responsive (4 classes)

| Class          | Behavior                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------- |
| Mobile 320–375 | Single-column list; banner text wraps; «Вернуться» button is full-width; touch target ≥44px |
| Tablet 768     | Single-column list; banner on one line                                                      |
| Laptop 1024    | List with Badge and button on the right, on one line                                        |
| Large 1440     | max-w-2xl for content, the rest as laptop                                                   |

---

## Edge cases

- **Empty state:** «Нет сотрудников» with an icon (no non-ADMIN users)
- **Loading:** Skeleton rows
- **Error mutation:** toast.error('Не удалось войти как...')
- **Onboarding flow:** the banner stays available EVEN on `/onboarding` (do not hide it behind the gate)
- **Filtering:** the frontend filters `role === 'ADMIN'` and `id === currentUser.id` out of the list
