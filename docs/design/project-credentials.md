# Design Spec: Project passwords (ProjectCredentialsSection)

**Slug:** `project-credentials`
**Status:** Ready for implementation
**Date:** 2026-06-12
**Author:** ui-ux-designer (Mode A)
**Task source:** `.claude/tasks/task-project-credentials.md`

---

## 1. Design Direction

### Purpose

The interface lets users manage the passwords of a project's work accounts (GitHub, Jira, Slack, the client CRM…).

- **JUNIOR** — an active project participant — views the list, reveals the password of the needed service, copies it to the clipboard to sign in. Workflow — open the hub, find the row, one click on the eye, copy.
- **ADMIN/HR** — adds, edits, deletes entries when onboarding a junior or rotating passwords.

Critical constraint: passwords are **sensitive data**. The list contains no plaintext, not even in the form of a `*` mask from the DOM. Reveal is a separate request, plaintext in the UI only while the user is explicitly looking (max 30s).

### Audience

| User   | Frequency      | Main scenario                            |
| ------ | -------------- | ---------------------------------------- |
| JUNIOR | daily          | Copy the password of the needed resource |
| ADMIN  | 1-2 times/week | Add/update an account during onboarding  |
| HR     | 1-2 times/week | Add/update on password rotation          |

### Tone

**Dense / quiet / secure.** An operational SaaS tool with an emphasis on security.

- No visual «noise» — the section blends into the existing hub style (`border-border/40 bg-card`), does not stand out by color.
- Passwords are sensitive data: the UI conveys this through restraint, not brightness.
- The reveal state is the only «special» visual zone: a monospace «safe» background.

### Memorable detail

A revealed password is displayed in **`font-mono tabular-nums tracking-wider`** on a `bg-muted/40` background (a visual «safe» — an inverse box relative to the row). Auto-hide after 30s is accompanied by a thin **CSS progress-bar animation** under the password — a visual timer without a JS interval (`animation: shrink 30s linear`). The user sees a «window» that is closing.

### Constraints

- Tailwind v4 + shadcn/ui (existing components)
- Russian UI (all user-facing texts)
- WCAG 2.2 Level AA
- Responsive: 320px — 1440px
- Existing design tokens from `apps/web/app/styles/globals.css` (no new tokens)
- Pattern: `ProjectLegendSection.tsx` (Card + CardHeader + CardContent, border-border/40)

---

## 2. Component states

### 2.1. Empty (no entries)

```
┌─ Card border-border/40 ──────────────────────────┐
│  [Key icon 3.5px] ПАРОЛИ ПРОЕКТА     [+ Добавить]│
│                                                    │
│  Нет сохранённых паролей             (italic muted)│
└────────────────────────────────────────────────────┘
```

- The «+ Добавить» button only for ADMIN/HR (prop `canEdit`). JUNIOR sees the empty message without the button.
- Icon: `KeyRound` (lucide-react).
- Text: `text-sm text-muted-foreground/60 italic`.

### 2.2. List (passwords loaded)

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

**Entry row:**

- `label` — `text-sm font-medium` (GitHub, Jira…)
- `login` — `text-xs text-muted-foreground` (if filled)
- `url` — `text-xs text-muted-foreground` as a link `<a target="_blank" rel="noopener noreferrer">` with an `ExternalLink h-3 w-3` icon (if filled)
- Mask: the string `••••••••` (`text-sm text-muted-foreground/50 tracking-widest font-mono`) — static text, NOT an input
- Buttons: [👁 reveal] [✏ edit] [🗑 delete] — icon-only, ghost, h-7 w-7

**Separator:** `<Separator className="my-1" />` between rows (only for ≥2 entries).

**RBAC button visibility:**

- JUNIOR: only `[👁]` (no edit/delete)
- ADMIN, HR: `[👁] [✏] [🗑]`

### 2.3. Reveal (plaintext visible)

```
┌─ credential row ───────────────────────────────────────────────┐
│  [G] GitHub                                                     │
│       login: john.doe@company.com  · github.com  [👁▪] [📋] [✏] [🗑]│
│       ┌─── bg-muted/40 rounded-md px-3 py-1.5 ──────────────┐  │
│       │  p4ssw0rd!2024$             font-mono tracking-wider  │  │
│       │  ░░░░░░░░░░░░░░░░░░░░░░░ progress (30s shrink)       │  │
│       └────────────────────────────────────────────────────── ┘  │
└─────────────────────────────────────────────────────────────── ┘
```

