# landing-redesign — coder-ready spec (ui-ux-designer Mode E)

**Статус:** экспорт Claude Design реконсилирован в coder-spec 2026-07-23 (Mode E). **Обновлено
2026-07-24:** добавлен §M «Motion-спека v2» — владелец счёл §5 недостаточно живой («не вижу
активного применения анимаций»); §M расширяет §5 до scroll-progress-driven анимаций per-секция,
полного hover-языка на всех интерактивных элементах, брендированных page-transitions между
роутами и плавной in-page навигации. §5 остаётся в силе как база (typewriter-тайминги,
reduced-motion double-guard, hero above-the-fold правило) — §M его дополняет/апгрейдит явно
помеченными местами, не дублирует.
**Hotfix 2026-07-24 (тот же день, после деплоя v2):** владелец — «жёлтая анимация перехода очень
бьёт по глазам... у некоторых может вызвать эпилепсию. Позаботься, чтобы ВСЕ анимации были
плавными» + 2 визуальных бага со скриншотов (process connector-line режет текст лейблов,
vacancy-card hover «прыгает»). §M.3 **переработан** — полноэкранная жёлтая заливка заменена на
люминанс-безопасный тёмный scrim + тонкую жёлтую ведущую кромку (WCAG 2.3.1 расчёт внутри), везде
в §M.1/M.2/M.3/M.4 длительности/easing смягчены (см. пометки «HOTFIX» по тексту), + geometry/
stacking-фиксы для connector-line и `will-change` фикс для card-hover jump. Оркестрационная
механика page-transition (module-singleton, `onBeforeNavigate`/`onResolved`, focus-management) —
**не менялась**, только визуальный слой и тайминги.
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

> **v2 (2026-07-24):** §5.1's `Reveal` (one-shot `whileInView`) **апгрейднут** в §M.1 до
> progress-linked scroll-reveal (не one-shot). Terminal-typewriter тайминги, prerender-safety
> механика и double-guard reduced-motion ниже — **остаются канон**, §M на них ссылается, не
> переопределяет. Hover-язык (ранее только кнопки/чипы) — полностью покрыт в §M.2. Page-transitions
> и in-page smooth-scroll — новые темы, §M.3/§M.4.

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

---

## M. Motion-спека v2 (2026-07-24, дополняет §5)

**Запрос владельца (дословно):** «Я не вижу активного применения анимаций и какой-либо фантазии.
Добавь каждому блоку жизни; на скролл — интересная анимация, зависящая от текущего положения
скролла; при наведении на элементы нет анимаций. Придумай и имплементируй page transition
анимации между всеми страницами (не просто перерендер контента, а креативный переход)... Лендинг
должен ощущаться живым и откликаться на действия пользователя красиво.» + доп. владельца (через
координатора, тем же днём): скролл при навигации к якорям/между страницами должен быть **плавным**,
не моментальным.

**Референс текущего состояния** (для контекста, живой прод 2026-07-24): hero/терминал/careers уже
соответствуют §1-§9 визуально (тёмный фон, жёлтый акцент, терминал с живым тайпрайтером) — но
анимация ограничена one-shot `whileInView`-reveal + точечными hover на кнопках/картах. Ниже —
что добавляется/апгрейдится, БЕЗ переработки визуального языка §0-§9 (тон/токены/раскладка не
меняются, меняется только _движение_).

**Область действия §M:** только `apps/landing/**`. `apps/web` (CRM) не затрагивается — это
отдельный workspace/дизайн-язык (см. §2.3).

**Жёсткие ограничения (владелец, не пересматриваются):**

- Lighthouse CI ≥90 медиана **mobile** — не регрессирует. Всё ниже — `transform`/`opacity` (+
  `translateX`/`translateY`/`scaleX`/`scaleY`) на GPU-composited слоях, НЕ `clip-path`/`width`/
  `height`/`top`/`left` (layout-трэш) — см. §M.3, где это явно было решающим фактором дизайна
  page-transition. Scroll-listener'ы — `passive: true`. Никаких новых тяжёлых зависимостей
  (`framer-motion` уже есть, версия не меняется).
- `prefers-reduced-motion: reduce` — полный выключатель декоративного: scroll-linked эффекты
  рендерятся сразу в конечном состоянии (без анимации выезда/parallax), page-transition = мгновенный
  свап (без wipe/crossfade), smooth-scroll = мгновенный `scrollTo` без твина. Единый флаг —
  `useReducedMotion()` (компоненты) / `window.matchMedia('(prefers-reduced-motion: reduce)').matches`
  (модули вне React-дерева, напр. `lib/page-transition.ts`).
