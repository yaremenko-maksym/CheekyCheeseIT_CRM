# landing-redesign — coder-ready spec (ui-ux-designer Mode E)

**Статус:** экспорт Claude Design реконсилирован в coder-spec 2026-07-23 (Mode E).
**Claude Design проект:** https://claude.ai/design/p/9c07d82e-ea1b-4b84-a8a1-94aa5210f051
**Дизайн-система:** `CheekyCheeseIT CRM` (synced) — токены/oklch-значения экспорта **1:1 совпадают**
с `apps/landing/app/styles/globals.css` (проверено построчным diff, см. §3). Никаких новых
base-токенов вводить не нужно.
**Продуктовая спека:** `docs/superpowers/specs/2026-07-22-landing-refactor-design.md` (§2 —
лендинг; этот файл её конкретизирует до компонентного уровня, НЕ дублирует бизнес-требования).
**Design tier:** 1 (новый редизайн существующих экранов `/`, `/careers`, `/careers/:slug`).

**Кодеру:** это единственный интерфейс к дизайну. `.dc.html` в `assets/landing-redesign/` —
**визуальный референс**, генерируемый standalone-экспортом Claude Design (generic divs +
инлайн-стили + собственный `x-dc`/`sc-if`/`sc-for` шаблонный синтаксис). **НЕ копировать HTML,
НЕ импортировать `support.js`/`site.css`/`\_ds/**`в билд.** Строить нашими React-компонентами +`apps/landing/app/styles/globals.css`токенами, следуя маппингу §2 и spec ниже. Fidelity-приёмка
(Mode B) сравнивает live`localhost:3002` со скриншотами §7, а не с самим HTML.

---

## 0. Направление (кратко, per `frontend-design-direction`)

| Вопрос               | Ответ                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**          | Публичная витрина студии — конвертит визитёра в лид («Start a project») или кандидата («See open roles»). Не CRM — не подчиняется тону `foundation.md` («dense/quiet operations tool»); это намеренное исключение.                                                     |
| **Audience**         | Founder/CTO продуктовой компании (заказчик) и senior-инженер (кандидат) — оба искушённые, сканируют быстро, ценят техническую достоверность (живой код, метрики) больше маркетингового глянца.                                                                         |
| **Tone**             | **Премиум-сдержанный dev-tool.** Тёмный фон, фирменный жёлтый как единственный высокоэнергичный акцент, моно-шрифт для технических деталей (терминал, лейблы). Уровень Linear/Vercel — НЕ generic SaaS-landing (никаких фиолетовых градиентов/blob/stock-иллюстраций). |
| **Memorable detail** | Живой печатающийся терминал с реальными доменными code-сниппетами (AI/EdTech/E-Commerce) — единственный «hero-визуал», без стоковых картинок/фото людей (владелец: «без персоналий»).                                                                                  |
| **Constraints**      | Tailwind v4 (`@theme inline`) + Framer Motion + only-English copy + WCAG 2.2 AA + responsive 320/768/1024/1440 + `prefers-reduced-motion`.                                                                                                                             |

---

## 1. Роуты и секции (напоминание из продуктовой спеки)

- **`/`** — Nav → Hero(+Terminal) → About → Selected work (3 case studies) → Services (3) →
  How we work (4 шага) → Tech stack (chips) → Careers-тизер (до 3 живых вакансий ИЛИ empty-CTA) →
  Contact → Footer.
- **`/careers`** — Nav → header (заголовок+лид) → **список вакансий БЕЗ фильтров** (2-колоночный
  grid карточек) ИЛИ empty state → Footer.
- **`/careers/:slug`** — Nav → back-link → title-block (тег+заголовок+meta-теги) → 2-колоночная
  деталка (markdown-описание слева, sticky форма отклика справа) → Footer.
- Контактный email везде — **`hr@cheekycheese.tech`** (единственный на всём лендинге).

---

## 2. Компонентный маппинг

### 2.1. Уже есть в `apps/landing/app/components/` — переиспользовать as-is