**Reveal zone details:**

- Container: `bg-muted/40 rounded-[calc(var(--radius)-4px)] px-3 py-2` (concentric radius: Card radius - padding = 6px)
- Password: `font-mono text-sm font-medium tabular-nums tracking-[0.12em] text-foreground select-text`
- Progress-bar: `h-0.5 w-full bg-primary/30 rounded-full overflow-hidden`
  - Inner bar: `h-full bg-primary/60 animate-[shrink_30s_linear_forwards]`
  - Keyframe: `@keyframes shrink { from { width: 100% } to { width: 0% } }`
  - After 30s: auto-hide (via the `onAnimationEnd` callback)
- The eye button in the reveal state: `aria-pressed="true"` + `aria-label="Скрыть пароль"` + `data-testid="credentials-hide-btn-{id}"`
- The «Копировать» (clipboard) button: appears only when the password is shown. `aria-label="Копировать пароль"`. After a successful copy — the `Check` icon instead of `Copy` for 2s (CSS transition opacity).

### 2.4. Loading (list is loading)

Two Skeleton blocks:

```tsx
<Skeleton className="h-12 w-full rounded-md" />
<Skeleton className="h-12 w-full rounded-md" />
```

### 2.5. Error (reveal returned 403/throttle)

An inline error under the row, `text-xs text-destructive`. Texts:

- 403: `«Нет доступа к этому паролю»`
- 429: `«Слишком много запросов. Попробуйте через минуту.»`
- Network error: `«Не удалось получить пароль. Попробуйте ещё раз.»`

The error disappears on the next reveal attempt (no explicit dismiss needed).

---

## 3. Component List

### From shadcn/ui (apps/web/app/components/ui/)

| Component                                                                                                                                                             | Where used                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `Card`, `CardContent`, `CardHeader`, `CardTitle`                                                                                                                      | The whole section (ProjectLegendSection pattern) |
| `Button` (variant="ghost", size="sm")                                                                                                                                 | All action buttons (reveal, copy, edit, delete)  |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter`                                                                                              | Adding / editing an entry                        |
| `AlertDialog`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogAction`, `AlertDialogCancel` | Delete confirm                                   |
| `Input`                                                                                                                                                               | The label, login, password, url fields           |
| `Label`                                                                                                                                                               | Form field captions                              |
| `Textarea`                                                                                                                                                            | The notes field                                  |
| `Separator`                                                                                                                                                           | Separator between rows                           |
| `Skeleton`                                                                                                                                                            | Loading state                                    |
| `Tooltip` (TooltipProvider, TooltipContent, TooltipTrigger)                                                                                                           | Hints for icon-only buttons                      |

### Lucide-react icons

| Icon            | Where                              |
| --------------- | ---------------------------------- |
| `KeyRound`      | Section header                     |
| `Eye`, `EyeOff` | Reveal / hide toggle               |
| `Copy`, `Check` | Clipboard button (swap on success) |
| `Pencil`        | Edit button                        |
| `Trash2`        | Delete button                      |
| `Plus`          | Add an entry                       |
| `ExternalLink`  | URL link                           |
| `Loader2`       | Pending state in buttons           |

### New files (Coder creates)

```
apps/web/app/components/projects/ProjectCredentialsSection.tsx
apps/web/app/hooks/use-credentials.ts
```

Models: `ProjectLegendSection.tsx` + `use-legend.ts` respectively.

---

## 4. Token Map

All tokens from `apps/web/app/styles/globals.css` (`@theme inline {}`). **No new tokens are added.**