- Hero above-the-fold контракт (§5.1) и prerender-hydration fix (Terminal, PR #398) — **не
  трогать**: hero по-прежнему виден мгновенно без entrance-анимации; связка `terminalHasMountedOnce`
  и `wasRootPrerendered()` внутри Terminal остаётся как есть (§M.1 добавляет terminal-контейнеру
  ТОЛЬКО scroll-linked exit-parallax при скролле мимо hero — сам typewriter внутри не трогается,
  см. §M.1.2 — важное обоснование, почему буквальная идея «скролл доскролливает код» отклонена).
- Тач-девайсы: hover-эффекты либо не имеют смысла без tap-эквивалента (у нас все hover-цели уже
  и так активируются по tap/focus — CSS `:hover`/`:focus-visible` дают одинаковый визуальный
  результат на границе тач-без-hover; ничего декоративного не завязано ИСКЛЮЧИТЕЛЬНО на mouseenter
  кроме case-study/process-card, которые намеренно БЕЗ hover, см. §M.2).

---

### M.0 Motion-токены (единый язык движения)

Новый файл `apps/landing/app/lib/motion.ts` — именованные константы вместо разбросанных
inline-чисел (сейчас `duration: 0.7`, `ease: [0.2,0.6,0.2,1]` и т.д. захардкожены по месту в
`routes/index.tsx`/`nav.tsx` — оставить как есть там, где это CSS Tailwind-transition, но ВСЕ
НОВЫЕ JS-driven (Framer Motion `useTransform`/`animate()`) значения — только через этот модуль,
чтобы scroll-эффекты/page-transition/smooth-scroll не разъезжались по ощущению):

```ts
// apps/landing/app/lib/motion.ts
export const EASE_STANDARD = [0.2, 0.6, 0.2, 1] as const // сигнатурная кривая §5.1 Reveal — ТОЛЬКО для scroll-position-driven M.1 (не time-based, флеш-риска нет там по конструкции)
// HOTFIX 2026-07-24: EASE_EXIT УДАЛЁН (был [0.4,0,1,1] — жёсткий финиш "на полной скорости",
// часть жалобы "очень быстрая"). EASE_SOFT — новый ЕДИНСТВЕННЫЙ default для ВСЕХ time-based
// (duration+ease) JS-анимаций (page-transition §M.3, smooth-scroll §M.4). Симметричная
// easeInOutCubic — мягкий старт И мягкий финиш, никакого рывка на старте/резкой остановки.
export const EASE_SOFT = [0.65, 0, 0.35, 1] as const

export const DUR_REVEAL = 0.7 // section scroll-reveal (было в Reveal, не меняется)
export const DUR_SMOOTH_SCROLL = 0.6 // in-page якорный скролл (§M.4) — уже мягкий, ease меняется на EASE_SOFT, duration не меняется
// HOTFIX 2026-07-24 — page-transition duration UP (владелец: "вверх, ориентир 350-500мс"), плюс
// переименовано под новую scrim+caret-line механику (§M.3) — это больше не "полоса-заливка":
export const DUR_SCRIM_IN = 0.23 // тёмный scrim проявляется (было DUR_WIPE_IN=0.2 сплошной жёлтой заливки)
export const DUR_SCRIM_OUT = 0.27 // scrim исчезает (было DUR_WIPE_OUT=0.26) — итого 500мс, верх диапазона 350-500
export const DUR_CARET_SWEEP = 0.42 // тонкая жёлтая кромка пересекает экран ОДИН раз, длиннее scrim-фаз — не "мелькает"
export const DUR_LIGHT_TRANSITION = 0.26 // page-transition облегчённый back-вариант (было 0.18 — тоже "очень быстро")
```

Значения hover/press (CSS Tailwind-transitions на кнопках/картах) **токенами не становятся** —
это `duration-200`/`duration-300` classes; **HOTFIX**: явно фиксируем `ease-out` Tailwind-класс
(`cubic-bezier(0,0,0.2,1)`, строго замедляющаяся, без начального разгона) вместо implicit
Tailwind-default (`cubic-bezier(0.4,0,0.2,1)`, у которого есть лёгкий разгон перед торможением) —
см. правку §M.2 таблицы ниже. `duration-200`/`duration-300` classes уже консистентны между
`button.tsx`/`card.tsx`/`chip.tsx`; §M.2 явно называет duration-класс по месту, без изобретения
параллельной системы для того, что уже единообразно.

---

### M.1 Scroll-driven анимация per-секция (progress-linked, НЕ one-shot)

#### M.1.0 Принцип — апгрейд `Reveal` → `ScrollReveal`

Текущий `Reveal` (`routes/index.tsx:37-59`) — `whileInView`+`viewport={{once:true}}`: спрингом
играет ОДИН раз при пересечении 8%-порога и дальше не реагирует на скролл. Владелец просит
«анимация, зависящая от **текущего положения** скролла» — это принципиально другой примитив:
`useScroll`+`useTransform`, где opacity/y — **motion values, привязанные к scroll-прогрессу**, не
к discrete triggers. Заменить `Reveal` на `ScrollReveal` во ВСЕХ местах текущего использования
(`routes/index.tsx` — 11 вызовов) с этим паттерном:

```tsx
function ScrollReveal({
  children,
  className,
  y = 26,
}: {
  children: ReactNode
  className?: string
  y?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.6'] })
  // 3-точечная кривая имитирует ease-out БЕЗ time-based easing (progress не время) —
  // резкое замедление к концу диапазона, вместо линейного заезда.
  const opacity = useTransform(scrollYProgress, [0, 1], [0, 1])
  const yMotion = useTransform(scrollYProgress, [0, 0.6, 1], [y, y * 0.22, 0])
  if (reduced)
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    )
  return (
    <motion.div ref={ref} className={className} style={{ opacity, y: yMotion }}>
      {children}
    </motion.div>
  )
}
```

- `offset: ['start end', 'start 0.6']` (Framer Motion `useScroll` intersection-синтаксис,
  проверено по актуальной документации): прогресс 0 когда верх секции касается низа вьюпорта
  (секция только показалась снизу), прогресс 1 когда верх секции доходит до 60% высоты вьюпорта
  сверху (комфортно видна, не обязательно центр — раньше «доезжает», чтобы не тянуть анимацию до
  середины экрана на длинных секциях).
- **Без `once`** — намеренно: если пользователь скроллит вверх обратно, секция плавно уходит в
  исходное состояние и при повторном скролле вниз — снова появляется. Это ТОЧНО то, что просит
  формулировка «зависящая от текущего положения скролла» (не «play once and forget»). `useTransform`
  по умолчанию clamp'ит на границах диапазона — вне `[0,1]` progress значения не улетают за
  `[0, y]`/`[0,1]`.
- Delay-параметр текущего `Reveal` (`delay={i * 0.05}` на case-study/service карточках-в-цикле) —
  заменяется на **разный offset старта per-индекс** (не time-delay, т.к. это больше не time-based
  анимация): `offset: ['start end', \`start ${0.6 + i \* 0.05}\`]` — карточки с большим индексом
  «дозревают» чуть позже по scroll-прогрессу, сохраняя визуальный stagger без таймера.
- Секции, где `ScrollReveal` применяется как есть (без доп. правок ниже) — About (оба столбца +
  stat-strip), Services grid (сохранить index-based offset stagger), Tech stack, Careers teaser
  (заголовок + карточки), Contact CTA. Hero — **исключение, без ScrollReveal** (§5.1 контракт).

#### M.1.1 Таблица per-секция (сигнатурные/особые случаи)

| Секция (id)                                   | Target / offset                                                                                              | Анимируемое                                                                                                                                                                                             | Значения                                                                                                                               | Зачем именно так                                                                                                                                                         | Reduced-motion                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Hero — фон-глоу** (`#hero`)                 | `target=heroRef`, `offset: ['start start', 'end start']`                                                     | `translateY` радиального glow-слоя (`aria-hidden` div, `routes/index.tsx:78-81`)                                                                                                                        | `useTransform(p, [0,1], [0, 60])` px — глоу «отстаёт», уходит медленнее контента                                                       | Единственный ambient-параллакс, разрешённый в hero (не entrance — hero и так виден сразу; это **exit**-параллакс по мере скролла ВНИЗ)                                   | Статичный glow, без translate                                                                                            |
| **Hero — терминал «докинг»**                  | `target=heroRef`, `offset: ['start start', 'end start']`                                                     | `translateY` + `scale` контейнера `<Terminal/>` (обёртка `div.min-w-0` в hero-гриде)                                                                                                                    | `translateY: useTransform(p,[0,1],[0,-36])`, `scale: useTransform(p,[0,1],[1,0.965])`, `opacity: useTransform(p,[0,0.7,1],[1,1,0.85])` | «Фирменная» деталь для терминала (владелец просил что-то фирменное). Терминал слегка «уходит вглубь» при скролле — эффект глубины, БЕЗ трогания typewriter-логики внутри | Без transform, `opacity` фиксирован на 1                                                                                 |
| **How we work — connector-line** (`#process`) | `target=` grid-обёртка 4 шагов, `offset: ['start end', 'end 0.4']`, **только `≥768px`** (`md:`)              | НОВЫЙ элемент — тонкая горизонтальная линия (`absolute`, `top-[60px]` — **HOTFIX, было `top-[34px]`, см. M.1.1a**, `h-px bg-primary/50`, `left-[12.5%] right-[12.5%]`, `transform-origin: left`, `z-0`) | `scaleX: useTransform(p, [0,1], [0,1])`                                                                                                | Сигнатурная деталь «Four steps» — линия «дорисовывается» слева направо по мере скролла ряда, буквально связывая шаги 1→4                                                 | `scaleX: 1` сразу (линия статично протянута), либо `hidden` до `md:` (мобильный грид и так 1-колоночный, линия не нужна) |
| **Selected work — metric-lag** (`#work`)      | Внутри каждой `ScrollReveal`-обёртки карточки: metrics-грид получает СВОЙ `useTransform` со сдвинутым входом | `opacity`/`translateY` grid с 3 метриками (`case-study-card.tsx:37-47`)                                                                                                                                 | `useTransform(p, [0.15, 1], [0, 1])` (входит на 15% позже основного контента карточки, `y: [14,0]`)                                    | Метрики «догоняют» текст с лёгким лагом — depth cue внутри карточки, не просто одновременный fade                                                                        | Без лага — рендерится вместе с остальным содержимым карточки                                                             |
| **Tech stack — chip-волна**                   | `ScrollReveal` на обёртке `<TechStackChips/>` + per-chip `useTransform` с `i * 0.02` доп. входным сдвигом    | `opacity`/`translateY` на каждом `<Chip>`                                                                                                                                                               | `y: [10,0]`, вход растянут на первые 40% диапазона секции (`i / stack.length * 0.4`)                                                   | Лёгкая «волна» по чипам вместо одновременного появления всех 18 — премиум-деталь без карусели эффектов (один паттерн, не новый язык)                                     | Все чипы видны сразу, без волны                                                                                          |

#### M.1.1a HOTFIX (2026-07-24) — connector-line пересекает текст лейблов

**Баг (скриншот владельца):** жёлтая линия проходит СКВОЗЬ подписи шагов «01 / Discovery»,
«02 / Build»... — читается как зачёркивание. Реализация (`process-steps-grid.tsx`, живой прод) —
две ПРИЧИНЫ, обе нужно фиксить, они не взаимозаменяемы:

1. **Root cause — CSS stacking order, не геометрия.** Линия — `position: absolute` (`className`
   включает `absolute`). Контейнер с 4 карточками (`<div className="grid grid-cols-1 gap-5
md:grid-cols-4 md:gap-7">`) — БЕЗ `position` (`static`, дефолт), сами `Card` — тоже `static`. По
   CSS 2.1 stacking order: **позиционированные элементы (даже `z-index:auto`) всегда красятся
   ПОВЕРХ non-positioned in-flow контента того же stacking-контекста, НЕЗАВИСИМО от DOM-порядка.**
   Линия идёт ПЕРВОЙ в DOM (значит, по «наивной» логике должна быть «под» картой), но т.к. она
   `absolute`, а грид с картами — нет, линия красится НАД непрозрачным `bg-card` карточек и их
   текстом, а не под ним — комментарий в коде («cards paint over it») был верным по замыслу, но не
   реализован технически. **Фикс:** добавить `relative` на грид-обёртку (`<div className="relative
grid grid-cols-1 gap-5 md:grid-cols-4 md:gap-7">`) — переводит её в тот же positioning-tier, что и
   линия; т.к. грид идёт ВТОРЫМ в DOM, при равном (`auto`) z-index он теперь красится ПОВЕРХ линии,
   как и задумывалось (видна только в 28px-зазорах между карточками). Явно зафиксировать z-index
   для однозначности (не полагаться на DOM-order tie-break): линия — `z-0`, обёртка карточек —
   `relative z-10`.
2. **Geometry — дополнительная защита, не единственная линия обороны.** Пока `ScrollReveal`
   (обёртка ВСЕЙ секции process, см. M.1.0) проигрывает fade-in (`opacity` растёт 0→1), карточки
   ТОЖЕ полупрозрачны — непрозрачный-фон-перекрывает-линию перестаёт быть 100%-гарантией в этот
   момент (полупрозрачная карта не полностью скрывает то, что под ней). Поэтому геометрия ДОЛЖНА
   сама по себе не пересекать текст, а не полагаться исключительно на occlusion. `ProcessStep`
   (`process-step.tsx`): `Card` `p-[26px]` → `step.stepNum` mono-лейбл начинается на y≈26px,
   занимает line-box ≈20px (итого до y≈46px), затем `mb-5`=20px пустого места до заголовка `h3`
   (старт y≈66px). **Безопасная зона — y ∈ [46px, 66px]**, где НЕТ текста ни лейбла, ни заголовка.
   `top-[34px]` (старое значение) сидел ПРЯМО в середине лейбла — отсюда «зачёркивание». Новое
   значение — **`top-[60px]`** (внутри безопасной зоны, ближе к заголовку — читается как «линия
   проходит под номером-лейблом, над заголовком»). Значение приблизительное (точные line-box
   метрики зависят от font-hinting браузера) — Coder визуально сверяет на реальном рендере,
   допустима ручная коррекция ±4px, лишь бы линия НЕ пересекала ни один глиф текста ни на одном
   шаге (все 4 карточки имеют одинаковую структуру/паддинги — единое значение `top` подходит всем).

Итог: `relative z-10` на грид-обёртке + `z-0` на линии (СТРУКТУРНЫЙ фикс, устраняет причину) +
`top-[60px]` вместо `top-[34px]` (GEOMETRY, defense-in-depth на время fade-in/будущих вариантов
card). Оба применяются вместе, не по отдельности.

#### M.1.2 Отклонённая идея — «скролл доскролливает код» (обоснование)

Владелец предложил (как вариант, «например»): scroll-прогресс управляет посимвольным тайпрайтером
терминала. **Отклонено осознанно**, не пропущено: (1) hero-контракт §5.1 требует, чтобы терминал
был содержательно виден СРАЗУ при загрузке, до любого скролла — если тайпинг завязан на scroll-
прогресс, первый экран показывает ПУСТОЙ терминал, пока юзер не начал скроллить, что хуже текущего
состояния; (2) прямо ломает prerender-hydration fix (PR #398, `terminalHasMountedOnce`/
`wasRootPrerendered`) — та логика полагается на независимый от скролла таймер, стартующий на mount;
переход на scroll-scrub означает переписывать этот fix заново, между делом теряя его гарантию
«без flash при первом заходе»; (3) смешивает две разные метафоры — «live код, который печатается
сам» (текущий, statusbar `live`+пульсирующая точка подтверждает это) vs «код, который скраббится
как видео-таймлайн скроллом» — конфликтующие сигналы того, ЧТО терминал «из себя представляет».
**Принятая альтернатива** — terminal-«докинг» из таблицы M.1.1 выше: typewriter остаётся
полностью автономным (как сейчас), но КОНТЕЙНЕР терминала получает scroll-linked parallax/scale
при скролле мимо hero — тоже «фирменно», не конфликтует ни с одним существующим контрактом.

---

### M.2 Hover-язык (ВСЕ интерактивные элементы)

Принцип (`make-interfaces-feel-better`): hover — **CSS-transition**, не Framer Motion (ретаргетится
при смене намерения на лету, дешевле); `transition-property` — явный список, никогда `transition: all`
(уже соблюдается в существующем коде — сохранить паттерн). Hit-area ≥40×40px (мобайл — см. §6.7,
≥44px). Ниже — таблица per-элемент; «уже есть» = зафиксировать текущее поведение как канон (не
менять), «НОВОЕ» = добавить.

**HOTFIX 2026-07-24 (smoothness-пass, весь список ниже):** добавить явный Tailwind-класс
`ease-out` (`cubic-bezier(0,0,0.2,1)`, строго замедляющаяся) на КАЖДЫЙ `transition-[...]` из
таблицы ниже — раньше полагались на implicit Tailwind default (`cubic-bezier(0.4,0,0.2,1)`, есть
небольшой разгон перед торможением). Минимум длительности проверен — **все ≥150мс** (владелец:
«hover ≥150мс»); единственное значение РОВНО на границе (`Input` 150мс) — поднято до 180мс с
запасом, см. строку ниже.

| Элемент                                               | Статус          | Hover/focus состояние                                                                                                                                                                        | `transition-property` / duration                                                                          | Touch/reduced-motion                                                                                                                         |
| ----------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button` `variant="default"`                          | Уже есть        | Фон светлеет + `box-shadow` glow + иконка-стрелка `translateX(3px)` + `active:translateY(1px)`                                                                                               | `background-color, border-color, box-shadow, transform` / 200ms                                           | Tap = тот же visual (CSS `:active`); нет reduced-motion трогания (не декоративно-развлекательное, функциональный feedback)                   |
| `Button` `variant="outline"`                          | Уже есть        | Бордер темнее + едва заметный фон-тинт + `active:translateY(1px)`                                                                                                                            | то же / 200ms                                                                                             | То же                                                                                                                                        |
| **Nav-ссылки desktop** (`nav.tsx` `NAV_LINK_CLASS`)   | НОВОЕ           | Сейчас только `text-foreground/72 → text-foreground`. Добавить underline-draw: `::after` `absolute -bottom-1 left-0 h-px w-full bg-primary scale-x-0 origin-left`, `group-hover:scale-x-100` | `transform` (scaleX) / 200ms, `transition-timing-function` Tailwind default                               | Focus-visible показывает тот же underline (не только outline-ring) — добавить `focus-visible:` вариант тех же классов                        |
| **Footer-ссылки** (`FOOTER_LINK_CLASS`)               | НОВОЕ           | Тот же underline-draw паттерн, что и nav — единый язык (не два разных hover-стиля для одинаковой семантики «текстовая ссылка»)                                                               | то же / 200ms                                                                                             | Focus-visible — так же                                                                                                                       |
| **Burger-кнопка** (закрыта, idle hover)               | НОВОЕ           | `border-border` → `border-[color-mix(...,var(--foreground)_30%,transparent)]` (тот же токен, что hover outline-button §2.3) — едва заметный, не мигающий                                     | `border-color` / 200ms                                                                                    | На тач — нет hover-состояния, только focus-visible ring (уже есть)                                                                           |
| `Card` `hover` (ServiceCard/VacancyCard)              | Уже есть        | `-translate-y-[3px]` + бордер-тинт primary/40                                                                                                                                                | `border-color, transform, background` `ease-out` / 300ms                                                  | Tap на VacancyCard = переход по ссылке, hover-lift не критичен, но CSS всё равно применяется на touchstart в некоторых браузерах — безвредно |
| **`Card` `hover` + `VacancyCard` — HOTFIX «прыгает»** | БАГФИКС         | См. M.2a ниже — диагноз + `will-change-transform` фикс (НЕ визуальная правка, та же анимация из строки выше, просто без первого-кадра «скачка»)                                              | —                                                                                                         | —                                                                                                                                            |
| `Card` (ServiceCard) — **добавить** glow              | НОВОЕ           | При hover — тот же `box-shadow` glow-паттерн, что у primary-кнопки (`var(--marketing-glow)`), едва заметный, `0 20px 60px -30px`                                                             | `box-shadow` (добавить в существующий `transition-[...]` список) `ease-out` / 300ms                       | —                                                                                                                                            |
| **VacancyCard — стрелка-кружок**                      | Уже есть        | `group-hover:translate-x-[2px]`. **Добавить**: `group-hover:bg-primary/10` (лёгкая заливка круга) для более явного «эта карточка кликабельна»                                                | `transform, background-color` `ease-out` / 200ms                                                          | —                                                                                                                                            |
| `Chip` (tech-stack, hero eyebrow)                     | Уже есть        | Бордер-тинт + текст ярче. **Добавить** `hover:-translate-y-px` (микро-лифт 1px — едва заметно, тактильно, не «прыгает»)                                                                      | `border-color, color, transform` (добавить `transform` в список) `ease-out` / 200ms                       | Без transform на touch (CSS `:hover` не триггерится длительно на тач — безвредно оставить)                                                   |
| Форма — `Input`/`Textarea`                            | НОВОЕ           | Pre-focus hover: `border-[color-mix(...,var(--foreground)_20%,transparent)]` (легче текущего focus-бордера, отличимо от focus-visible ring)                                                  | `border-color` `ease-out` / **180ms** (HOTFIX, было 150мс — ровно на границе «≥150мс», поднято с запасом) | Focus-visible ring (§9) — не меняется, hover — доп. слой ДО фокуса                                                                           |
| CV dropzone drag-over                                 | Уже есть (§5.1) | Без изменений — chистый CSS-transition, канон                                                                                                                                                | `border-color, background` / 200ms                                                                        | —                                                                                                                                            |
| Nav mobile-меню ссылки                                | Уже есть        | Тот же `NAV_LINK_CLASS` (без underline-draw на мобиле — тач не наводит, `hover:` классы там decorative-noop, безвредны)                                                                      | —                                                                                                         | —                                                                                                                                            |

**Элементы БЕЗ hover (осознанно, не забыто):**

- `CaseStudyCard`, `ProcessStep` — НЕ кликабельны (информационные карточки). Hover-реакция на
  некликабельном блоке — false affordance (`frontend-design-direction` anti-pattern: не создавать
  ложных сигналов интерактивности). «Жизнь» этим карточкам дают M.1 scroll-эффекты (metric-lag,
  connector-line), не hover.
- `Tag` (domain badge) — статичный лейбл-классификатор, не интерактивен нигде на лендинге →
  без hover.
- `SectionEyebrow`, `StatStrip`-числа, terminal window-chrome точки (macOS-style) — декоративные/
  информационные, без hover.

#### M.2a HOTFIX (2026-07-24) — vacancy-card hover «прыгает»

**Диагноз.** На Home `<CareersTeaser>` целиком обёрнут в ОДИН `<ScrollReveal>`
(`routes/index.tsx`) — `motion.div`, у которого `style={{opacity, y: yMotion}}` ВСЕГДА активен
(это `MotionValue`, привязанные к `scrollYProgress`, — не снимаются после «доезда», просто
`yMotion` становится constant `0`). Framer постоянно держит на этом `motion.div` inline
`transform`/`opacity`, что per CSS-спеке создаёт **новый stacking/compositing context** для ВСЕГО
поддерева (это относится и к `ServiceCard`, обёрнутому per-card в `ScrollReveal` тем же образом).
`VacancyCard`/`Card hover` — ВЛОЖЕННЫЙ элемент, у которого СВОЙ transform включается только на
`:hover` (Tailwind `hover:-translate-y-[3px]`, CSS-driven, отдельно от родителя). Пока курсор не
наведён, браузер обычно НЕ промоутит этот вложенный элемент на отдельный composite-layer заранее
(нет причины — его transform неактивен) — первый `:hover` резко создаёт для него layer «на лету»
(layer promotion), и это ПЕРВЫЙ кадр рендера в новый layer иногда даёт видимый микро-скачок/
subpixel-снэп — классический, задокументированный Chrome/Framer-паттерн для вложенного transform
внутри уже-transform'нутого/opacity'нутого предка. **Проверено, что НЕ является причиной:** (а) не
конфликт «два transform на одном узле» — `ScrollReveal`-обёртка и `VacancyCard`/`Card` это РАЗНЫЕ
DOM-узлы (обёртка НЕ применяется поэлементно к каждой карточке в тизере, см. M.1.0 «Careers teaser
— заголовок + карточки» единым блоком); (б) не `border-width` — hover меняет только
`border-color`, layout не сдвигается. **Диагностическая проверка (для Coder/QA):** баг ДОЛЖЕН
воспроизводиться на Home (тизер под `ScrollReveal`) и НЕ воспроизводиться на `/careers`
(`CareersList` рендерится БЕЗ какой-либо `ScrollReveal`-обёртки, `routes/careers.tsx`) — если
разница подтверждается, диагноз верен; если баг ОДИНАКОВО проявляется на `/careers` тоже — это
сигнал копать глубже (не просто layer-promotion), эскалировать отдельным `.blocked.md`.

**Фикс.** Пред-промоутить сам ховерящийся элемент в свой composite-layer ЗАРАНЕЕ (`will-change`)
— это ИМЕННО тот санкционированный `make-interfaces-feel-better` кейс («Use `will-change` only for
first-frame stutter on compositor-friendly properties»), не `will-change: all`:

- `apps/landing/app/components/ui/card.tsx` — на `hover`-варианте класс-списка добавить
  `will-change-transform` (только когда `hover` prop `true`, статичные карточки без hover его не
  получают — не нужно, транзишена нет).
- `apps/landing/app/components/marketing/vacancy-card.tsx` — на `<Link>` (сам hover-элемент)
  добавить `will-change-transform` в className (VacancyCard всегда кликабельна/hover-активна,
  безусловно).

**Архитектурное правило (закрепить на будущее, не только для этого бага):** hover-transform и
scroll-reveal-transform НИКОГДА не применяются inline-стилем на ОДИН И ТОТ ЖЕ DOM-узел — уже
верно по структуре (`ScrollReveal` — обёртка, hover — на вложенном интерактивном элементе), но
теперь явно задокументировано как требование для ЛЮБОГО нового hover+reveal компонента, не только
существующих.

---

### M.3 Page-transitions (TanStack Router + Framer Motion)

> **SUPERSEDED 2026-07-25 (§M v3.1/§M v3.2).** Владелец повторно отверг результат этого раздела:
> «контрастирует с общим освещением сайта и бьёт по глазам» (про scrim+caret-line ниже) — весь
> механизм scrim+caret-line (включая люминанс-расчёт §M.3.0) **удалён**, заменён на «мягкий лифт»
> (lift cross-fade, БЕЗ каких-либо цветных/тёмных оверлеев) + отдельный shared-element FLIP-морф
> заголовка на `/careers ↔ /careers/:slug`. Раздел ниже оставлен как historical record (объясняет,
> почему первая попытка "спрятать свап под непрозрачным слоем" вообще была выбрана и какие
> WCAG-расчёты для неё делались) — **для реализации использовать ТОЛЬКО §M v3**, не этот раздел.
>
> **HOTFIX 2026-07-24.** Владелец (дословно, про задеплоенную v1 этой секции): «Жёлтая анимация
> перехода очень бьёт по глазам — очень быстрая, у некоторых может вызвать эпилепсию. Позаботься,
> чтобы ВСЕ анимации были плавными». Полноэкранная `bg-primary`-заливка **удалена полностью** —
> заменена на люминанс-безопасный дизайн ниже. Оркестрация (module-singleton,
> `onBeforeNavigate`/`onResolved`, focus-management, prerender-safety) — **не изменилась**, шаги
> 1-4/8-9 актуальны как были, поменялись только шаги 5-6 (визуал) и таблица значений.

**Выбранная механика (основной вариант) — «каретка», не заливка: тёмный scrim + тонкая жёлтая
ведущая кромка.** Два независимых слоя вместо одной сплошной полосы:

1. **Scrim** (`fixed inset-0`, `background: var(--background)` — ТОТ ЖЕ токен, что фон страницы,
   не новый цвет) — плавно проявляется через `opacity` (0→1) и плавно исчезает (1→0). Функция —
   технически скрыть мгновенный `Outlet`-свап (как раньше), но т.к. цвет = «то же самое тёмное»,
   что уже занимает бо́льшую часть экрана в этом дизайне (см. расчёт ниже) — люминанс-скачок
   минимален независимо от скорости/частоты показа.
2. **Caret-line** — тонкая (`~3px` core + `~56px` мягкий gradient-затухание по краям, ИТОГО
   ~64px полоса) `bg-primary` кромка, пересекающая экран ОДИН раз через `translateX` (не
   `clip-path`, hard-constraint transform/opacity сохраняется), поверх УЖЕ затемнённого scrim'а
   (не поверх яркого живого контента) — визуально читается как «курсор терминала печатает новую
   страницу», ровно та метафора, которую просил владелец, но теперь узкая полоска, а не заливка на
   весь экран (`≤5-10%` площади вьюпорта — целевое требование хотфикса, расчёт ниже подтверждает
   фактическую площадь).

```tsx
// apps/landing/app/components/marketing/page-transition-overlay.tsx (НОВЫЙ)
// Слой 1 — scrim: fixed inset-0, z-[999], pointer-events-none, background: var(--background),
// opacity управляется animate(). Слой 2 — caret-line: fixed inset-y-0, ~64px шириной, gradient
// (transparent -> primary -> transparent), z-[1000] (поверх scrim), pointer-events-none,
// translateX управляется animate(). Оба — ТОЛЬКО transform/opacity, ничего layout-триггерящего.
```

#### M.3.0 HOTFIX — WCAG 2.3.1 расчёт (люминанс-безопасность)

> **SUPERSEDED 2026-07-25.** §M v3.1 (lift) не вводит ни одного нового цветного/тёмного слоя —
> анимируются `opacity`/`translateY` самого контента страницы, поэтому весь расчёт ниже неприменим
> к новой механике (см. compliance-заметку в §M v3.1). Оставлено для истории — показывает, почему
> версия co scrim/caret вообще считалась «безопасной», прежде чем владелец её отверг по subjective
> ощущению («бьёт по глазам»), не по факту нарушения формального порога.

Формальная проверка General Flash Threshold (WCAG 2.3.1): нарушение требует ОДНОВРЕМЕННО (И) —
≥3 вспышки/сек, (И) пара противоположных изменений относительной люминанции ≥10% полной шкалы, (И)
площадь ≥25% зрительного поля 10°. Не выполнено хотя бы одно условие → порог не достигнут.

Относительная люминанция (формула WCAG, через OKLCH → linear sRGB → `0.2126R+0.7152G+0.0722B`,
токены `apps/landing/app/styles/globals.css` `.dark`):

| Токен                        | oklch                   | Относительная люминанция | Δ vs `--background`              |
| ---------------------------- | ----------------------- | ------------------------ | -------------------------------- |
| `--background`               | `oklch(0.08 0 0)`       | 0.00051                  | —                                |
| `--card`                     | `oklch(0.12 0 0)`       | 0.00173                  | 0.1% (незначимо)                 |
| `--primary` (старый wipe)    | `oklch(0.84 .183 85.3)` | 0.58655                  | **58.6%** — почти 6× порог `10%` |
| `--foreground` (белый текст) | `oklch(0.97 0 0)`       | 0.91267                  | 91.2% (справочно, см. ниже)      |

**Старый дизайн (удалён):** полноэкранная `--primary`-заливка поверх `--background` — Δ=58.6%
относительной люминанции, площадь 100% вьюпорта (≫25%) — при единичном срабатывании технически НЕ
нарушает букву правила (нужно ≥3 раз/сек), но при быстрой повторной навигации (двойной клик,
серия back/forward) МОГ бы попасть под порог — недопустимый риск независимо от частоты, вот
почему хотфикс переделывает дизайн, а не просто "полагается" на то, что 3 повтора/сек маловероятны.

**Новый дизайн:**

- **Scrim-фаза:** `--background` → `--background`, тот же токен, Δ≈0% — НЕ проходит критерий
  «≥10%» вообще, **независимо от площади и частоты повторов**. (Честная оговорка: scrim ТАКЖЕ
  временно перекрывает видимый в моменте белый текст/жёлтые акценты страницы, чья собственная
  люминанция выше — но эти элементы занимают явное меньшинство площади вьюпорта в этом
  тёмном/плотном дизайне, в отличие от старой ПОЛНОЭКРАННОЙ заливки, которая ГАРАНТИРОВАННО была
  100% площади на пиковом высоком Δ; для дополнительной мягкости — см. пик opacity ниже.) Пик
  opacity scrim'а — **0.94**, не 1.0 — намеренно неполное покрытие, чтобы переход читался как
  ПОСТЕПЕННОЕ затемнение (rate-of-change ниже), а не жёсткий бинарный cut даже там, где Δ и так
  мал.
- **Caret-line фаза:** `transparent → primary → transparent` (57.9% Δ на пиковом узком участке,
  фактически тот же цвет, что и раньше) — НО площадь: core+glow ≈64px на эталонном 1440px
  вьюпорте = **4.4% ширины** (`64/1440`), полная высота — что кратно меньше `25%` критерия
  зрительного поля (даже на узком 320px мобильном вьюпорте `64/320`=20% — всё ещё ниже 25%, и это
  worst-case, десктоп — типичный случай — сильно ниже). Линия НЕ проходит критерий «≥25% площади»
  → не квалифицируется как flash-элемент. Плюс: сама кромка появляется как ГРАДИЕНТ (мягкое
  нарастание/спад яркости В ПРОСТРАНСТВЕ), а не блок с резким краем — дополнительно снижает rate
  восприятия даже локально.
- **Вывод:** ни один из двух слоёв по отдельности НЕ проходит комбинацию «Δ≥10% И площадь≥25%» —
  требование WCAG 2.3.1 не может быть нарушено этим дизайном **независимо от частоты повторной
  навигации** (в отличие от старого дизайна, где безопасность частично держалась на допущении
  «пользователь не кликает достаточно быстро»). Это strictly более сильная гарантия, не просто
  «медленнее/тише на глаз».

**Почему БЕЗ `AnimatePresence`** (прямой ответ на вопрос «как ждать exit-анимацию»): классический
паттерн `<AnimatePresence mode="wait"><motion.div key={pathname}><Outlet/></motion.div></AnimatePresence>`
требует держать смонтированным старый `Outlet`-контент, пока играет exit — у TanStack Router нет
хука «не переключай match, пока не закончилась анимация», так что реально exit играет уже НАД
данными новой страницы, что хрупко на данных, зависящих от роута. Полноэкранный непрозрачный scrim
**решает ту же проблему проще**: пока scrim покрывает весь вьюпорт, под ним можно менять `Outlet`
МГНОВЕННО (обычное поведение роутера, без анимации самого контента) — свап невидим.
`AnimatePresence` не нужен вообще для основного варианта.

**Механика (пошагово, HOTFIX меняет ТОЛЬКО шаги 5 и 6 — визуальный слой и тайминги; 1-4/7-9 те
же, что в задеплоенной v1):**

1. `apps/landing/app/lib/page-transition.ts` — модуль-синглтон (по аналогии с
   `terminalHasMountedOnce` в `terminal.tsx`, тот же паттерн module-level state вне React):
   `let pendingVariant: 'full' | 'light' = 'full'`.
2. `window.addEventListener('popstate', () => { pendingVariant = 'light' })` — регистрируется
   один раз в корневом orchestrator-компоненте (`__root.tsx`). Браузерные back/forward → всегда
   light-вариант (см. ниже почему).
3. Общий `<BackLink>` (обёртка над `Link`, использовать вместо голого `<Link>` в местах, которые
   семантически «назад» — `careers_.$slug.tsx` `ArrowLeft "All roles"`, `__root.tsx`
   `ArrowLeft "Back home"`, `careers_.$slug.tsx` `NotFoundState` `ArrowLeft "Back to careers"`):
   `onClick` синхронно ставит `pendingVariant = 'light'` ДО вызова навигации (React вызывает
   переданный `onClick`-проп раньше внутреннего обработчика `Link`, если оба навешены на один DOM-
   узел — порядок гарантирован event bubbling самого элемента).
4. Orchestrator-компонент в `__root.tsx` (`RootDocument`): `const router = useRouter()`.
   `useEffect(() => router.subscribe('onBeforeNavigate', ({ toLocation, fromLocation }) => { ... }), [])`.
   Внутри callback'а:
   - Если `toLocation.pathname === fromLocation.pathname` (hash-only смена, напр. nav-ссылка
     `Contact` пока уже на `/`) — **ничего не делать**, page-transition НЕ триггерится (это чисто
     in-page скролл, см. §M.4).
   - Иначе — прочитать `pendingVariant`, запустить соответствующую анимацию (ниже), **сбросить
     `pendingVariant = 'full'` сразу после чтения** (одноразовый override, следующая навигация по
     умолчанию снова «основной» вариант).
5. **Основной (`full`), HOTFIX:** параллельно (`Promise.all`) —
   `animate(scrimEl, { opacity: [0, 0.94] }, { duration: DUR_SCRIM_IN, ease: EASE_SOFT })` **и**
   `animate(caretEl, { x: ['-15vw', '105vw'] }, { duration: DUR_CARET_SWEEP, ease: EASE_SOFT })`
   (кромка стартует чуть раньше/шире scrim'а и идёт дольше — целостный, не рваный, «неспешный»
   свайп) → дождаться Promise scrim-анимации **И** события `onResolved` того же
   `router.subscribe` (`Promise.all`) — что бы ни закончилось позже (обычно `onResolved` раньше
   благодаря `defaultPreload: 'intent'`, см. ниже) → `animate(scrimEl, { opacity: [0.94, 0] }, {
duration: DUR_SCRIM_OUT, ease: EASE_SOFT })` → по завершении мгновенно сбросить `caretEl` за
   левый край (`x: '-15vw'`, `duration: 0`) и `scrimEl` `opacity: 0`, готовы к следующему разу.
6. **Облегчённый (`light`), HOTFIX:** scrim/caret-line НЕ используются вообще (как и раньше).
   Контентная обёртка `<motion.div key={pathname} initial={{opacity:0, x:-8}} animate={{opacity:1,
x:0}} transition={{duration: DUR_LIGHT_TRANSITION, ease: EASE_SOFT}}>` вокруг `<Outlet/>`
   (обычный React remount по смене `key`, БЕЗ `AnimatePresence` — старый контент исчезает
   мгновенно при unmount, новый сразу начинает fade-in с `opacity:0`; на 260мс с мягким
   `EASE_SOFT` это читается как плавный crossfade, не как «дыра» и не как рывок — было `180мс` +
   `EASE_EXIT` (жёсткий финиш «на полной скорости»), обе причины жалобы «быстро»). Дешевле и
   уместнее для «я просто иду назад, уже это видел».
7. **`preload: 'intent'` — почему hold почти всегда ≈0**: `router.tsx` уже ставит
   `defaultPreload: 'intent'` (hover/focus на `<Link>` начинает грузить `loader` заранее) — то есть
   к моменту клика `fetchVacancies()`/`fetchVacancy()` чаще всего уже resolved из кеша, и
   `onResolved` в шаге 5 срабатывает практически сразу после клика, задолго до того как
   `DUR_SCRIM_IN`-анимация (230мс) успевает доиграть — значит `Promise.all` реально ждёт ТОЛЬКО
   анимацию scrim'а, не сеть. Гарантированный бюджет = `DUR_SCRIM_IN + DUR_SCRIM_OUT` = **500мс**
   (HOTFIX: было 460мс — верх диапазона 350-500мс, владелец прямо просил «длительности вверх»),
   сеть добавляет задержку только на холодном/медленном заходе — и в этом случае непрозрачный
   scrim маскирует загрузку вместо пустого экрана (честный trade-off, не баг).
8. **Первый заход / прямая загрузка (prerendered)** — `onBeforeNavigate` **физически не
   фейрится** на первичной загрузке документа (это событие клиентского роутера, не document-load) →
   никакого special-case флага не требуется (в отличие от Terminal — там нужен был
   `wasRootPrerendered()`, здесь проблема не возникает по конструкции). Прямой заход на `/careers`
   или `/careers/:slug` рендерится сразу, без scrim/caret-line.
9. **Focus management (a11y, WCAG 2.4.3 — не запрошено явно, но обязательный компаньон page-
   transitions):** после `onResolved` (оба варианта) — переместить фокус на `<main>`
   лендмарк новой страницы (`tabIndex={-1}` + `.focus({preventScroll:true})` — `preventScroll`,
   т.к. позиционирование скролла уже управляется §M.4/scroll-restoration отдельно, не должно
   конфликтовать). **Пререквизит**: `routes/index.tsx` сейчас НЕ оборачивает контент в `<main>`
   (только `careers.tsx`/`careers_.$slug.tsx` это делают, см. §9) — добавить `<main>` вокруг
   секций hero..contact на `/` как часть этой задачи (маленькая структурная правка, не визуальная).
   Без этого шага клавиатурный/скринридер-пользователь при SPA-навигации не узнаёт, что страница
   сменилась (документ не перезагружается, фокус молча остаётся на теле старой ссылки).

**Значения (HOTFIX — все длительности/easing изменены, см. M.0):**

| Фаза                            | Триггер                                  | Duration                        | Easing      | Свойство / слой                                           |
| ------------------------------- | ---------------------------------------- | ------------------------------- | ----------- | --------------------------------------------------------- |
| Scrim-in (затемнение)           | `onBeforeNavigate`, pathname изменился   | `DUR_SCRIM_IN` = 230мс          | `EASE_SOFT` | `opacity` scrim (`0 → 0.94`)                              |
| Caret-sweep (кромка пересекает) | параллельно со scrim-in, дольше          | `DUR_CARET_SWEEP` = 420мс       | `EASE_SOFT` | `translateX` caret-line (`-15vw → 105vw`), поверх scrim'а |
| Hold (scrim держит экран)       | до `Promise.all([scrim-in, onResolved])` | переменная (обычно ≈0, см. п.7) | —           | —                                                         |
| Scrim-out (просветление)        | после hold                               | `DUR_SCRIM_OUT` = 270мс         | `EASE_SOFT` | `opacity` scrim (`0.94 → 0`)                              |
| Light-transition (back)         | `popstate` ИЛИ `<BackLink>`              | `DUR_LIGHT_TRANSITION` = 260мс  | `EASE_SOFT` | `opacity` + `translateX` (контента, `-8px → 0`)           |

**Reduced-motion:** `pendingVariant`-логика полностью обходится — `onBeforeNavigate` при
`prefers-reduced-motion: reduce` ничего не анимирует (ни scrim, ни caret-line, ни content-wrapper),
роутер работает как обычный мгновенный SPA-свап. Проверка — `window.matchMedia` в момент
callback'а (не React-хук, т.к. orchestrator — не компонент внутри рендер-дерева страницы).

---

### M.4 Плавная in-page навигация (доп. владельца, 2026-07-24)

**Решение: JS-управляемый скролл** (не CSS `scroll-behavior: smooth`), обоснование ровно по
развилке, которую поставил владелец:

1. **Контроль easing** — нативный `scrollIntoView({behavior:'smooth'})`/CSS `scroll-behavior`
   используют браузерный дефолт (`ease`-подобная кривая, не настраиваемая), а у нас уже есть
   единая мягкая кривая `EASE_SOFT` (§M.0, HOTFIX 2026-07-24 — единственный default для всех
   time-based JS-анимаций), которой animated везде — якорный скролл на другой кривой был бы
   диссонансом («единый язык движения», требование продуктовой спеки).
2. **Header-offset** — sticky-хедер 66px (`nav.tsx` `h-[66px]`) перекрывает верх секции при
   обычном `scrollIntoView`; нативное решение — `scroll-margin-top` CSS на каждой `<section id=...>`
   (работает, но тогда нельзя переиспользовать ЭТУ же логику ниже для cross-page + hash случая
   единым куском кода — два разных механизма для одного и того же визуального эффекта).
3. **Reduced-motion гарантия** — браузерная поддержка `prefers-reduced-motion` для нативного smooth
   scroll реализована консистентно не во всех браузерах/версиях; explicit JS-ветка — единственный
   способ гарантировать 100% выполнение продуктового требования (§ жёсткие ограничения выше), а не
   полагаться на UA-эвристику.

```ts
// apps/landing/app/lib/smooth-scroll.ts
import { animate } from 'framer-motion'
import { DUR_SMOOTH_SCROLL, EASE_SOFT } from './motion' // HOTFIX: EASE_STANDARD -> EASE_SOFT

const HEADER_OFFSET = 66 + 16 // nav height + breathing room

export function smoothScrollToId(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const targetY = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo(0, targetY)
    return
  }
  animate(window.scrollY, targetY, {
    duration: DUR_SMOOTH_SCROLL,
    ease: EASE_SOFT,
    onUpdate: (v) => window.scrollTo(0, v),
  })
}
```

**Где применяется — 2 разных случая, разное поведение (важно не смешать):**

| Случай                                                                                                  | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hash-ссылка на ТОЙ ЖЕ странице** (юзер на `/`, кликает «Services» в nav)                              | Route НЕ меняется (pathname тот же) → page-transition НЕ триггерится (§M.3 п.4). Вместо стандартного мгновенного `hashScrollIntoView` роутера — `<Link ... hashScrollIntoView={false} onClick={() => smoothScrollToId(hash)}>` — наш плавный скролл единолично владеет этим случаем.                                                                                                                                                                                                                                                           |
| **Hash-ссылка С ДРУГОЙ страницы** (юзер на `/careers`, кликает «Contact» в nav → уходит на `/#contact`) | Route МЕНЯЕТСЯ → полноценный page-transition (**SUPERSEDED 2026-07-25**: было §M.3 scrim+caret-line, теперь §M v3.1 lift — механика ожидания та же, только визуальный слой другой). `hashScrollIntoView` роутера остаётся **default (true)** — TanStack восстанавливает/скроллит к `#contact` синхронно на `onRendered`, ДО первого отрисованного кадра enter-анимации (см. §M v3.1 «Scroll-позиция»). **Дополнительный плавный скролл поверх НЕ проигрывается** — это была бы вторая анимация подряд («не бесить»), а не «премиум-сдержанно». |
| **Back-to-top**                                                                                         | На лендинге сейчас **нет** такой кнопки/ссылки — если появится позже, обязана переиспользовать `smoothScrollToId`/аналогичный вызов `animate(window.scrollY, 0, {...})` из того же модуля, не заводить отдельный механизм.                                                                                                                                                                                                                                                                                                                     |

