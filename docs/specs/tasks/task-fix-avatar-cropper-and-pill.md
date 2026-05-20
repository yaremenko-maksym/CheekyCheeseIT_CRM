# task-fix-avatar-cropper-and-pill

## Агент: coder
## Приоритет: high
## Ветка: claude/youthful-hermann-8df1d5 (PR #28)

## КРИТИЧЕСКИ ВАЖНО

- **Fix-задача в существующую ветку:**
  ```bash
  git fetch origin
  git checkout claude/youthful-hermann-8df1d5
  git pull origin claude/youthful-hermann-8df1d5
  ```
- Push в эту же ветку → PR #28 обновится.

## Три задачи в одном task'е (можно тремя отдельными коммитами)

---

## ЗАДАЧА 1 — Avatar круглый cropper после загрузки

### Проблема (user feedback)

> "Если залить продолговатое изображение (вертикальное высокий и горизонтально узкий например) 1000X100, то картинка становиться вытянутой, давай создадим шаг где пользовательно должен будет указать зону на картинке (ровный круг). Который будет отображаться в профиле. Так уже много где делают, это очень популрно в мобильных приложениях, а я хочу на сайте такой же функционал."

Сейчас в `AvatarUploadDialog.tsx` после file pick → сразу сохраняется через base64. На вертикальных/горизонтальных изображениях `<AvatarImage>` (shadcn = `<img>`) ужимает их с искажением (CSS `object-cover` либо `object-contain`, не круговой crop с осмысленным центром).

### Что сделать

После того как юзер выбрал файл (или вставил URL) — показывать **шаг crop** в той же модалке:

1. Установить библиотеку `react-easy-crop`:
   ```bash
   pnpm --filter @crm/web add react-easy-crop
   ```
   Это легковесная (~25KB), популярная библиотека с круглым crop, zoom и pan.

2. В `AvatarUploadDialog.tsx`:
   - Вместо single-step "выбор файла → сохранить" → multi-step:
     - **Step 1: source** — выбрать файл / ввести URL (как сейчас)
     - **Step 2: crop** — показать `<Cropper>` из `react-easy-crop` с props:
       - `image` = data URL или URL
       - `crop` / `setCrop` (centre point)
       - `zoom` / `setZoom` (slider от 1 до 5)
       - `aspect={1}` (квадрат)
       - `cropShape="round"` (круг)
       - `showGrid={false}`
     - Под Cropper — слайдер zoom (shadcn `<Slider>`; если нет — установи через `pnpm dlx shadcn@latest add slider`)
     - Кнопки: "Назад" (вернуться к step 1), "Сохранить" (применить crop и закрыть модал)
   - При нажатии "Сохранить":
     - Создать canvas, нарисовать обрезанную область (использовать утилиту из README react-easy-crop — `getCroppedImg(imageSrc, croppedAreaPixels)` через `<canvas>` + `ctx.drawImage`).
     - Конвертировать canvas → data URL (PNG или JPEG, лимит 500KB).
     - Передать в `useUpdateMe({ avatarOverride: dataUrl })`.
     - Закрыть модал.
   - Сохранить размер итогового изображения **512×512** или **256×256** (квадрат, потом маска через CSS `border-radius: 50%`). Это даёт хорошее качество + разумный размер base64.

3. URL-режим: показать "Шаг 2: crop" только если URL валиден и img загрузилось. Иначе показать ошибку.

### Acceptance #1

- Загрузка 1000×100 → видишь cropper с возможностью драгом выбрать квадрат + zoom slider → "Сохранить" → в шапке круглая центрированная аватарка
- Hover на аватарку показывает большую иконку (см. ЗАДАЧА 2)
- Avatar отображается одинаково правильно в header профиля, в выпадающем меню пользователя CRM-шапки, в TeamTab/ProjectsTab если там есть

---

## ЗАДАЧА 2 — Hover показывает большую иконку фотографии

### Проблема (user feedback)

> "На хавере аватарки давай покажем ещё большую иконку фотографии для красоты"

Сейчас на hover показывается текст "Изменить" (`UserProfileHeader.tsx` — button с absolute span внутри).

### Что сделать

В `apps/web/app/components/user-profile/UserProfileHeader.tsx`:

Заменить текст "Изменить" на крупную иконку `Camera` (lucide-react) с anim:

```tsx
import { Camera } from 'lucide-react'
// ...
<button ...>
  {avatarBody}
  <span
    className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
  >
    <Camera className="h-12 w-12 text-white" strokeWidth={1.5} />
  </span>
</button>
```

Иконка ~48px (h-12 w-12) — крупная, контрастная, по центру круга. На hover плавный fade-in.

### Acceptance #2

- Hover на свою аватарку → плавно появляется большая иконка камеры на полупрозрачном чёрном фоне
- Outside hover → иконка пропадает

---

## ЗАДАЧА 3 — Восстановить жёлтый animated pill на табах

### Проблема (user feedback)

> "Отсутствует layout анимированный фон на табах(желтый)"

Сейчас в `apps/web/app/components/ui/animated-tabs.tsx`:

```tsx
<motion.span
  layoutId="animated-tab-pill"
  className="absolute inset-0 rounded-md bg-background shadow-sm"
  ...
/>
```

`bg-background` = тот же цвет что и страница → pill невидим. Юзер ожидает жёлтый/контрастный pill.

### Что сделать

Поменять `bg-background` → `bg-primary` (Tailwind primary в этой теме = жёлтый, через design system tokens).
Поменять текст активного таба на `text-primary-foreground` для контраста (на жёлтом фоне тёмный текст).

```tsx
<motion.span
  layoutId="animated-tab-pill"
  className="absolute inset-0 rounded-md bg-primary shadow-sm"
  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
  aria-hidden
/>
// ...
className={cn(
  'relative inline-flex items-center justify-center rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
  active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
)}
```

Если `bg-primary` в этой теме НЕ жёлтый — проверь `apps/web/app/styles/globals.css` (CSS vars) и выбери токен или явный `bg-yellow-500` который соответствует accent цвету CRM.

### Acceptance #3

- Активный таб подсвечен жёлтым закруглённым pill'ом
- Текст активного таба контрастный (тёмный на жёлтом)
- Переключение таба — плавная spring-анимация pill'а к новой позиции

---

## ОБЩЕЕ ACCEPTANCE

- `pnpm exec turbo typecheck lint --force` — clean
- API:3001 + Web:3000 — 200
- Smoke в Playwright: загрузил 1000×100 png → cropper → "Сохранить" → header аватарка круглая (не растянутая), hover показывает Camera иконку, переключение табов жёлтый pill анимируется
- Push в `claude/youthful-hermann-8df1d5`

Три commit'а:
- `feat(profile): round avatar cropper after upload (react-easy-crop)`
- `style(profile): show large Camera icon on avatar hover instead of text`
- `fix(ui): restore yellow pill on AnimatedTabs (bg-primary instead of bg-background)`

## После

Короткий summary (≤200 слов): 3 SHA коммита, кратко финальная стратегия cropper, ссылки на screenshots если делал Playwright snapshots.

Используй MCP:
- context7 для `react-easy-crop` docs (правильное использование getCroppedImg)
- ast-grep для поиска avatar references в проекте (чтобы понять кто ещё использует user.avatar)
- playwright MCP для browser verification
- eslint MCP для pre-check