| Token                                              | Usage                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `var(--border)` / `border-border/40`               | Card border (hub sections pattern)                                            |
| `var(--card)`                                      | Card background                                                               |
| `var(--muted-foreground)`                          | login, url, mask, caption text                                                |
| `var(--muted)` / `bg-muted/40`                     | Reveal container (secure zone)                                                |
| `var(--foreground)`                                | Revealed password (full opacity)                                              |
| `var(--primary)`                                   | Progress-bar fill (`bg-primary/60`), track (`bg-primary/30`)                  |
| `var(--destructive)`                               | Inline error messages                                                         |
| `var(--ring)`                                      | Focus indicator (via Tailwind `focus-visible:ring-2 focus-visible:ring-ring`) |
| `var(--radius)` → `calc(var(--radius) - 4px)`      | Reveal container (concentric radius)                                          |
| `--font-sans`                                      | All text (default)                                                            |
| `font-mono` (Tailwind utility → browser monospace) | Revealed password display                                                     |

**Concentric radius:** Card `--radius` = 0.625rem (10px). Card padding = 24px. The reveal container is nested inside CardContent → outer radius - 4px = 6px = `calc(var(--radius) - 4px)` = `rounded-[calc(var(--radius)-4px)]`.

---

## 5. Dialog: Adding / Editing an entry

### Form fields

| Field      | Type                                       | Required                             | Placeholder                    |
| ---------- | ------------------------------------------ | ------------------------------------ | ------------------------------ |
| Название\* | `Input`                                    | Required                             | `GitHub, Jira, Slack...`       |
| Логин      | `Input`                                    | Optional                             | `john.doe@company.com`         |
| Пароль\*   | `Input type="password"` + toggle show/hide | Required on create, Optional on edit | `Пароль аккаунта`              |
| URL        | `Input type="url"`                         | Optional                             | `https://github.com`           |
| Заметки    | `Textarea rows={3}`                        | Optional                             | `Дополнительная информация...` |

**Password field:** a native `<input type="password">` (the browser hides it by default) + an eye button for the toggle inside the field. On edit — the field is empty with `placeholder="Оставьте пустым чтобы не менять пароль"`. If the field is empty on PATCH — the password is not updated (the backend ignores an absent `password`).

### Dialog behavior

- Trigger: the «+ Добавить» button (empty state) or `[✏]` on an entry.
- `DialogTitle`: `"Добавить аккаунт"` / `"Редактировать аккаунт"`.
- Escape → close without saving. Focus restore to the trigger button.
- Submit → `<button type="submit">`. Enter in text fields → form submit. **Exception:** the notes textarea — Enter adds a new line, does not submit (native textarea behavior).
- Pending: the submit button `disabled + <Loader2 animate-spin />`.
- After a successful submit → the dialog closes, the list refreshes via `queryClient.invalidateQueries`.

### Form layout (Dialog)

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

## 6. Delete confirm

The `AlertDialog` component (shadcn/ui). Trigger: the `[🗑]` button.

```
AlertDialogTitle:       "Удалить аккаунт?"
AlertDialogDescription: "Запись «{label}» будет удалена безвозвратно."
AlertDialogCancel:      "Отмена"   (Escape → cancel)
AlertDialogAction:      "Удалить"  variant="destructive"
```

Focus trap: Radix AlertDialog provides it automatically. After closing — focus restore to the trigger.

---

## 7. Motion Spec

All animations are minimal, functional (not decorative).

### Reveal block (appearance)

```css
/* Framer Motion variants — pattern from project.tsx */
enter: { opacity: 0, height: 0 } → { opacity: 1, height: "auto", transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] } }
exit:  { opacity: 1, height: "auto" } → { opacity: 0, height: 0, transition: { duration: 0.15 } }
```

Use `<AnimatePresence>` + `motion.div` for the reveal container — enter/exit.

### Progress-bar (auto-hide timer)

```css
@keyframes shrink {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}

.credentials-timer-bar {
  animation: shrink 30s linear forwards;
}
```

`animation-play-state: running` while shown; on copy — **do not reset the timer** (the user already has it in the clipboard, 30s from reveal).

### Clipboard success (Check icon swap)

```css
transition-property: opacity, transform;
transition-duration: 150ms;
transition-timing-function: ease-out;
```

Copy → Check: `opacity 0 → 1, scale 0.8 → 1`. After 2s: Check → Copy back.

### Action buttons

```css
transition-property: background-color, opacity, color;
transition-duration: 150ms;
transition-timing-function: ease-out;
```

Never `transition: all`.

---

## 8. A11y Critical Paths (WCAG 2.2 AA)

### 8.1. Target size — SC 2.5.8 (min 24×24px)