**Взаимодействие с page-transition scroll-reset и браузерным back/forward** (владелец: «новая
страница начинается с верха... back/forward восстанавливает позицию»):

- `router.tsx` уже включает `scrollRestoration: true` — TanStack Router САМ восстанавливает
  scroll-позицию для истории (back/forward) и сбрасывает в 0 для обычной forward-навигации,
  синхронно на событии `onRendered` (до отрисовки кадра) — **это уже нативно даёт «моментальный
  snap до enter-анимации»**, ничего доп. писать не нужно, только **не выключать** существующий
  флаг.
- Порядок событий защищает от видимого «прыжка»: `onBeforeNavigate` (scrim начинает затемнять) →
  роутер грузит/коммитит новый match → `onRendered` (TanStack восстанавливает/сбрасывает scroll
  МГНОВЕННО, без анимации, ДО следующего кадра отрисовки) → наш `Promise.all` видит `onResolved`
  → scrim открывает (scrim-out) уже ПРАВИЛЬНО заскроленную страницу. При основном (`full`)
  варианте юзер физически не может увидеть промежуточный «прыжок» — он происходит под непрозрачным
  scrim'ом. При облегчённом (`light`, back/forward) варианте — прыжок происходит ДО первого
  отрисованного кадра нового `key`-remount (тот же порядок событий), так что тоже не виден как
  анимированный скролл, только как корректная финальная позиция.