| Компонент   | Файл             | Как используется в редизайне                                                                                                                                                                                                                                                          |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`    | `ui/button.tsx`  | CTA везде. `variant="default"` = `cc-btn-primary` (жёлтый), `variant="outline"` ≈ `cc-btn-ghost` (нужно поправить бордер-токен на `border-border` — уже есть). Размеры: смэпить `size="lg"` → `cc-btn-lg` (52px), добавить `size="default"` →46px (уже 36/h-9 — **см. §2.3 правки**). |
| `Badge`     | `ui/badge.tsx`   | Годится для мелких статус-меток, НЕ для domain-тегов (см. новый `Tag` §2.2) и НЕ для eyebrow (см. новый `SectionEyebrow`).                                                                                                                                                            |
| `BrandMark` | `brand-mark.tsx` | Логотип в Nav (`variant="outline"`, `h-8 w-8 text-primary` на жёлтом квадрате — см. правку §2.4) и Footer (`variant="flat"`).                                                                                                                                                         |
| `cn`        | `lib/utils.ts`   | Как есть.                                                                                                                                                                                                                                                                             |

### 2.2. Новые примитивы (`apps/landing/app/components/ui/`) — добавить

| Компонент            | Обоснование (нет аналога)                                                                                                                                                                                  | Соответствие экспорту                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Card`               | Переиспользуется в Services/Selected work/Process/Careers-empty/Contact-CTA/Vacancy-apply-box — 6+ мест. `apps/web` имеет `card.tsx`, `apps/landing` — нет (отдельный workspace, отдельный component-lib). | `.cc-card`: `bg-card border border-border rounded-2xl p-6 md:p-[30px] transition-[border-color,transform,background] duration-300`. Hover-вариант (`cc-card-hover`): `hover:border-primary/40 hover:-translate-y-[3px]` — только там, где карточка кликабельна (VacancyCard, Services). |
| `Tag`                | Domain-бейдж (AI/ML · EdTech · E-Commerce · neutral) с цветной подложкой — семантика отличается от `Badge` (роли/статусы CRM).                                                                             | `.cc-tag-{ai,edu,ecom,neutral}`. Цвета — **новые семантические токены** (см. §3.2, НЕ хардкод hex).                                                                                                                                                                                     |
| `Chip`               | Pill с dot-индикатором для hero eyebrow-строки и tech-stack — не то же самое, что `Badge`.                                                                                                                 | `.cc-chip`: `inline-flex items-center gap-[7px] rounded-full border border-border/60 bg-card/60 px-3.5 py-2 text-[0.86rem] text-foreground/80 hover:border-primary/55 hover:text-foreground`.                                                                                           |
| `Input` / `Textarea` | Форма отклика — единственное текстовое поле ввода на лендинге, примитива нет.                                                                                                                              | `.cc-input`: `h-[46px] w-full rounded-[10px] border border-border bg-input px-3.5 text-[0.95rem] focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/22`. Textarea — `min-h-[140px] resize-y`.                                                             |

### 2.3. Правка существующих примитивов

- **`Button`**: добавить/выровнять размеры под `cc-btn` шкалу — `sm`=40px (только НЕ на touch-путях,
  см. a11y §5), `default`=46px (текущий `h-9`=36px — **несоответствие макету**, поднять до `h-[46px]`
  ТОЛЬКО в контексте marketing-кнопок; не трогать `apps/web` копию, это отдельный workspace), `lg`=52px.
  Активный active-состояние `active:translate-y-px` (сейчас `active:scale-[0.98]` — визуально
  отличается от макета, где кнопка «проседает», а не сжимается — поправить под hero/CTA use-case).
- **`Badge` `variant="outline"`**: используется в текущем `index.tsx` для eyebrow-строк — в
  редизайне заменяется на новый `Chip`/`SectionEyebrow` (§2.2/§2.5), `Badge` для этих мест больше
  не используется.

### 2.4. Новые составные компоненты (`apps/landing/app/components/marketing/`)