All icon-only buttons have `className="h-7 w-7"` (28×28px) — exceeds the 24px minimum.
Padding expands the hit area without enlarging the icon: `p-1.5` inside h-7 w-7.

### 8.2. Focus indicator — SC 2.4.11

All interactive elements use the shadcn/ui pattern `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`. Custom elements (inline buttons) explicitly inherit through the Button component.

The `select-text` reveal container is not an interactive element, no focus ring is needed.

### 8.3. Color contrast — SC 1.4.3 / 1.4.11

| Element           | Color                          | Background          | Contrast                  |
| ----------------- | ------------------------------ | ------------------- | ------------------------- |
| Revealed password | `foreground` L=0.97            | `muted/40` ≈ L=0.18 | >7:1 ✓                    |
| Mask `••••••••`   | `muted-foreground/50` ≈ L=0.29 | `card` L=0.12       | ~3:1 (large UI element ✓) |
| Record label      | `foreground`                   | `card`              | >7:1 ✓                    |
| Login/URL         | `muted-foreground` L=0.58      | `card` L=0.12       | ~4.5:1 ✓                  |
| Error text        | `destructive`                  | `card`              | ≥4.5:1 ✓                  |

### 8.4. Icon-only buttons — SC 1.1.1

| Button | aria-label                                                 | aria-pressed     | data-testid                   |
| ------ | ---------------------------------------------------------- | ---------------- | ----------------------------- |
| Reveal | `"Показать пароль"` (hidden) / `"Скрыть пароль"` (visible) | `false` / `true` | `credentials-reveal-btn-{id}` |
| Copy   | `"Копировать пароль"` / `"Скопировано"` (after success)    | —                | `credentials-copy-btn-{id}`   |
| Edit   | `"Редактировать {label}"`                                  | —                | `credentials-edit-btn-{id}`   |
| Delete | `"Удалить {label}"`                                        | —                | `credentials-delete-btn-{id}` |
| Add    | — (the label "Добавить" is visible)                        | —                | `credentials-add-btn`         |

A Tooltip wraps every icon-only button: `<Tooltip><TooltipTrigger asChild>...<TooltipContent>{label}</TooltipContent></Tooltip>`.

### 8.5. Clipboard feedback — SC 4.1.3

The copy status is announced via `aria-live`:

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

Reset after 3s so that a repeated copy is announced again.

### 8.6. Revealed password — screen reader

The reveal block has NO `aria-live` — the user explicitly pressed the button and expects a change. The password enters the accessibility tree through a regular `<span>`, the screen reader reads it on focus/navigation. `aria-hidden="false"` explicitly (default).

Do NOT add `aria-label` to the password span itself (the screen reader would read out the plaintext — this is intentional on an explicit user action).

### 8.7. Dialog focus management

Radix Dialog automatically:

- Traps focus inside the open dialog
- Restores focus to the trigger element on close
- Escape → close

Check: the first `autoFocus` in the Dialog → the «Название» field (via the `autoFocus` prop on Input).

### 8.8. AlertDialog

`role="alertdialog"` (Radix AlertDialog) — automatic. Focus goes to the first button (Cancel) — a safe default for destructive actions (WCAG best practice).

### 8.9. Keyboard navigation flow (section)

```
Tab: [+ Добавить] → row 1: [👁] → [✏] → [🗑] → row 2: [👁] → [✏] → [🗑] → ...
```

DOM order matches visual order. The reveal block is inserted **after** the corresponding row in the DOM — when it appears, Tab moves inside it (password span + [📋 copy]).

---

## 9. Edge Cases

### 9.1. Long label / login

- `label`: `truncate` (a single line, ellipsis). The full text — in a Tooltip on hover/focus.
- `login`: `truncate max-w-[160px] sm:max-w-[240px]`. The full email — in the `title` attribute.
- `url`: `truncate max-w-[120px] sm:max-w-[180px]`. The full URL — in the href (visible on hover in the browser).

### 9.2. Many entries (>10)

No client-side pagination (the backend returns all project entries). The list is inside `<ScrollArea className="max-h-[480px]">` if the number of entries is > 8. The threshold of 8 is roughly 3 viewport-heights on a 320px mobile.

Guideline: a credential row ≈ 56px. 8 × 56 = 448px + header ≈ 480px max-height.