- Итог: НЕ анимировать scroll-restoration отдельно (владелец прямо просил «restoration восстанавливает
  позицию», а не «restoration плавно доскролливает») — она инстант по конструкции TanStack Router,
  и это правильно ложится под page-transition scrim.

---

### M.5 Сигнатурные детали — краткий свод («душа» v2)

Для быстрого сканирования PM/Coder — что здесь реально новое/особенное (не рутинный reveal):

1. **Terminal-докинг** (§M.1.1) — терминал слегка уходит вглубь/масштабируется при скролле мимо
   hero, typewriter не тронут.
2. **Process connector-line** (§M.1.1, geometry HOTFIX в §M.1.1a) — линия «дорисовывается» между
   4 шагами по scroll-прогрессу, `≥768px`, теперь корректно прячется за карточками (не пересекает
   текст лейблов).
3. **Case-study metric-lag** (§M.1.1) — метрики карточки чуть «догоняют» текст, depth cue.
4. **SUPERSEDED 2026-07-25** — было: тёмный scrim + тонкая жёлтая caret-line page-transition
   (§M.3, HOTFIX 2026-07-24). Владелец отверг («бьёт по глазам»). Заменено на **«мягкий лифт»**
   (lift cross-fade, БЕЗ каких-либо оверлеев — только `opacity`/`translateY` контента, §M v3.1) +
   **shared-element FLIP-морф заголовка** на `/careers ↔ /careers/:slug` (§M v3.2, новая
   сигнатурная деталь — заголовок вакансии буквально «перелетает» из карточки в детальную
   страницу).