| Компонент          | Экспорт-референс                                                 | Заметки                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MarketingNav`     | `Nav.dc.html`                                                    | Sticky (`sticky top-0 z-50`), фон `bg-background/72` + `backdrop-blur-md`, нижний бордер появляется после `scrollY>8` (`border-border` при скролле, `border-transparent` в топе — воспроизвести через `useState`+`scroll` listener или `useScroll` из Framer Motion). Desktop-ссылки видны от **900px** (не Tailwind default `lg=1024` — используй `min-[900px]:flex` / `min-[900px]:hidden` для бургера, как в экспорте). Активный пункт — `aria-current="page"` + `text-foreground` (не-активные `text-foreground/72`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `MobileNavMenu`    | `Nav.dc.html` (`.cc-mobile-menu`)                                | Дисклоужер под хедером (НЕ модалка/Sheet — не нужен focus-trap, это часть навигации). `AnimatePresence`+`motion.div` по `max-height`/`opacity` (как в экспорте `menuStyle`). Бургер-кнопка **44×44px** (уже в экспорте, сохранить). При открытии — фокус остаётся в кнопке; `Escape` закрывает + возвращает фокус на бургер (добавить — в экспорте нет, must-have для a11y).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MarketingFooter`  | `Footer.dc.html`                                                 | 4-колоночный grid (`grid-cols-1 md:grid-cols-4`, лого-блок `col-span-full md:col-span-1` — в экспорте это `grid-column:1/-1` на mobile/tablet, полноширинный логотип-блок). 3 колонки ссылок: Studio / Company / Get in touch (`hr@cheekycheese.tech` mailto).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Terminal`         | `Terminal.dc.html`                                               | **Эволюция** существующего `Terminal()` внутри `routes/index.tsx` (сейчас инлайн, 3 упрощённых сниппета без line-numbers) → вынести в `marketing/terminal.tsx`, апгрейд: (a) 3 НОВЫХ сниппета из экспорта — `ai-platform/serve.py` (torch inference), `edtech-platform/path.ts` (adaptive path engine), `commerce-storefront/checkout.ts` (idempotent checkout) — использовать ТЕКСТ 1:1 из `Terminal.dc.html` (уже финальная копия); (b) line-numbers в левой колонке (моно, `text-foreground/26`, `w-[2.2em]` right-aligned); (c) статус-индикатор `live` с пульсирующей точкой (`bg-primary` + `box-shadow` glow) в правом углу тулбара; (d) посимвольный typewriter с character-level tokenizer (keyword/string/number/comment/fn/type/var/punct классы — портировать `tokenize()`/`buildFlat()` логику из `Terminal.dc.html` 1:1, это чистый JS, не UI-фреймворк-специфичный) вместо нынешнего line-level; (e) macOS window chrome (3 точки, полупрозрачный фон тулбара) — уже есть, сохранить/донастроить под новые токены. `role="img"` + `aria-label` описывающий терминал целиком (AT не должен читать посимвольную анимацию) — обязательно перенести. |
| `SectionEyebrow`   | (паттерн `.cc-eyebrow` встречается 8+ раз)                       | Маленький переиспользуемый компонент: `— LABEL` (тире + uppercase mono-tracked текст, `text-primary`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `StatStrip`        | Home «About» секция (40+/15+/3+/20+)                             | `grid grid-cols-2 md:grid-cols-4 gap-5`. Число — `cc-stat-num` (`text-[clamp(2.2rem,5vw,3.25rem)] font-semibold tracking-[-0.03em]`), суффикс `+`/`%` — `text-primary`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CaseStudyCard`    | Home «Selected work» — 3 карточки (Challenge/Solution/3 метрики) | Данные — типизированный массив (домен/тег/заголовок/challenge/solution/3×{value,label}). **Копия финальная** — взять 1:1 текст из `Home.dc.html` (assistant-драфт уже утверждён процессом дизайна; коррективы владельца — отдельная правка после вёрстки, не блокер).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ServiceCard`      | Home «Services» — 3 карточки (AI/ML, EdTech, E-Commerce)         | `Card` + `Tag` + h3 + описание + `<ul>` из 3 пунктов. Текст — 1:1 из `Home.dc.html`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ProcessStep`      | Home «How we work» — 4 шага                                      | `Card` вариант с `step-num` мото-лейблом (`01 / Discovery` — сохранить формат `NN / Name`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TechStackChips`   | Home «Tech stack»                                                | `Chip` × 18 технологий, `flex flex-wrap gap-3`. Список технологий — обновить под актуальный стек (в экспорте: TypeScript/React/Next.js/Node.js/Python/PyTorch/TensorFlow/Go/PostgreSQL/Redis/GraphQL/Kubernetes/Docker/AWS/GCP/Terraform/Stripe/Kafka — шире текущего списка на лендинге; финальный список — на усмотрение владельца при ревью, дизайн только задаёт визуальный паттерн chip-грида).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `VacancyCard`      | `VacancyCard.dc.html`                                            | `Card` (hover-вариант) как `<Link>` на `/careers/:slug`. domain `Tag` + type mono-лейбл сверху; title h3; seniority+location мета-ряд (иконки `lucide-react` — `BarChart3`/`MapPin`, уже в deps); footer-ряд «View role» + круглая кнопка-стрелка (`ArrowRight`, 38×38px круг с бордером).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `VacancyApplyForm` | `Vacancy.dc.html` (aside)                                        | Controlled форма, состояния `default \| submitting \| success \| error` (см. §6.4). Поля — Full name*/Email*/Telegram/LinkedIn URL/GitHub URL/Cover letter/CV\*. Честная реализация (не DC-заглушка): интегрирует Turnstile invisible widget + honeypot + реальный `fetch POST /api/public/vacancies/:slug/apply` (multipart).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CvDropzone`       | `Vacancy.dc.html` (`.cc-drop`)                                   | Часть `VacancyApplyForm` (можно отдельным файлом для читаемости). Drag&drop + `<input type=file>` visually-hidden (opacity:0, `1px×1px`, `position:absolute`) обёрнутый `<label>` — паттерн из экспорта уже a11y-корректен (label — кликабельная/focusable-через-input цель), перенести 1:1. Клиентская валидация: `application/pdf` (MIME + `.pdf` fallback) + ≤5MB — те же правила, что и сервер (§2.2 продуктовой спеки), UX должен ловить ошибку ДО отправки.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MarkdownBody`     | `Vacancy.dc.html` (`.cc-prose`)                                  | `ReactMarkdown` + `remark-gfm` (**тот же паттерн, что `AcceptTosStep.tsx`** в `apps/web` — `<ReactMarkdown>{descriptionMd}</ReactMarkdown>` без `rehype-raw`, т.е. сырой HTML в markdown не рендерится — безопасно by default). Обернуть в `<article className="cc-prose-эквивалент">` — Tailwind `[&_h3]:...` arbitrary-variant стили ИЛИ выделенный `markdown-body.tsx` с `className` пропсами на h3/p/ul/li (заголовки `text-foreground font-semibold`, `li::marker` — `text-primary` через `marker:text-primary`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 2.5. Роуты (`apps/landing/app/routes/`)

| Файл (предложение)         | Роут             | Данные                                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes/index.tsx`         | `/`              | Полная переработка (см. §1). Careers-тизер — TanStack Router `loader` → `fetch('/api/public/vacancies')`, top-3, `hasRoles = list.length > 0` (аналог `hasOpenRoles` tweak в экспорте, но по реальным данным, не prop).                                                              |
| `routes/careers.tsx`       | `/careers`       | `loader` → `fetch('/api/public/vacancies')`, список без фильтров, `isEmpty = list.length === 0`.                                                                                                                                                                                     |
| `routes/careers.$slug.tsx` | `/careers/:slug` | `loader` → `fetch('/api/public/vacancies/:slug')`; 404 (DRAFT/CLOSED/не найдено) → редирект/`notFound()` TanStack Router на **дружелюбный empty-state**, НЕ raw 404 (продукт: «не раскрываем существование» на сервере — на клиенте просто «Role not found» + ссылка на `/careers`). |

Все 3 файла — same-origin `fetch` (см. продуктовую спеку §2.3), без react-query.

---

## 3. Token-map

### 3.1. Базовые токены — уже 1:1 (verified byte-diff oklch values)

Проверено: `--primary`/`--primary-foreground`/`--background`/`--foreground`/`--card`/
`--muted-foreground`/`--border`/`--input`/`--destructive` в экспортированном
`_ds_bundle.css` (`:root` и `.dark`) **совпадают побайтово** (oklch-значения) с
`apps/landing/app/styles/globals.css`. Дизайн-система синхронизирована — **новых base-токенов
не вводим**. Экспорт — dark-only лендинг (`class="dark"` жёстко на корневом div во всех 3 `.dc.html`)
— это осознанное решение (лендинг не имеет light/dark toggle, только `.dark`; см. §5.2).

### 3.2. Производные `--cc-*` переменные экспорта → куда деть

Экспорт вычисляет вспомогательные переменные через `color-mix()` поверх наших токенов (не новые
базовые цвета — производные). Рекомендация: **не плодить дубли `--cc-*` имён**, а или (a) завести
маленький layer в `globals.css`/новом `marketing.css` с 3-4 переиспользуемыми computed-переменными,
или (b) инлайнить `color-mix()` через Tailwind arbitrary values по месту. Т.к. паттерны повторяются
6-10+ раз — рекомендуется (a):

```css
/* apps/landing/app/styles/globals.css — добавить в конец, marketing-only computed layer */
:root,
.dark {
  --marketing-line: color-mix(in oklch, var(--foreground) 10%, transparent);
  --marketing-line-soft: color-mix(in oklch, var(--foreground) 6%, transparent);
  --marketing-glow: color-mix(in oklch, var(--primary) 55%, transparent);
  --marketing-dim: var(--muted-foreground); /* алиас для читаемости в разметке, не новый цвет */
}
```

Использовать как `border-[var(--marketing-line)]` (Tailwind v4 arbitrary property) вместо
хардкод-хексов. **НЕ создавать** отдельных `--cc-yellow` (= `var(--primary)` один в один, просто
использовать `text-primary`/`bg-primary` напрямую).

### 3.3. Domain-tag цвета (новые семантические токены — единственное реальное расширение)

Экспорт использует 3 фиксированных oklch-hue для доменных тегов, НЕ производные от `--primary`
(нужны 3 разных hue для визуального различения AI/EdTech/E-Commerce):

| Домен      | oklch (экспорт)                          | Предлагаемое имя токена |
| ---------- | ---------------------------------------- | ----------------------- |
| AI / ML    | `oklch(84% .12 200)` (голубой)           | `--tag-ai`              |
| EdTech     | `oklch(82% .13 145)` (зелёный)           | `--tag-edtech`          |
| E-Commerce | `oklch(80% .12 320)` (розово-фиолетовый) | `--tag-ecommerce`       |

Добавить в `@theme inline` + `:root`/`.dark` (одинаковые в обоих — экспорт не варьирует их по
теме, лендинг dark-only). Это **единственное легитимное расширение палитры** — существующие
токены не покрывают 3-domain differentiation семантику (не связано с ролями/статусами CRM, поэтому
не конфликтует с существующей RBAC-палитрой `apps/web`). Использовать ТОЛЬКО в `Tag`-компоненте
(§2.2), нигде больше на лендинге.

### 3.4. Terminal-специфичные syntax-цвета

`tk-key`/`tk-fn`/`tk-str`/`tk-num`/`tk-type` в экспорте переиспользуют `--tag-ecommerce`
(фиолетовый, keywords), `--primary` (функции), `--tag-edtech` (зелёный, строки), `--tag-ai`
(голубой, числа/типы) — **не новые токены**, маппятся на §3.3. `tk-com`/`tk-var`/`tk-punc` —
`color-mix(in oklch, var(--foreground) {34,92,55}%, transparent)`.

---

## 4. Type-scale

| Класс экспорта | Tailwind-эквивалент (arbitrary, т.к. `clamp()`)                                                                                                                                                                                                                                                | Где                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `.cc-display`  | `text-[clamp(2.35rem,8vw,5rem)] leading-[1.02] tracking-[-0.03em] font-semibold text-balance`                                                                                                                                                                                                  | H1 hero, H1 careers-header, H1 vacancy-title (свой clamp — см. §6, чуть меньше) |
| `.cc-h2`       | `text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.025em] font-semibold text-balance`                                                                                                                                                                                                | Секционные H2                                                                   |
| `.cc-h3`       | `text-[clamp(1.25rem,2.4vw,1.6rem)] leading-[1.15] tracking-[-0.015em] font-semibold`                                                                                                                                                                                                          | Карточные заголовки                                                             |
| `.cc-lead`     | `text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-muted-foreground max-w-[40ch] text-pretty`                                                                                                                                                                                             | Подзаголовки секций                                                             |
| `.cc-body`     | `text-muted-foreground leading-[1.65] text-pretty`                                                                                                                                                                                                                                             | Параграфы                                                                       |
| `.cc-eyebrow`  | `text-[0.78rem] tracking-[0.16em] uppercase font-medium text-primary` + `::before` тире-линия (реализовать через `<span>` псевдо-элемент невозможен в Tailwind напрямую — либо реальный `<span>` 20×1px перед текстом, либо `before:content-[''] before:w-5 before:h-px before:bg-primary/70`) | `SectionEyebrow`                                                                |

Шрифты: Inter (текст) + JetBrains Mono (`cc-mono` — терминал, лейблы, eyebrow-теги, шаги
процесса) — **JetBrains Mono НЕ подключён** в текущем `apps/landing` (только Inter через
`--font-sans`). Добавить `--font-mono: 'JetBrains Mono', ui-monospace, monospace;` в
`@theme inline` + Google Fonts `<link>` (или self-host, на усмотрение DevOps/Coder) в `__root.tsx`.

---

## 5. Motion-spec (Framer Motion)

Уже в deps (`framer-motion ^12.0.0`). Принцип продуктовой спеки: «премиум-сдержанные», НЕ
WebGL/3D, `prefers-reduced-motion` уважается.

### 5.1. Паттерны

- **Scroll-reveal:** `whileInView={{ opacity: 1, y: 0 }}` `initial={{ opacity: 0, y: 22 }}`
  `viewport={{ once: true, margin: '-8%' }}` `transition={{ duration: 0.7, ease: [0.2,0.6,0.2,1] }}`
  — на секционных блоках (не на каждом дочернем элементе по отдельности, экспорт местами
  переусердствует с `cc-reveal` на каждой карточке; ограничиться уровнем секции +
  card-грид как единая группа с `staggerChildren` при желании polish).
  **Above-the-fold контент (hero copy + terminal) НЕ должен зависеть от scroll-reveal** —
  виден сразу (экспорт это учитывает через хардкод `is-in` на hero, сохранить принцип: `initial`
  hero = уже видимое состояние, никакого fade-in-on-scroll для первого экрана).
- **Terminal typewriter:** посимвольный reveal через `setTimeout`-цепочку (портировать тайминги
  1:1 из `Terminal.dc.html`: буква ~16-46ms, пробел 22ms, перевод строки 90-170ms, pause между
  сниппетами 2400ms). НЕ requestAnimationFrame-heavy — таймер достаточно лёгкий.
- **Кнопки:** `active:translate-y-px` (микро-press), hover на primary — `box-shadow` glow
  (`hover:shadow-[0_8px_30px_-8px_var(--marketing-glow)]`) + чуть светлее фон
  (`hover:bg-[color-mix(in_oklch,var(--primary)_92%,white)]`), стрелка-иконка внутри кнопки
  сдвигается на `hover:translate-x-[3px]` (`transition-transform`).
- **Nav scroll-state:** бордер снизу хедера плавно проявляется при `scrollY > 8`
  (`transition-colors duration-300`).
- **Mobile menu:** `AnimatePresence` + `max-height`/`opacity` (не `height:auto` — ломает
  transition), `duration: 0.35` ease `cubic-bezier(.2,.6,.2,1)`.
- **CV dropzone drag-over:** `border-color` + `background` transition `0.2s ease` (не Framer,
  чистый CSS-transition ок для такой мелочи).
- **`prefers-reduced-motion: reduce`:** глобально — использовать `useReducedMotion()` из
  framer-motion в каждом месте, где есть `whileInView`/`animate` цикл, и:
  - scroll-reveal → рендерить сразу в конечном состоянии (`initial=false` эквивалент), БЕЗ
    полагания на IntersectionObserver-only логику из экспорта (экспорт при reduced-motion
    буквально **не устанавливает `is-in`** в JS и полагается ИСКЛЮЧИТЕЛЬНО на CSS
    `@media (prefers-reduced-motion) { .cc-reveal { opacity:1 !important } }` — воспроизвести
    именно так: React-компонент тоже должен не зависеть от JS-флага, а visibility должна
    гарантироваться CSS-уровнем/условным рендером, чтобы «двойной guard» не оставлял контент
    невидимым при частичной поддержке);
  - terminal typewriter → показать финальный сниппет сразу, без анимации набора, курсор без
    blink-анимации;
  - magnetic/hover micro-interactions → просто убрать transition (не критично для reduced-motion,
    но `transform`-heavy hover можно смягчить).

---

## 6. Responsive-поведение (320 / 768 / 1024 / 1440 — hard-гейт)

Экспорт использует **свои breakpoints** (640/768/900/1000/1024), частично НЕ совпадающие с
Tailwind default (`sm=640 md=768 lg=1024 xl=1280`). Для fidelity — воспроизводить точные пороги
через arbitrary variants (`min-[900px]:`, `min-[1000px]:`) там, где явно указано ниже; иначе —
стандартные Tailwind breakpoints.

### 6.1. Nav

- **<900px:** только логотип + бургер (44×44px, `aria-expanded`). Клик → `MobileNavMenu`
  раскрывается под хедером на всю ширину, вертикальный список ссылок (`padding: 13px 4px`,
  `font-size: 1.05rem` — крупнее десктопных ссылок, под тач) + full-width CTA-кнопка снизу.
- **≥900px:** горизонтальное меню (Services/Work/Careers/Contact) + CTA-кнопка справа, бургер
  скрыт.

### 6.2. Hero (`/`)

- **320-1023px:** одна колонка — copy сверху, `Terminal` под ней (`grid-template-columns: 1fr`).
  Terminal — full-width карточка, `min-height` тела 340px.
- **≥1024px:** 2 колонки (`1.02fr 1fr`, gap 56px) — copy слева, terminal справа. Terminal
  `min-height` тела растёт до 400px, font-size 13.5px (от 12.5px на мобиле).
- CTA-ряд (`Start a project` + `See open roles`): `flex-col` <460px → `flex-row wrap` ≥460px.

### 6.3. About / stats

- Двухколоночная секция (`cc-two`): 1 колонка <900px → `0.85fr 1.15fr` ≥900px.
- Bullet-грид (4 пункта): `grid-cols-1` уже в макете `repeat(2,1fr)` фиксированно (не меняется по
  брейкпоинтам — 2 колонки всегда, даже на 320px; на очень узких экранах допустимо не ужиматься
  дальше, текст короткий).
- Stat-strip: `grid-cols-2` <768px → `grid-cols-4` ≥768px.

### 6.4. Selected work / Services / How we work (карточные грид-секции)

- Case studies (`cc-case` внутри карточки): 1 колонка <860px (текст сверху, 3 метрики снизу в
  своём `grid-cols-3` — метрики НЕ схлопываются в 1 колонку, всегда 3-в-ряд, даже на 320px, т.к.
  значения короткие типа «80ms»/«-64%»/«5×») → `1.25fr 1fr` ≥860px.
- Services: `grid-cols-1` <768px → `grid-cols-3` ≥768px.
- Process steps: `grid-cols-1` <768px → `grid-cols-4` ≥768px.

### 6.5. Careers list (`/careers`)

- `grid-cols-1` <640px → `grid-cols-2` ≥640px (НЕ 3 колонки ни на каком breakpoint в экспорте —
  карточки достаточно крупные, зафиксировано 1-2 колонки).

### 6.6. Vacancy detail (`/careers/:slug`)

- **<1000px:** описание и форма — одна колонка, форма идёт ПОСЛЕ описания (не sticky).
- **≥1000px:** `1.35fr 1fr` (описание слева, форма справа), форма **sticky** (`top: 90px`) —
  на очень длинном описании форма остаётся видимой при скролле.
- Form-row (2 инпута в ряд — name+email, telegram+linkedin): `grid-cols-1` <560px →
  `grid-cols-2` ≥560px.
- Meta-теги под заголовком (`Senior`/`Full-time`/`Remote · EU`/`4+ hrs overlap`) — `flex-wrap`,
  не грид — естественно оборачиваются на узких экранах.

### 6.7. Touch targets (мобайл, ≥44px — усиление 24px WCAG-минимума)

Все interactive-элементы экспорта уже ≥44px min-height (`cc-btn` 46/52px, `cc-input` 46px,
бургер 44×44px, круглая VacancyCard-стрелка 38×38px — **это НИЖЕ 44px**, поправить до 40-44px в
реализации или явно принять как decorative-only элемент внутри кликабельной card целиком
(вся `VacancyCard` — единая `<a>`, стрелка — визуальный акцент, не отдельная цель — приемлемо,
но зафиксировать это явное решение, не случайность).

---

## 7. Fidelity-референсы (для Mode B)

Отрендерены локально из `.dc.html` (Playwright, статичный HTTP-сервер на `_ds/`-бандле,
`prefers-reduced-motion`-эквивалент форсирован через inline `<style>` override перед скриншотом
— иначе scroll-reveal секции остаются `opacity:0` на статичном full-page снапшоте):

| Файл                                        | Страница                          | Ширина |
| ------------------------------------------- | --------------------------------- | ------ |
| `assets/landing-redesign/design.png`        | Home (`/`)                        | 1440   |
| `assets/landing-redesign/design-mobile.png` | Home (`/`)                        | 320    |
| `assets/landing-redesign/careers-1440.png`  | Careers (`/careers`)              | 1440   |
| `assets/landing-redesign/careers-320.png`   | Careers (`/careers`)              | 320    |
| `assets/landing-redesign/vacancy-1440.png`  | Vacancy detail (`/careers/:slug`) | 1440   |
| `assets/landing-redesign/vacancy-320.png`   | Vacancy detail (`/careers/:slug`) | 320    |

`screenshots/` (в `assets/landing-redesign/`) — кадры из самой Claude Design сессии генерации;
`careers-cards.png` там **устарел** (показывает фильтры All roles/AI-ML/EdTech/E-Commerce —
это ДО правки владельца от 2026-07-23, убравшей фильтры; актуальный референс —
`careers-1440.png`/`careers-320.png` выше, сгенерированные из финального `Careers.dc.html`,
который фильтров уже не содержит). `02-home-full.png` — пустой (сбой захвата в оборвавшейся
сессии) — игнорировать, использовать `design.png`.

---

## 8. Edge-cases

| Кейс                                                         | Поведение                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Careers-тизер (Home), 0 PUBLISHED вакансий**               | Секция НЕ скрывается (продукт-решение). Показывает CTA-карточку: иконка (папка), «No open roles right now», текст «We hire in waves…», кнопка `mailto:hr@cheekycheese.tech`. Референс — `sc-if noRoles` блок в `Home.dc.html` (строки с `hasOpenRoles` tweak). |
| **`/careers`, 0 PUBLISHED вакансий**                         | Полноразмерный empty-state (крупнее тизерного): иконка, «No open roles right now», текст, mailto-кнопка. Референс — `sc-if isEmpty` в `Careers.dc.html`.                                                                                                       |
| **`/careers/:slug`, несуществующий/DRAFT/CLOSED slug**       | 404 от API (без раскрытия причины) → клиент показывает «Role not found» + ссылка «Back to careers» (НЕ raw browser 404, НЕ leak статуса вакансии).                                                                                                             |
| **Форма отклика — default**                                  | Пустая форма, все поля видны, submit активен.                                                                                                                                                                                                                  |
| **Форма — submitting**                                       | Кнопка disabled (`aria-disabled`) + spinner + «Sending…», поля НЕ disabled (пользователь не должен терять введённое при случайном re-focus), honeypot/Turnstile невидимы всегда.                                                                               |
| **Форма — success**                                          | Форма заменяется на success-панель (иконка check, «Application received», персонализация именем если введено — `Thanks, {firstName}`, кнопка «Browse more roles» → `/careers`). `role="status"`.                                                               |
| **Форма — error (сеть/сервер)**                              | Форма остаётся с введёнными данными (НЕ очищать!), баннер `role="alert"` сверху формы «Something went wrong… try again».                                                                                                                                       |
| **Форма — 429 (дубль-защита, тот же email+вакансия за 24ч)** | Отдельное сообщение в error-баннере (не generic «something went wrong») — «You've already applied to this role recently.» — уточнить у Coder/PM текст при реализации.                                                                                          |
| **CV — неверный формат/размер**                              | Инлайн-ошибка под dropzone (`{{ fileError }}` паттерн), submit НЕ блокируется до попытки сабмита (ошибка на blur/change поля), но при submit с невалидным файлом — блокирует и фокусирует dropzone.                                                            |
| **Длинный заголовок вакансии**                               | `cc-display` уже `max-width: 18ch` — переносится на 2-3 строки, `clamp()` уменьшает размер на узких экранах, не обрезать/эллипсис.                                                                                                                             |
| **Длинное markdown-описание**                                | Обычный вертикальный скролл страницы; на ≥1000px форма sticky остаётся в вьюпорте (§6.6).                                                                                                                                                                      |
| **Много (10+) вакансий на `/careers`**                       | Простой grid без пагинации в v1 (YAGNI, продукт не оговаривал пагинацию — если станет проблемой, отдельная задача).                                                                                                                                            |
| **Overflow длинных технологий/названий в TechStackChips**    | `flex-wrap`, chip не сжимается — переносится на следующую строку.                                                                                                                                                                                              |

---

## 9. A11y (WCAG 2.2 AA)

- **Focus-visible:** единый паттерн на ВСЕХ интерактивных элементах (ссылки/кнопки/инпуты/
  чекбоксы burger) — `focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[3px] focus-visible:rounded-md`
  (= `.cc-focus-ring` из экспорта). НЕ полагаться на browser-default outline.
- **Target size:** см. §6.7 — минимум 44×44px на мобильных тач-целях; круглая VacancyCard-стрелка
  38px — decorative-only внутри крупной кликабельной карточки, зафиксировать как осознанное
  исключение (не случайный недосмотр).
- **Contrast:** primary-жёлтый на почти-чёрном фоне и domain-tag цвета (§3.3, oklch 80-84%
  lightness) на 12%-alpha подложке — визуально проходят 4.5:1 (текст)/3:1 (UI), но
  **проверить axe/Playwright contrast-check в Mode B** перед PASS-вердиктом (не полагаться
  только на визуальный осмотр).
- **Форма:**
  - каждый `<input>`/`<textarea>` — связанный `<label for>` (перенесено из экспорта — уже так).
  - error-состояние поля → `aria-invalid="true"` + `aria-describedby` на id error-хинта
    (**экспорт этого не делает** — DC-прототип упрощён, добавить в реальной реализации,
    обязательно).
  - required-поля — нативный `required` атрибут (AT читает без доп. работы) + визуальная `*`
    (`aria-hidden` на сам символ `*`, т.к. `required` уже озвучивается атрибутом).
  - error-баннер — `role="alert"` (перенести 1:1).
  - success-панель — `role="status"` (перенести 1:1).
  - CV-инпут — visually-hidden native `<input type=file>` + `<label>`-обёртка (паттерн
    экспорта, keyboard-accessible, перенести 1:1 — см. §2.4 `CvDropzone`).
- **Honeypot-поле:** `aria-hidden="true"` + `tabIndex={-1}` + `autoComplete="off"` + visually
  off-screen (НЕ `display:none`/`visibility:hidden` — некоторые screen-readers/ботов-детекторы
  ведут себя по-разному, но `display:none` безопасен для honeypot конкретно — human-AT не должен
  доходить до поля вообще, допустимо `display:none` здесь в отличие от обычных hidden-паттернов).
- **Terminal:** `role="img"` + описательный `aria-label` (не читать посимвольную анимацию) —
  перенести 1:1 из `Terminal.dc.html`.
- **Mobile nav disclosure:** `aria-expanded` на бургере (уже есть), `Escape` закрывает + focus
  return на бургер (добавить — нет в экспорте).
- **`prefers-reduced-motion`:** см. §5.1 — двойной guard (JS + CSS) чтобы контент не завис
  invisible при частичной поддержке.
- **Semantic HTML:** `<nav aria-label="Primary">` (уже в экспорте), `<main>` вокруг основного
  контента страниц careers/vacancy (в экспорте есть `<main>`, перенести), `<footer>`,
  `<article>` для markdown-описания вакансии.

---

## 10. Известные отклонения / проверки экспорта

- **Email-консистентность — ПРОВЕРЕНО, ЧИСТО.** Построчный ревью всех 7 `.dc.html`
  (`Home`/`Careers`/`Vacancy`/`Nav`/`Footer`/`Terminal`/`VacancyCard`) — единственный email
  везде **`hr@cheekycheese.tech`**. Никаких `careers@`/`contact@`/иных адресов не осталось
  (опасение из брифа про оборвавшуюся chat-сессию — не подтвердилось, экспорт финализирован
  корректно).
- **Текущий `apps/landing/app/routes/index.tsx`** (до этой задачи) использует
  `contact@cheekycheeseit.com` и `careers@cheekycheeseit.com` — **устаревшие адреса, ДОМЕН
  ДАЖЕ ДРУГОЙ** (`cheekycheeseit.com` vs `cheekycheese.tech`). Обязательно заменить на
  `hr@cheekycheese.tech` везде при реализации (это не «дополнительная» правка — часть скоупа
  задачи, продуктовая спека §2.1 явно требует единый адрес).
- **`careers-cards.png` в `screenshots/`** — устаревший кадр с фильтрами (до владельческой
  правки). См. §7 — использовать актуальные `careers-1440.png`/`careers-320.png` вместо него.
- **`02-home-full.png` в `screenshots/`** — пустой файл (сбой рендера в оборвавшейся сессии),
  игнорировать.
- **Scroll-reveal имеет above-the-fold исключение** (hero — `is-in` захардкожен, не ждёт
  scroll) — это НЕ баг, а намеренный паттерн, сохранить при портировании на Framer Motion
  (§5.1).
- **Vacancy meta-тег «4+ hrs overlap CET»** — специфика конкретной демо-вакансии (EU timezone),
  реальные вакансии могут иметь другой overlap/локацию — поле должно быть данными из БД
  (`vacancies.location` + дополнительное поле overlap, если продукт захочет — сейчас в схеме
  БД (`docs/superpowers/specs/2026-07-22-landing-refactor-design.md` §3.1) такого поля НЕТ,
  только `location` text — «4+ hrs overlap CET» тогда часть свободного текста `location` ИЛИ
  теряется. **Флаг для PM/владельца**: либо расширить `location` на реальных данных вручную
  (например «Remote · EU, 4+ hrs overlap CET» одной строкой), либо убрать этот 4-й meta-тег
  из вёрстки как demo-only деталь. Рекомендация дизайнера: оставить как часть `location`-строки
  (не заводить новую колонку — YAGNI, продукт явно отверг зарплатные/доп.поля).

---

## 11. Файловая структура (предложение, не догма)

```
apps/landing/app/
  components/
    ui/
      button.tsx          (existing, small size-scale patch)
      badge.tsx            (existing, unused in redesign)
      card.tsx             (NEW)
      tag.tsx               (NEW)
      chip.tsx              (NEW)
      input.tsx             (NEW)
      textarea.tsx          (NEW)
    brand-mark.tsx        (existing, reused)
    marketing/
      nav.tsx
      mobile-nav-menu.tsx
      footer.tsx
      terminal.tsx          (evolved from routes/index.tsx inline Terminal)
      section-eyebrow.tsx
      stat-strip.tsx
      case-study-card.tsx
      service-card.tsx
      process-step.tsx
      tech-stack-chips.tsx
      vacancy-card.tsx
      vacancy-apply-form.tsx
      cv-dropzone.tsx
      markdown-body.tsx
  routes/
    index.tsx              (REWRITE)
    careers.tsx             (NEW)
    careers.$slug.tsx       (NEW)
  styles/
    globals.css             (PATCH — §3.2 marketing computed vars, §3.3 tag tokens, §4 font-mono)
```

Зависимости к добавить в `apps/landing/package.json`: `@crm/shared` (workspace, для Zod-схем
формы), `zod`, `react-markdown`, `remark-gfm` (уже в `apps/web`, версии смотреть там для
консистентности monorepo). `server.proxy` в `vite.config.ts` для dev (`/api → localhost:3001`,
per продуктовая спека §2.3).

---

## 12. Чеклист для fidelity-приёмки (Mode B, после реализации)

- [ ] Все 3 роута рендерятся на 320/768/1024/1440 без горизонтального overflow.
- [ ] Единственный email на всём лендинге — `hr@cheekycheese.tech` (grep по `apps/landing/app`
      на `@cheekycheeseit.com`/`careers@`/`contact@` — должно быть 0 совпадений).
- [ ] Careers — БЕЗ фильтров/табов (продукт-решение 2026-07-23).
- [ ] Терминал — новые 3 сниппета (ai-platform/serve.py, edtech-platform/path.ts,
      commerce-storefront/checkout.ts), не старые.
- [ ] Форма отклика — все 4 состояния (default/submitting/success/error) визуально проверены.
- [ ] `prefers-reduced-motion` — scroll-reveal и terminal-typewriter корректно деградируют
      (контент виден сразу, не завис invisible).
- [ ] Touch targets ≥44px на мобильных интерактивных элементах (кроме осознанного исключения
      §6.7/§9).
- [ ] Focus-visible виден на Tab-обходе всех интерактивных элементов.
- [ ] Contrast-check (axe/Playwright) на domain-tag цветах и primary-на-чёрном.
- [ ] Diff со скриншотами §7 (spacing rhythm, иерархия, токены, плотность) — per
      `design-fidelity-review.md`.