### 9.3. Reveal throttle (429)

Backend limit: 30 requests/min. On 429:

- Inline error under the row: `«Слишком много запросов. Попробуйте через минуту.»`
- Reveal button: `disabled` for 60s (countdown on the client). After 60s — re-enable without a page reload.
- `aria-disabled="true"` + `title="Доступно через {N}с"` on the button in the disabled state.

### 9.4. Parallel reveals (multiple open passwords)

Allowed: the user can open several passwords at the same time. Each reveal block has an independent timer (30s from its own reveal). No artificial «only 1 open» limit.

### 9.5. Auto-hide and clipboard race

If the user presses «Копировать» at the moment the timer has almost expired — the copy is performed (the plaintext is still in state). After `onAnimationEnd` the state is cleared. No race: React setState is synchronous in the event handler.

### 9.6. Empty url / login

If `login` is empty — the login line is not rendered (takes no space). If `url` is empty — the link is not rendered. Do not show empty lines with a dash.

### 9.7. Mobile (320px)

- The `[👁] [✏] [🗑]` buttons do not wrap to a new line: flex-row, button min-width 28px, `flex-shrink-0`.
- Label + buttons: flex layout with `flex-1 min-w-0` on the label block and `flex-shrink-0` on the buttons.
- Reveal container: `break-all` on the password (long characters without spaces).

### 9.8. Offline / network error on reveal

A network error (not 4xx): inline error `«Не удалось получить пароль. Попробуйте ещё раз.»` + the reveal button stays active (not disabled).

### 9.9. JUNIOR on someone else's project (403 on list)

If GET /credentials returned 403 → the section is not rendered (similar to the `useHrContact` pattern in project.tsx:137-143). Do not show an error state for JUNIOR — 403 means «no access», the section is hidden silently.

---

## 10. Integration into existing pages

### 10.1. Junior hub: `apps/web/app/routes/crm/project.tsx`

The section is added to `<HubCards>` as the last card before the quick links. The pattern of existing cards: `motion.div` with `card` variants + `col-span-full`.

```tsx
{/* Пароли проекта */}
<motion.div variants={card} className="col-span-full">
  <ProjectCredentialsSection
    projectId={projectId}
    canEdit={false}  {/* JUNIOR — только просмотр и reveal */}
  />
</motion.div>
```

JUNIOR is always `canEdit={false}` — the edit/delete buttons are hidden.

### 10.2. Project detail: `apps/web/app/routes/crm/projects/$projectId.tsx`

The section is added to the «Обзор» tab next to `ProjectLegendSection`. Pattern: grid `gap-4`, `col-span-full`.

```tsx
{
  /* Пароли — для ADMIN/HR */
}
{
  canViewCredentials && (
    <ProjectCredentialsSection projectId={projectId} canEdit={canEditCredentials} />
  )
}
```

`canViewCredentials` and `canEditCredentials` are computed by the same logic as `canAccessLegend` in neighboring sections: `role === 'ADMIN' || (role === 'HR' && hrCanAccess)`. On a 403 from the backend — hide the section via an `onAccessDenied` callback or the same useHrContact pattern (try/catch → null → hide).

---

## 11. Props (component interface)

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

There is no `canAccess` prop — the component handles a 403 from the list endpoint itself (hides itself).

---

## 12. data-testid registry (for AutoTest)

| testid                              | What                                     |
| ----------------------------------- | ---------------------------------------- |
| `credentials-section`               | Root Card                                |
| `credentials-add-btn`               | The «+ Добавить» button                  |
| `credentials-list`                  | `<ul>` list of entries                   |
| `credentials-item-{id}`             | `<li>` entry row                         |
| `credentials-label-{id}`            | Entry label                              |
| `credentials-reveal-btn-{id}`       | Eye button (reveal/hide)                 |
| `credentials-copy-btn-{id}`         | Copy button (visible on reveal)          |
| `credentials-password-display-{id}` | Span with the plaintext password         |
| `credentials-timer-bar-{id}`        | Auto-hide progress bar                   |
| `credentials-edit-btn-{id}`         | Edit button                              |
| `credentials-delete-btn-{id}`       | Delete button                            |
| `credentials-dialog`                | Add/edit dialog                          |
| `credentials-input-label`           | The «Название» input in the dialog       |
| `credentials-input-login`           | The «Логин» input in the dialog          |
| `credentials-input-password`        | The «Пароль» input in the dialog         |
| `credentials-input-url`             | The «URL» input in the dialog            |
| `credentials-input-notes`           | The «Заметки» textarea in the dialog     |
| `credentials-dialog-submit`         | Dialog submit button                     |
| `credentials-delete-confirm`        | AlertDialog confirm                      |
| `credentials-clipboard-status`      | aria-live region of the clipboard status |
| `credentials-error-{id}`            | Inline error under the row               |