5. **Единая scroll-progress-linked entrance** (§M.1.0, `ScrollReveal`) — база под всем остальным:
   каждая секция теперь буквально реагирует на положение скролла, не на факт «появилась в кадре».

---

### M.6 Verification-чеклист (Mode B, специфично для v2 — дополняет §12)

- [ ] Lighthouse mobile ≥90 не регрессировал после добавления scroll-listeners/`animate()`-вызовов
      (`passive`-листенеры, только `transform`/`opacity`, без layout-триггерящих свойств).
- [ ] Ни один `ScrollReveal`/scroll-linked эффект не создаёт CLS (все — `transform`, не
      `margin`/`top`/`height`).
- [ ] Скролл вверх после того как секция появилась — секция плавно уходит обратно (bidirectional,
      не `once`).
- [ ] Page-transition scrim/caret-line — `pointer-events-none` **всегда** (проверить, что клик
      сквозь них проходит даже в момент анимации — не должны блокировать доп. клики).
- [ ] Hash-навигация с другой страницы НЕ проигрывает второй (лишний) скролл-твин поверх
      page-transition (см. таблицу §M.4).
- [ ] Browser back/forward — облегчённый `light`-вариант, НЕ основной scrim+caret-line.
- [ ] После завершения page-transition (оба варианта) — фокус на `<main>` новой страницы
      (клавиатурный Tab с этой точки идёт по новому контенту, не залипает на старой ссылке).
- [ ] `prefers-reduced-motion: reduce` — page-transition = мгновенный свап, smooth-scroll =
      мгновенный `scrollTo`, все `ScrollReveal` — сразу в конечном состоянии (протестировать через
      Playwright `emulateMedia({reducedMotion: 'reduce'})` на все 3 роута).
- [ ] Прямой заход (свежая вкладка/reload) на `/`, `/careers`, `/careers/:slug` — БЕЗ scrim/
      caret-line (page-transition — только для client-side навигации).

**HOTFIX 2026-07-24 — дополнительные пункты:**

- [ ] Page-transition НЕ содержит НИ ОДНОГО полноэкранного `bg-primary`/яркой сплошной заливки —
      только scrim (`var(--background)`) + тонкая (`≤10%` ширины вьюпорта) caret-line.
      Playwright: pixel-sample центра viewport в момент пика анимации, относительная люминанция
      НЕ должна скакать на ≥10% при площади образца ≥25% (см. §M.3.0 расчёт).
- [ ] `DUR_SCRIM_IN + DUR_SCRIM_OUT` = 500мс (не короче — было 460мс, жалоба «очень быстро»);
      `EASE_SOFT` (симметричная, БЕЗ раннего разгона) на ВСЕХ time-based JS-анимациях
      (page-transition, smooth-scroll) — `EASE_STANDARD`/`EASE_EXIT` НЕ используются вне M.1.
- [ ] Все hover-состояния §M.2 — ≥150мс, явный `ease-out` класс (не implicit Tailwind default).
- [ ] Process connector-line НЕ пересекает текст «01 / Discovery» и т.п. ни на одном из 4 шагов
      (визуальная проверка + `relative z-10` на грид-обёртке в DOM, `z-0` на линии — §M.1.1a).
- [ ] VacancyCard/ServiceCard hover — плавный лифт БЕЗ видимого «скачка» на первом кадре hover
      (визуальная/видео-проверка замедленной съёмкой при необходимости; `will-change-transform`
      присутствует в DOM на обоих — §M.2a).

---

## M v3 (2026-07-25): page transitions — lift + shared-element morph + iOS perf

**Решение владельца (дословно, через координатора).** Про задеплоенный scrim+caret-line (§M.3):
«контрастирует с общим освещением сайта и бьёт по глазам». Про мобильный опыт: «на iPhone все
анимации дёрганые», плюс отдельный скриншот мобильного хиро с пометкой на строке-бейдже
(«заголовок/отступы... выглядит криво»). Владелец выбрал из предложенных концептов КОМБО:

1. **База (ВСЕ переходы страниц): «мягкий лифт» (lift cross-fade)** — старая страница ~10px
   оседает вниз и тает, новая всплывает снизу (~12-14px) и проявляется. **Никаких цветных/тёмных
   оверлеев/шторок** — переход только контентом (`transform`/`opacity`), scrim+caret-line §M.3
   удалён полностью (SUPERSEDED-пометки расставлены по тексту §M.3/§M.3.0/§M.4/§M.5 выше).
2. **Поверх базы, только на `/careers ↔ /careers/:slug`: shared-element FLIP-морф заголовка** —
   кликнутый title карточки перелетает/масштабируется в позицию H1 деталки (и обратно на back),
   остальной контент идёт базовым лифтом.
3. **iOS-перф раздел** — правила, устраняющие вероятную причину «дёрганости» на iPhone (scroll-
   linked JS + continuous backdrop-blur repaint), обязательны для ЛЮБОЙ реализации M.1/nav, не
   только для нового M v3-кода.
4. **Мобильный аудит живого прода** (320/375/390) — конкретные найденные «кривизны» с fix-списком.

Область действия — та же, что §M (только `apps/landing/**`). Жёсткие ограничения §M (Lighthouse
≥90 mobile, только `transform`/`opacity`, `prefers-reduced-motion`, hero above-the-fold контракт,
без новых тяжёлых зависимостей) действуют без изменений.

### M v3.0 Motion-токены — замена page-transition констант

`apps/landing/app/lib/motion.ts` — `DUR_SCRIM_IN`/`DUR_SCRIM_OUT`/`DUR_CARET_SWEEP`/
`DUR_LIGHT_TRANSITION` **удаляются** (были только для scrim+caret, теперь мертвый код). Новые:

```ts
// §M v3 (2026-07-25) — REPLACES DUR_SCRIM_IN/DUR_SCRIM_OUT/DUR_CARET_SWEEP/DUR_LIGHT_TRANSITION.
// EASE_SOFT (единая мягкая symmetric-кривая, §M.0) остаётся default для ВСЕХ time-based JS-анимаций
// ниже — единый язык движения, отдельная кривая для lift/morph НЕ вводится.
export const DUR_LIFT_EXIT = 0.22 // 220ms — старая страница оседает + тает
export const DUR_LIFT_ENTER = 0.3 // 300ms — новая страница всплывает + проявляется
export const LIFT_OFFSET_EXIT = 10 // px — translateY 0 → +10 (вниз) на exit
export const LIFT_OFFSET_ENTER = 14 // px — |translateY| на enter (знак зависит от direction, см. M v3.1)
export const DUR_TITLE_MORPH = 0.35 // 350ms — shared-element заголовок, /careers ↔ /careers/:slug
```

`DUR_REVEAL`, `DUR_SMOOTH_SCROLL`, `EASE_SOFT`, `EASE_STANDARD` — без изменений (M.0 актуален).

### M v3.1 Lift cross-fade (база, ВСЕ переходы страниц)

**Почему всё ещё БЕЗ `AnimatePresence`** (тот же технический аргумент, что в старом §M.3 «Почему БЕЗ
AnimatePresence» — не повторяется дословно, действует так же): TanStack Router не даёт хука «не
переключай match, пока не доиграла exit-анимация» — держать старый `Outlet` смонтированным до конца
exit означало бы либо форкать роутер, либо клонировать весь DOM старой страницы (`cloneNode`, htmlcanvas-free,
но лишняя сложность/риск рассинхрона с живым CSS). Вместо этого — тот же паттерн, что уже был
проверен в бою в старом «light»-варианте §M.3 шаг 6 (single keyed `motion.div`, React remount по
смене `key={pathname}`, БЕЗ AnimatePresence): расширяем его на ВСЕ переходы, а exit старой
страницы играем **императивно поверх ещё смонтированного старого DOM**, не блокируя навигацию.

**Принятый компромисс (явно, не случайность):** т.к. навигация НЕ блокируется ради exit-анимации,
при очень быстрой (preloaded, `defaultPreload:'intent'` уже стоит в `router.tsx`) навигации React
может успеть демонтировать старую страницу и смонтировать новую ДО того, как 220мс exit-твин
доиграл — exit в этом случае обрывается на середине (Motion's `animate()` просто перестаёт
применяться к уже удалённому из DOM узлу, без ошибки). Это тот же класс trade-off, что уже был
явно принят в §M.3 шаге 7 (там — сеть могла «съесть» scrim-hold бюджет); здесь — редкий случай
(наведение/focus почти всегда прогревает `loader` заранее), и даже при обрыве enter новой страницы
всё равно доигрывает полностью 300мс — переход не выглядит сломанным, просто чуть короче exit-фазы.

**Механика (пошагово):**

1. `apps/landing/app/lib/page-transition.ts` — модуль-синглтон, тот же файл/паттерн, что в §M.3,
   переименованное значение: `let pendingDirection: 'forward' | 'back' = 'forward'` (было
   `pendingVariant: 'full'|'light'` — семантика меняется с «тяжесть эффекта» на «направление
   лифта», сама архитектура module-singleton — без изменений).
2. `window.addEventListener('popstate', () => { pendingDirection = 'back' })` — как раньше,
   регистрируется один раз в `__root.tsx`.
3. `<BackLink>` (та же обёртка, что в §M.3 шаг 3, тот же список мест применения — `careers_.$slug.tsx`
   `ArrowLeft "All roles"`, `__root.tsx` `ArrowLeft "Back home"`, `NotFoundState` `ArrowLeft "Back to
careers"`) — `onClick` синхронно ставит `pendingDirection = 'back'` до вызова навигации.
4. Orchestrator в `__root.tsx` (`RootDocument`) — `router.subscribe('onBeforeNavigate', ...)`, тот же
   guard на hash-only смену (`toLocation.pathname === fromLocation.pathname` → ничего не делать,
   см. §M.4). При смене pathname:
   - Взять ref текущего (ещё смонтированного) content-wrapper `motion.div`.
   - `animate(currentWrapperEl, { opacity: [1, 0], y: [0, LIFT_OFFSET_EXIT] }, { duration:
DUR_LIFT_EXIT, ease: EASE_SOFT })` — **fire-and-forget**, НЕ await (см. «Принятый компромисс»
     выше). `prefers-reduced-motion: reduce` → пропустить вызов целиком (страница просто исчезнет
     мгновенно на React-unmount, ничего не анимируется).
5. Content-wrapper — **один и тот же** `motion.div key={pathname}` вокруг `<Outlet/>` для ЛЮБОЙ
   навигации (никакого разделения full/light, как было раньше — вся ветка упрощена):
   ```tsx
   <motion.div
     key={pathname}
     initial={
       reducedMotion
         ? false
         : { opacity: 0, y: pendingDirection === 'back' ? -LIFT_OFFSET_ENTER : LIFT_OFFSET_ENTER }
     }
     animate={{ opacity: 1, y: 0 }}
     transition={{ duration: DUR_LIFT_ENTER, ease: EASE_SOFT }}
     onAnimationComplete={focusMainLandmark} // см. п.7
   >
     <Outlet />
   </motion.div>
   ```
   Читать `pendingDirection` и сразу сбрасывать в `'forward'` в момент вычисления `initial` (одноразовый
   override, как было с `pendingVariant`). `reducedMotion` — `window.matchMedia('(prefers-reduced-motion:
reduce)').matches`, прочитанный в момент рендера (не React-хук — `RootDocument` уже читает его
   императивно для шага 4, переиспользовать то же значение).
6. **Никакого `Promise.all`/scrim-hold/`onResolved`-ожидания** (в отличие от старого §M.3 шага 5) —
   прятать нечего, новый `Outlet` просто виден сразу с `opacity:0`, что и есть его enter-анимация.
   `onResolved` из старого шага 7 — не нужен вообще, убрать эту подписку.
7. **Focus management** (WCAG 2.4.3, тот же компаньон-требование, что в §M.3 шаг 9, БЕЗ изменений
   по сути) — `onAnimationComplete` enter-твина (см. код шага 5) переносит фокус на `<main>`
   лендмарк новой страницы (`tabIndex={-1}` + `.focus({preventScroll:true})`). Тот же пререквизит
   остаётся в силе: `routes/index.tsx` должен оборачивать hero..contact в `<main>` (если ещё не
   сделано в рамках §M.3 — не переделывать дважды).
8. **Первый заход/прямая загрузка** — `onBeforeNavigate` не фейрится на document-load, как и раньше
   (см. §M.3 п.8) — без изменений, ничего доп. не требуется.
9. **Scroll-позиция** (тот же контракт, что §M.4 «Взаимодействие с page-transition scroll-reset»,
   переформулированное обоснование — старое «физически спрятано под scrim» больше не подходит, т.к.
   scrim исчез): `router.tsx` `scrollRestoration: true` восстанавливает/сбрасывает scroll СИНХРОННО
   на `onRendered`, **до следующего отрисованного кадра** — т.е. до того, как браузер вообще успевает
   покрасить кадр с неправильной scroll-позицией. Enter-анимация (шаг 5) стартует УЖЕ на корректно
   восстановленной позиции — «прыжка» не видно не потому, что он спрятан непрозрачным слоем (как
   раньше), а потому что он физически происходит до первого paint нового layout-состояния (тот же
   браузерный гарант, просто другое объяснение, т.к. раньше объяснение №1 — под scrim — было
   доступно как страховка, теперь остаётся только объяснение №2, которое ГЛАВНОЕ и раньше тоже было
   верным).

**Значения:**

| Фаза                               | Триггер                                            | Duration                 | Easing      | Свойство                                                                    |
| ---------------------------------- | -------------------------------------------------- | ------------------------ | ----------- | --------------------------------------------------------------------------- |
| Exit (старая страница)             | `onBeforeNavigate`, pathname изменился             | `DUR_LIFT_EXIT` = 220мс  | `EASE_SOFT` | `opacity` 1→0, `translateY` 0→+10px (оседает вниз)                          |
| Enter forward (обычная навигация)  | mount нового match, `pendingDirection==='forward'` | `DUR_LIFT_ENTER` = 300мс | `EASE_SOFT` | `opacity` 0→1, `translateY` +14px→0 (всплывает снизу)                       |
| Enter back (`popstate`/`BackLink`) | mount нового match, `pendingDirection==='back'`    | `DUR_LIFT_ENTER` = 300мс | `EASE_SOFT` | `opacity` 0→1, `translateY` −14px→0 (приходит сверху — зеркально direction) |

**Reduced-motion:** exit-вызов (шаг 4) пропускается целиком; content-wrapper `initial={false}`
(рендерится сразу в конечном `{opacity:1,y:0}` состоянии) — итог тот же, что в старом §M.3: обычный
мгновенный SPA-свап, ни одна фаза не анимируется.

**WCAG 2.3.1 compliance (заменяет расчёт §M.3.0, короче — по конструкции безопаснее):** lift НЕ
вводит ни одного нового цветного/непрозрачного слоя — анимируется исключительно `opacity`/
`translateY` САМОГО контента страницы (то, что видно — это реальный UI, теряющий/приобретающий
непрозрачность). Люминанс-разница кадр-к-кадру ограничена обычным диапазоном fade/scroll-подобного
изменения, не «мигающим элементом» в терминах General Flash Threshold — критерий неприменим в
принципе (нет альтернирующего цветного паттерна, есть один монотонный переход). Формальный расчёт
не требуется (в отличие от scrim+caret, где ОБЯЗАТЕЛЬНО было доказывать безопасность конкретных
токенов — здесь эта категория риска отсутствует по построению).

### M v3.2 Shared-element title morph (`/careers ↔ /careers/:slug`)

**Что морфится:** ИМЕННО текстовый заголовок вакансии — `<h3>` в `VacancyCard`
(`apps/landing/app/components/marketing/vacancy-card.tsx:32-34`, `text-[1.22rem] leading-[1.15]
font-semibold tracking-[-0.015em]`) ↔ `<h1>` в детальной странице
(`apps/landing/app/routes/careers_.$slug.tsx:126-128`, `text-[clamp(2rem,5.5vw,3.4rem)]
leading-[1.02] font-semibold tracking-[-0.03em]`). НЕ вся карточка — только сама строка текста.
Шрифт/размер интерполируются **масштабом** (`transform: scale()`), НЕ анимацией `font-size`
(layout-триггерящее свойство, ломает hard-constraint §M «только transform/opacity»); tracking
(letter-spacing) НЕ интерполируется — остаётся константой на значении карточки весь твин
(0.35с — разница между -0.015em/-0.03em визуально незаметна за это время, не стоит усложнения).

**Область действия — только связка `/careers ↔ /careers/:slug` (задача явно это ограничивает).**
Клик по `VacancyCard` в Home-тизере (`careers-teaser.tsx`) → детальная **НЕ** получает морф (это
переход `/` → `/careers/:slug`, не `/careers` → `/careers/:slug`) — падает в фолбэк «просто базовый
лифт» ниже. `VacancyCard` — ОДИН shared-компонент для тизера и списка; специально форкать его под
два поведения не нужно (см. механику ниже — гейт по route-паре стоит на СТОРОНЕ ПОТРЕБЛЕНИЯ, не на
стороне капчура, поэтому `VacancyCard` остаётся одним и тем же кодом в обоих местах).

**Механика (measure → invert → play, overlay-clone — не настоящий FLIP на одном узле, т.к. узлы на
разных страницах физически разные DOM-элементы):**

1. Оба конца связки получают общий идентификатор: `VacancyCard` `<h3>` и детальная `<h1>` — атрибут
   `data-vacancy-morph-slug={vacancy.slug}` (аналог Framer `layoutId`, но управляется вручную, т.к.
   `AnimatePresence`/встроенный shared-layout недоступны при полном unmount страницы, см. §M v3.1
   «Почему БЕЗ AnimatePresence»).
2. `apps/landing/app/lib/title-morph.ts` — модуль-синглтон:
   `let pendingMorph: { slug: string; text: string; rect: DOMRect; fontSizePx: number; lineHeightPx: number } | null = null`.
3. **Capture — forward** (клик по `VacancyCard`, `onClick` на `<Link>`, синхронно до навигации, тот
   же event-order гарант, что у `<BackLink>` в §M v3.1 шаг 3): если `prefers-reduced-motion` —
   ничего не делать (return early, дешёвая проверка). Иначе — измерить `h3Ref.current.getBoundingClientRect()`
   - `getComputedStyle(h3Ref.current)` (`fontSize`, `lineHeight` в px) → **guard: однострочность** —
     если `rect.height > lineHeightPx * 1.3` (т.е. заголовок карточки уже сам перенёсся на 2+ строки —
     бывает на очень узких экранах при длинном названии вакансии) → НЕ писать `pendingMorph` (fallback
     ниже сработает сам по отсутствию `pendingMorph`). Иначе — записать `{ slug, text: vacancy.title,
rect, fontSizePx, lineHeightPx }`.
4. **Capture — back** (клик по `<BackLink>` на детальной странице, `ArrowLeft "All roles"`) — тот же
   код пути, что п.3, но источник — `<h1>` (не `<h3>`), `slug` — `vacancy.slug` текущей страницы.
   Та же однострочность-guard (на H1 более вероятно сработать на очень длинных названиях — это
   ожидаемо и нормально, `cc-display`/H1 и так уже допускает 2-3 строки по дизайну §8 edge-case
   «Длинный заголовок вакансии» — просто в этом случае морф не играет, только базовый лифт).
5. **Consume** (на странице-получателе, `useLayoutEffect` — до первой отрисовки кадра): прочитать
   `pendingMorph`. Условия проигрывания морфа (**ВСЕ** обязательны, иначе — silent fallback на
   базовый лифт, реальный заголовок рендерится сразу как обычно, ничего доп. не показываем):
   - `pendingMorph !== null`;
   - `router` подтверждает, что переход был ИМЕННО `/careers → /careers/:slug` (forward) или
     `/careers/:slug → /careers` (back) — читать `fromLocation.pathname`/`toLocation.pathname` из
     того же `onBeforeNavigate`-подписки §M v3.1 (кэшировать пару путей в ещё одно поле того же
     `title-morph.ts` синглтона, устанавливаемое в п.4 оркестратора §M v3.1 — не заводить вторую
     независимую router-подписку);
   - `pendingMorph.slug` совпадает с релевантным slug на странице-получателе (детальная — `vacancy.slug`
     из loader; список — ищем `document.querySelector('[data-vacancy-morph-slug="' + slug + '"]')`
     среди только что смонтированных `VacancyCard`; НЕ найден — silent fallback, напр. если вакансия
     успела пропасть из списка между переходами);
   - реальный целевой элемент (H1 или найденный H3) сам однострочный (та же `rect.height <=
lineHeightPx * 1.3` проверка, теперь на ПРИЁМНОЙ стороне — т.к. `clamp()`-размер H1 зависит от
     viewport, длинный заголовок на очень узком экране может перенестись именно на 2 строки уже на
     destination, даже если source было в одну строку);
   - `pendingMorph.text` совпадает с фактическим текстом целевого заголовка (staleness-guard — на
     случай, если между capture и consume данные успели устареть/race).
     Прочитав — сразу сбросить `pendingMorph = null` (одноразовый, как `pendingDirection`).