---

## 13. Russian texts (user-facing)

### Section (without the dialog)

| Element               | Text                                                            |
| --------------------- | --------------------------------------------------------------- |
| Section title         | `«ПАРОЛИ ПРОЕКТА»` (uppercase tracking-wider, sections pattern) |
| Add button            | `«Добавить»`                                                    |
| Empty state           | `«Нет сохранённых паролей»`                                     |
| Password mask         | `«••••••••»` (static text)                                      |
| Tooltip reveal        | `«Показать пароль»` / `«Скрыть пароль»`                         |
| Tooltip copy          | `«Копировать пароль»`                                           |
| Tooltip edit          | `«Редактировать»`                                               |
| Tooltip delete        | `«Удалить»`                                                     |
| Clipboard status      | `«Пароль скопирован»`                                           |
| Error 403             | `«Нет доступа к этому паролю»`                                  |
| Error 429             | `«Слишком много запросов. Попробуйте через минуту.»`            |
| Error network         | `«Не удалось получить пароль. Попробуйте ещё раз.»`             |
| Disabled reveal title | `«Доступно через {N}с»`                                         |

### Dialog

| Element                     | Text                                 |
| --------------------------- | ------------------------------------ |
| Title create                | `«Добавить аккаунт»`                 |
| Title edit                  | `«Редактировать аккаунт»`            |
| Label «Название»            | `«Название *»`                       |
| Label «Логин»               | `«Логин»`                            |
| Label «Пароль»              | `«Пароль *»`                         |
| Label «Пароль» (edit)       | `«Новый пароль»`                     |
| Placeholder password (edit) | `«Оставьте пустым, чтобы не менять»` |
| Label «URL»                 | `«URL»`                              |
| Label «Заметки»             | `«Заметки»`                          |
| Button cancel               | `«Отмена»`                           |
| Button submit               | `«Сохранить»`                        |

### Delete AlertDialog

| Element     | Text                                             |
| ----------- | ------------------------------------------------ |
| Title       | `«Удалить аккаунт?»`                             |
| Description | `«Запись «{label}» будет удалена безвозвратно.»` |
| Cancel      | `«Отмена»`                                       |
| Action      | `«Удалить»`                                      |

---

## 14. Hook: use-credentials.ts

Model: `apps/web/app/hooks/use-legend.ts`. All responses via `.parse()` from `@crm/shared`.

Exports:

```ts
export function useCredentials(projectId: string) // list query
export function useCreateCredential(projectId: string) // mutation
export function useUpdateCredential(projectId: string) // mutation
export function useDeleteCredential(projectId: string) // mutation
export function useRevealCredential(projectId: string) // manual query (не auto-fetch)
```

`useRevealCredential` — **manual trigger**, not a `useQuery` with `enabled`. Use `useMutation` or `useQuery` with `enabled: false` + `refetch()` on the eye click. Do not cache the response in the QueryClient (plaintext in memory only in component state).

On 403 `useCredentials` → the component hides itself (not an error state). All other error codes → a toast via sonner.

---

## 15. Anti-patterns (check during code review)

- Do not store the plaintext password in the QueryClient cache — only in the row component's `useState`.
- Do not add `data-password` or other data attributes with plaintext to DOM elements.
- Do not use `transition: all` on buttons — only explicit properties (make-interfaces-feel-better).
- Do not make the reveal block `display: none` via CSS (a screen reader will not see it); use conditional rendering.
- Do not nest Cards inside a Card (anti-pattern). The reveal block is not a Card, only a styled div.
- Do not copy the HR access logic from legend.service — use the new `HrAccessService` (Coder task §6).