6. **Если все условия — да, играть overlay-клон:**
   - Скрыть реальный заголовок-получатель на время морфа: `realTitleEl.style.visibility = 'hidden'`
     (НЕ `display:none` — элемент обязан остаться в layout-потоке, иначе `getBoundingClientRect()`
     ниже вернёт неверный/нулевой прямоугольник).
   - Измерить `destRect = realTitleEl.getBoundingClientRect()` + `destFontSizePx =
parseFloat(getComputedStyle(realTitleEl).fontSize)`.
   - Создать overlay `<div>` (`document.body.appendChild`, `position:fixed; top:0; left:0; margin:0;
pointer-events:none; z-index:1000; white-space:nowrap; font-weight:600; color:var(--foreground);
transform-origin: top left`), `textContent = pendingMorph.text`, `fontSize =
pendingMorph.fontSizePx + 'px'`, начальный `transform: translate(${pendingMorph.rect.left}px,
${pendingMorph.rect.top}px) scale(1)` — визуально идентичен тому, как заголовок выглядел на
     ИСХОДНОЙ странице, появляется МГНОВЕННО (без анимации) в той же экранной позиции, где был до
     навигации (это и есть «invert»-шаг классического FLIP, просто клон вместо реального узла).
     `willChange = 'transform'` на время анимации (санкционированный кейс §M.2a — снять после
     завершения, п.7).
   - **Play** (imperative `animate()`, единая точка входа, что и везде в M v3/M.3):
     `scaleFactor = destFontSizePx / pendingMorph.fontSizePx`; анимировать overlay `transform` от
     стартового значения к `translate(${destRect.left}px, ${destRect.top}px) scale(${scaleFactor})`,
     `{ duration: DUR_TITLE_MORPH, ease: EASE_SOFT }` (350мс — в диапазоне 320-380 из задачи).
     `transform-origin: top left` гарантирует, что масштаб растёт от уже-выставленного левого-
     верхнего угла, а не «гуляет» — конечная позиция overlay совпадает с `destRect` без доп. коррекций.
7. **По завершении** (`animate()`-промис/`onComplete`): удалить overlay из DOM, `realTitleEl.style.visibility
= ''` (снова видим — т.к. финальный кадр overlay пиксель-в-пиксель совпадает с позицией/размером
   реального заголовка, подмена незаметна), `willChange = 'auto'` уже снят по завершении (не
   оставлять висеть, тот же принцип §M.2a).
8. **Донор-карточка (что происходит с ней):** НИЧЕГО специального. `VacancyCard`/список на исходной
   странице просто уходят через обычный базовый лифт §M v3.1 (exit-фаза, страница целиком оседает и
   тает) — сам overlay-клон летит НАД ней (`z-index:1000`, `position:fixed`, поверх затухающего
   контента), визуально читается как «заголовок отрывается от карточки и летит на новое место», пока
   всё остальное на списке мягко угасает под ним. Никакого отдельного кода на стороне
   `VacancyCard`/`CareersList` не требуется.

**Фолбэки (ВСЕ — просто базовый лифт §M v3.1, без морфа, без ошибок/задержек):**

| Кейс                                                                     | Поведение                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Прямой заход на `/careers/:slug` (новая вкладка/reload/внешняя ссылка)   | `pendingMorph === null` с самого начала → фолбэк                                                |
| Переход НЕ из списка (Home-тизер → детальная, детальная → nav-лого home) | Route-пара `fromLocation`/`toLocation` не совпадает с `/careers ↔ /careers/:slug` → фолбэк      |
| `prefers-reduced-motion: reduce`                                         | Capture пропущен целиком (п.3/4 early-return) → `pendingMorph` никогда не выставляется → фолбэк |
| Заголовок карточки/детальной переносится на 2+ строки на любом конце     | Однострочность-guard (п.3/4/5) → фолбэк                                                         |
| Вакансия пропала из списка между capture и consume (back-направление)    | `querySelector` не находит `[data-vacancy-morph-slug]` → фолбэк                                 |
| Race/устаревшие данные (текст не совпадает)                              | Staleness-guard (п.5) → фолбэк                                                                  |

### M v3.3 iOS-перф правила (обязательны — применяются и к существующему M.1/nav-коду, не только к новому)

Владелец: «на iPhone все анимации дёрганые». Разбор по коду (не только гипотеза) — два независимых
источника continuous per-frame repaint на iOS Safari, оба усиливают друг друга при скролле:

1. **Правило (hard, наследует §M constraint):** ТОЛЬКО `transform`/`opacity` на композитном слое.
   Lift (§M v3.1) и title-morph (§M v3.2) уже соблюдают это по построению (проверено выше по каждому
   шагу) — фиксируется как регрессия-гейт для будущих правок этого кода, не только текущая проверка.
2. **Правило (mandatory): НИКАКОГО scroll-linked JS-декора на тач-устройствах.** `ScrollReveal`
   (§M.1.0, `useScroll`+`useTransform`, пересчитывается на КАЖДЫЙ scroll-frame) — на touch/coarse-
   pointer устройствах заменяется на одноразовый `useInView`-reveal (IntersectionObserver под
   капотом, не scroll-listener — нулевая нагрузка на main thread между срабатываниями):

   ```ts
   // apps/landing/app/lib/use-coarse-pointer.ts (НОВЫЙ) — НЕ UA-sniffing, media-query-based
   export function useCoarsePointer(): boolean {
     const [coarse, setCoarse] = useState(
       () =>
         typeof window !== 'undefined' &&
         window.matchMedia('(hover: none), (pointer: coarse)').matches,
     )
     useEffect(() => {
       const mql = window.matchMedia('(hover: none), (pointer: coarse)')
       const handler = () => setCoarse(mql.matches)
       mql.addEventListener('change', handler)
       return () => mql.removeEventListener('change', handler)
     }, [])
     return coarse
   }
   ```

   - `ScrollReveal` (About/Services/Tech stack/Careers teaser/Contact, §M.1.0) — на touch: `const
isInView = useInView(ref, { once: true, amount: 0.15 })`, рендерить `{opacity: isInView?1:0, y:
isInView?0:y}` через обычный CSS-transition (`transition-[opacity,transform] duration-500
ease-out`, НЕ Framer imperative) вместо `useScroll`/`useTransform` — тот же визуальный «въезд
     один раз», без continuous scroll-recalculation.
   - **Hero-glow/Terminal-докинг/Process connector-line/Chip-волна** (§M.1.1 — ambient/continuous
     эффекты БЕЗ естественного «one-shot»-эквивалента) — на touch используют **тот же статичный
     fallback, что уже прописан для `prefers-reduced-motion` в таблице §M.1.1** (просто объединить
     условие: `if (reduced || coarsePointer) return <static/>`) — не изобретать отдельную
     touch-версию с половинчатым эффектом, ambient-параллакс на тач-скролле не несёт той же
     ценности, что на десктопном курсор+scroll.
   - **Case-study metric-lag** (§M.1.1, «догоняющие» метрики) — на touch: лаг отключается, метрики
     появляются ОДНОВРЕМЕННО с остальным содержимым карточки через тот же `useInView({once:true})`,
     что и родительский `ScrollReveal` (не отдельный лаг-эффект).

3. **Правило: passive listeners.** Framer Motion `useScroll`/`useInView` используют passive/
   IntersectionObserver внутри (не ручные non-passive scroll-listeners — подтверждено docs). Lift/
   morph НЕ добавляют scroll-listeners вообще (только `popstate`, не scroll-событие). Явных ручных
   `addEventListener('scroll', ...)` в кодовой базе landing нет — фиксируется как regression-gate:
   если появится, ОБЯЗАН иметь `{ passive: true }`.
4. **Правило: `will-change` точечно, снимать после анимации.** Уже применяется в §M.2a (Card/
   VacancyCard hover) — title-morph overlay (§M v3.2 п.6-7) следует тому же паттерну (`willChange`
   выставляется перед `animate()`, снимается в `onComplete`, никогда не оставляется висеть).
5. **Правило (mandatory fix, НОВАЯ находка этого аудита): никакого continuous `backdrop-filter` на
   sticky/fixed элементах над скроллящимся контентом.** `nav.tsx:84` — sticky header имеет
   `backdrop-blur-md backdrop-saturate-150`. Формально это не CSS-`@keyframes`-анимация фильтра, НО
   `backdrop-filter` на `position:sticky`-элементе, под которым непрерывно скроллится контент,
   заставляет iOS Safari **пересчитывать сэмпл фона на КАЖДЫЙ scroll-frame** — функционально
   эквивалентно анимированному blur, даже без явного `transition`/`animation` на самом фильтре.
   Это накладывается на пункт 2 (scroll-linked JS) на КАЖДОМ кадре скролла и, скорее всего, —
   главный вклад в жалобу «все анимации дёрганые» (эффект глобальный, липнет ко ВСЕМ 66px верхней
   полосы экрана на протяжении всего скролла, не к одной конкретной секции). **Fix (touch only,
   через `useCoarsePointer()` выше или CSS `@media (hover: none)`-вариант класса):** заменить
   `backdrop-blur-md backdrop-saturate-150` на подъём непрозрачности фонового `color-mix` с текущих
   `72%` до `~95%` и убрать `backdrop-filter` целиком — визуально почти неотличимо (фон и так тёмный,
   контент под хедером тоже тёмный), но снимает per-frame repaint полностью. На desktop/hover-devices
   — оставить как есть (blur там не создаёт той же нагрузки, retina/desktop GPU справляется).
6. **Правило: никаких blur/filter-анимаций на мобиле** (общее следствие пункта 5) — регрессия-гейт
   на будущее: любой новый `backdrop-blur`/`filter: blur()` на элементе, который может оказаться под
   активным скроллом (sticky/fixed/`position:absolute` внутри скроллящегося контейнера) — ОБЯЗАН
   иметь touch-fallback без фильтра, по аналогии с п.5.

### M v3.4 Мобильный аудит живого прода (2026-07-25, `https://cheekycheese.tech`, 320/375/390)

Playwright, read-only, прод (не dev/staging — 0 PUBLISHED вакансий на момент аудита, `/careers/:slug`
визуально не проверялся живьём, см. примечание в конце). Скриншоты — `assets/landing-redesign/
mobile-audit-2026-07-25/`.

| #   | Severity                      | Где                                                                                                                                                                                                                     | Что не так                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Что сделать                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **HIGH** (владельца скриншот) | Hero eyebrow-бейдж «Outsource & outstaffing · AI · EdTech · E-Commerce», `apps/landing/app/components/ui/chip.tsx:11-21` (`Chip`, `items-center` на строке 11)                                                          | На 320/375/390 текст переносится на 2 строки (контент шире доступной ширины на ЛЮБОМ мобильном экране, не только 320). `items-center` на flex-контейнере центрирует ведущий жёлтый dot против ВСЕГО (двухстрочного) текстового блока, а не против первой строки — dot визуально «плавает» между строк, читается как оторванный/несвязанный элемент. Промерено: dot center y=157.19, центр 1-й строки y=146.6, центр всего 2-строчного блока y=156.2 — dot совпадает со вторым, не с первым (мат. подтверждение бага). Воспроизведено на 320/375/390 идентично (см. `home-320-badge-zoom.png`, `home-375-hero.png`, `home-390-hero-top.png`).                                                                                                                                                                                       | В `chip.tsx`: `items-center` → `items-start` на внешнем `span` (строка 11) + на dot (`span` строка 19) добавить `mt-[calc(0.75em-3px)]`. Формула — половина разницы между line-height (Tailwind Preflight `line-height:1.5`, наследуется, т.к. ни один вызов `Chip` не задаёт `leading-*`) и высотой dot (`size-1.5`=6px, фиксирован): `(1.5em-6px)/2 = 0.75em-3px`. `em` резолвится от текущего font-size dot'а (наследует от `Chip`), поэтому формула автоматически верна для ЛЮБОГО переопределения размера у любого вызова (`text-[0.8rem]` на hero, `text-[0.86rem]` default на tech-stack) — не хардкодить px. **Проверено математически, что для однострочных Chip (tech-stack — не переносится ни на одном брейкпоинте) результат ПИКСЕЛЬ-В-ПИКСЕЛЬ идентичен старому `items-center`** — фикс не требует раздельного пути для wrap/no-wrap случаев, безопасен как global-дефолт компонента. |
| 2   | **HIGH** (найдено аудитом)    | Case-study метрики (`Selected work`), `apps/landing/app/components/marketing/case-study-card.tsx:56` и `:71` (обе ветки — `reduced` и обычная) — `text-[1.9rem]` на value-`div`                                         | На 320px (375/390 — чисто, промерено) значения вида `±NN%` (2-значное число + суффикс `%`, напр. `-64%`/`+38%`/`+27%`) визуально КАСАЮТСЯ следующей метрики — 16px gap между 66px-колонками grid'а полностью съедается натуральной шириной нерасщепляемого текстового рана "-64%" (~83px против 66+16=82px доступных) — заходит на ~1px в соседнюю колонку. На глаз (см. `home-320-casestudy.png`) читается как слипшееся «-64%5×» без зазора вообще — крупный визуальный дефект на каждой из 3 case-study карточек (AI/ML, EdTech, E-Commerce — паттерн систематический, не единичный случай). Промерено `getBoundingClientRect()`: em `%` правый край vs левый край соседней колонки — overlap +1px на всех трёх картах с `±NN%`-метрикой.                                                                                       | Уменьшить `text-[1.9rem]` до `text-[1.35rem]` БАЗОВО (<400px) с возвратом к полному размеру ≥400px: `text-[1.35rem] min-[400px]:text-[1.9rem]` на обеих строках (56, 71) — используя тот же `min-[Npx]:`-arbitrary-variant паттерн, что уже в кодовой базе (`nav.tsx` `min-[900px]:`, case-study grid `min-[860px]:`). Порог 400px — намеренно с запасом (реальный overflow только на 320px), не точечный под 320-374px — Coder может сузить порог при желании, но ОБЯЗАН перепроверить нулевой overlap на 320/375/390 (bounding-rect соседних колонок, `col[i].right <= col[i+1].left`, как в этом аудите) перед PASS.                                                                                                                                                                                                                                                                             |
| 3   | LOW (guidance, не блокер)     | `nav.tsx:84` sticky header, hover-состояния §M.2 в целом                                                                                                                                                                | Не layout-баг, а перф/UX guidance: см. §M v3.3 п.5 (backdrop-blur continuous repaint — САМ фикс уже специфицирован там, здесь только перекрёстная ссылка, чтобы Coder не пропустил при беглом чтении только audit-таблицы). Отдельно: CSS `:hover`-классы (не Framer `whileHover`) не имеют встроенного touch-исключения (в отличие от Framer's `whileHover`, который игнорирует `pointerType==='touch'` по built-in — подтверждено исходником `gestures/hover.ts`) — на iOS `:hover` может визуально «залипнуть» после тапа до следующего тапа в другое место (задокументированный WebKit-паттерн). Риск минимален для элементов, где тап сразу уводит со страницы (nav/footer-ссылки, VacancyCard), но применимо к `mailto:`-CTA (открывает почтовый клиент, пользователь может вернуться на ту же страницу с «залипшим» hover). | Не блокирующий фикс. Если будет замечено на QA реальных iPhone — добавить `@media (hover: hover) and (pointer: fine)`-обёртку вокруг НОВЫХ decorative-only hover-добавлений из §M.2 HOTFIX (nav/footer underline-draw, burger idle-hover, Card glow, Chip micro-lift, Input pre-focus border) — существующие ФУНКЦИОНАЛЬНЫЕ hover (Button/Card lift, VacancyCard стрелка) не трогать, они и так корректно работают через `:active`/tap-эквивалент (см. §M «Жёсткие ограничения» последний пункт).                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Verified clean                | Mobile nav (бургер+меню), smooth-scroll к `#about` с footer-ссылки, footer раскладка, tech-stack chip-грид, Process steps (1-колонка, connector-line корректно `hidden` <768px), careers empty-state (тизер+`/careers`) | Проверено на 320 — переносов/обрезаний/overlap НЕ найдено. Бургер 44×44px (соответствует §6.7). Смузи-скролл к `#about` останавливается на y=84.96 (за вычетом sticky-header 67px + запас) — `HEADER_OFFSET` (§M.4) работает верно живьём.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Изменений не требуется — зафиксировано как regression-baseline (см. скриншоты `home-320-nav-menu.png`, `home-320-about.png`, `home-320-footer.png`, `home-320-techstack.png`, `home-320-process.png`, `home-320-careers-teaser.png`, `careers-320.png`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**Не покрыто аудитом (примечание для Coder/PM, не дефект):** на момент аудита в БД 0 PUBLISHED
вакансий — `/careers/:slug` недостижим на живом проде (список пуст на всех страницах). Мобильная
раскладка детальной страницы визуально НЕ перепроверялась живьём в этом проходе — полагаться на
статичный fidelity-референс `assets/landing-redesign/vacancy-320.png` (§7) + §6.6 responsive-спеку;
после публикации первой живой вакансии — отдельный быстрый Mode B прогон `/careers/:slug` на 320/375/390.
Также замечена (не в скоупе дизайна, для информации PM/DevOps) CSP console-ошибка на `/careers`:
`Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/...' violates ... "script-src
'self'"` — блокируется браузером, инфраструктурный `Content-Security-Policy`-заголовок не выпускает
Cloudflare Insights beacon; не влияет на визуал/motion, но стоит завести отдельный DevOps-тикет.

### M v3.5 Verification-чеклист (дополняет §M.6 — то, что реально изменилось в v3)

- [ ] Ни один page-transition НЕ использует `AnimatePresence` (проверка кода — паттерн исключён
      сознательно, см. §M v3.1 «Почему всё ещё БЕЗ AnimatePresence»).
- [ ] Lift exit/enter — ТОЛЬКО `opacity`/`translateY`, никакого нового цветного/тёмного full-screen
      слоя (визуальная проверка + DOM-инспекция — `page-transition-overlay.tsx` из старого §M.3
      **удалён** вместе со scrim/caret-line кодом).
- [ ] Back-direction (`popstate` И `<BackLink>`) — `translateY` enter стартует с ОТРИЦАТЕЛЬНЫМ
      знаком (сверху), forward — с положительным (снизу) — визуально/через `getComputedStyle`
      в момент старта анимации.
- [ ] Title-morph играет ТОЛЬКО на переходах `/careers → /careers/:slug` и обратно, кликнутых
      ИМЕННО из `VacancyCard`/`BackLink` (не на прямом заходе, не с Home-тизера) — покрыть все 6
      фолбэков из таблицы §M v3.2 (Playwright: прямой заход на `/careers/:slug`, переход с `/`,
      `prefers-reduced-motion`, искусственно длинный заголовок вызывающий 2-строчный wrap на любом
      конце).
- [ ] Title-morph overlay — `pointer-events:none` всегда (клики сквозь него проходят), `willChange`
      снят после завершения (DOM-инспекция сразу после анимации, не должен остаться в inline style).
- [ ] iOS-перф: на `useCoarsePointer()===true` (эмулировать `page.emulateMedia({ 'pointer': 'coarse'
})` в Playwright, либо реальный touch-эмулятор) — `ScrollReveal` секции используют
      `useInView({once:true})`, НЕ `useScroll`/`useTransform` (проверка через React DevTools/props
      или через отсутствие continuous re-render на scroll — profiler).
- [ ] Nav sticky header на touch — `backdrop-filter` отсутствует в computed style (`getComputedStyle
(nav).backdropFilter === 'none'`), фон близок к непрозрачному (`~95%` alpha).
- [ ] Hero eyebrow-бейдж (Chip) — ноль случаев, где dot визуально не совпадает с первой строкой
      текста, на 320/375/390 (визуальная проверка + `getBoundingClientRect()` dot vs первая строка
      text-node, как в этом аудите, п.1 таблицы §M v3.4).
- [ ] Case-study метрики — ноль overlap между соседними колонками на 320/375/390 (`col[i].right <=
col[i+1].left`, все 3 карточки × все 3 метрики).
- [ ] `Lighthouse mobile ≥90` не регрессировал (тот же гейт, что §M.6, но с учётом нового overlay-
      клона title-morph — DOM-элемент создаётся/удаляется динамически, не должен оставаться в DOM
      после завершения ни при каком фолбэке/раннем прерывании навигации).

### M v3 addendum (implementation notes, 2026-07-25, MED-1 code-review)

Реализация (`apps/landing/app/routes/__root.tsx`, `apps/landing/app/lib/title-morph.ts`,
`apps/landing/app/components/marketing/careers-list.tsx`, `apps/landing/app/routes/careers_.$slug.tsx`)
отклонилась от буквы §M v3.1 шаги 5-7 в двух местах — оба отклонения обнаружены практикой
(E2E-верификация round 1 + ui-ux-designer Mode B fidelity-аудит round 1, PR #419) и являются
намеренными, задокументированными здесь fix-коммитами `a5510a57`/`e838e3ec`. Спека выше (§M v3.1
шаги 5-7) остаётся как есть — этот аддендум объясняет ГДЕ и ПОЧЕМУ реализация разошлась с буквой,
не переписывает саму спеку задним числом.

**1. Focus-management — `onResolved` + `useEffect`, НЕ `onAnimationComplete` (отклонение от §M v3.1
шаг 6/7).** Буква шага 6 прямо говорит «`onResolved` из старого шага 7 — не нужен вообще, убрать эту
подписку», а шаг 7 привязывает `focusMainLandmark` к `onAnimationComplete` enter-твина. На практике
это не работает: `onAnimationComplete`/само изменение `transition.pathname`-state срабатывают в
момент `onBeforeNavigate` — синхронно, ДО того, как асинхронный `loader` роута зарезолвился и
`<Outlet/>` реально подставил конечный DOM новой страницы. E2E (round 1) стабильно воспроизвела это
как race именно под `prefers-reduced-motion` (там нет анимационной задержки, которая на глаз
маскировала разрыв): фокус уезжал на `<main>`, который мгновение спустя подменялся, и
`document.activeElement` незаметно откатывался на `<body>`. Round-1 фикс (`a5510a57`) вернул
`onResolved`-подписку (тот же паттерн, что был в дореспековском §M.3). Round-2 фикс (`e838e3ec`) пошёл
дальше: `focusMainLandmark()` вызывается не инлайново сразу после `setTransition(...)` внутри
`onResolved`-обработчика, а из отдельного `useEffect`, зависящего от `transition.pathname` —
`setTransition` лишь ПЛАНИРУЕТ ре-рендер, синхронный вызов сразу после него ещё выполняется ДО того,
как React закоммитил этот рендер, и `document.querySelector('main')` в этот момент мог найти СТАРЫЙ
`<main>` (или ничего). `useEffect` по построению срабатывает строго ПОСЛЕ коммита DOM для рендера,
который выставил именно это значение `transition.pathname` — гарантированно финальный, уже
отрисованный узел. Оба фикса эмпирически подтверждены (ui-ux-designer round 1 + round 2): фокус
корректно уходит на `<main>`, включая под `prefers-reduced-motion`.

**2. `key`/`transition.pathname` — обновляется ТОЛЬКО из `onResolved`, НЕ из `onBeforeNavigate`
(усиливает, не противоречит букве шага 5 — шаг 5 не специфицировал источник `pathname` явно; round-1
реализация читала его из `onBeforeNavigate`'s `toLocation.pathname` оптимистично, что и стало HIGH
root cause ниже).** Round-1 fidelity-аудит (PR #419, `Design Review: BLOCK`) нашёл и локализовал
точной трассировкой стека: оптимистичный `key` до коммита роутера форсил React на немедленный
unmount+remount враппера, пока `<Outlet/>` внутри ещё резолвился в СТАРЫЙ маршрут (async `loader` не
успел закоммититься) — это порождало спуриозный лишний mount СТАРОЙ страницы, чей `useLayoutEffect`
(title-morph consumer) успевал первым вызвать one-shot `readPendingMorph()` и «съедал» морф раньше,
чем настоящий destination успевал смонтироваться. Итог — §M v3.2 shared-element title-morph НЕ играл
НИ В ОДНОМ направлении, при этом базовый лифт (§M v3.1) выглядел корректно и маскировал баг от
беглого визуального QA. Round-2 фикс (`e838e3ec`) убирает race у источника: `key` меняется только
когда роутер РЕАЛЬНО закоммитил переход (`onResolved`), спуриозного remount'а больше не происходит.

**3. `title-morph.ts` `readPendingMorph` — адресный по `consumerPathname` (второй, независимый слой
защиты).** Помимо фикса №2 у источника, `readPendingMorph(consumerPathname)` теперь дополнительно
сверяет `routePair.to === consumerPathname` — one-shot morph достаётся ТОЛЬКО тому компоненту, чей
собственный текущий `pathname` реально совпадает с destination навигации, независимо от порядка
срабатывания эффектов. Это защищает от того же класса race, если он когда-нибудь вернётся при
будущем рефакторинге `__root.tsx` (defense-in-depth, не полагается только на фикс №2).
`consumerPathname` передаётся через `useLocation({ select: (l) => l.pathname })`, и **намеренно
исключён из dependency array** consumer-эффектов (`careers-list.tsx`, `careers_.$slug.tsx`) — этот
хук реактивен и TanStack Router обновляет `router.state.location` на PENDING/целевой адрес рано, до
реального unmount текущего компонента; если бы `pathname` был в deps, эффект перезапустился бы на
ещё смонтированном SOURCE-компоненте в момент, когда pending-location уже переключился на
destination — тот же race на другом уровне. Эффект должен читать `pathname` как снятый при
ИСТИННОМ mount снэпшот (через closure), не как live-tracked значение.

**Верификация (ui-ux-designer Mode B, round 2, PR #419 `Fidelity: PASS`):** количественно (не только
визуально) — `getComputedStyle` timeline overlay-клона сопоставлен с реальной геометрией
destination-элемента (`getBoundingClientRect()`+`fontSize`) на 1440px в обоих направлениях: финальная
позиция/масштаб overlay совпадают с destination с точностью <1px / 4 знака после запятой на
`scaleFactor`. Все 4 применимых фолбэка (прямой заход, Home-тизер, `prefers-reduced-motion`,
многострочный guard) перепроверены — морф корректно НЕ играет, базовый лифт отрабатывает штатно.
