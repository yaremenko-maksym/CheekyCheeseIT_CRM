# CRM Project Memory Bank

## MCP серверы (активные) — ИСПОЛЬЗОВАТЬ В ПЕРВУЮ ОЧЕРЕДЬ

5 серверов работают. **Приоритет:** MCP → потом Bash/Read/grep.

| Задача | Какой MCP использовать |
|---|---|
| Найти функцию / класс / импорт в коде | **ast-grep** `find_code` / `find_code_by_rule` |
| Рефакторинг — найти все вхождения паттерна | **ast-grep** `find_code_by_rule` |
| Документация NestJS / TanStack / Zod / React | **context7** `resolve-library-id` → `get-library-docs` |
| Проверить структуру БД / выполнить SQL | **postgres** `query` |
| Проверить соответствие кода ESLint правилам | **eslint** |
| Проверить UI в браузере после изменений | **playwright** |
| PR / issues / commits на GitHub | **github** |

### ast-grep — структурный поиск по AST ✅
- Синтаксический поиск, не текстовый: находит `function foo()`, `class Bar`, импорты по паттерну
- Инструменты: `find_code`, `find_code_by_rule`, `dump_syntax_tree`, `test_match_code_rule`
- **Обязателен перед grep/find** — быстрее и точнее, не промахивается по вариантам синтаксиса

### context7 — документация по версиям ✅
- Инжектирует актуальную документацию: NestJS 11, TanStack Router 1.168, React, Zod v4, Drizzle
- Инструменты: `resolve-library-id` → `get-library-docs`
- **Используй вместо угадывания API** — особенно для TanStack Router validateSearch, Zod v4 syntax

### postgres — прямой доступ к БД ✅
- Инструменты: `query` — выполняет любой SQL против `crm_db` (13 таблиц, всё живое)
- **Используй вместо чтения schema.ts** для инспекции реальной структуры таблиц и данных
- Примеры: `SELECT * FROM information_schema.columns WHERE table_name='transactions'`, проверка seed-данных

### eslint — линтинг в реальном времени ✅
- Запускает правила из `apps/web/eslint.config.mjs` и `apps/api/eslint.config.mjs`
- **Используй перед тем как предложить код** — гарантирует что правки пройдут `pnpm lint`

### playwright — браузерная автоматизация ✅
- Скриншоты, клики, навигация на localhost:3000
- **Обязателен после каждого UI изменения** — запустить и сделать скриншот результата

### github — GitHub API ✅
- Работа с PR, issues, коммитами
- Требует `GITHUB_TOKEN` env var для полного доступа


## Обзор проекта
Высокопроизводительная CRM-система для рекрутинговых рабочих пространств.
**Основная цель:** Максимальная типобезопасность, скорость и профессиональный UX.

## Архитектура
- **Root (/):** Landing Page (Маркетинг).
- **App (/crm):** Защищённое рабочее пространство.
- **Auth:** Google SSO Only (ручной OAuth без Passport, JWT в HttpOnly cookie).
- **State:** TanStack Query + глобальный Auth Context.

## Технологический стек
- **Monorepo:** Turborepo + pnpm
- **Frontend:** React, **Vite SPA** + TanStack Router/Form/Query, Tailwind CSS v4, shadcn/ui, Framer Motion
- **Backend:** NestJS 11, Drizzle ORM (PostgreSQL), Redis
- **Validation:** Zod v4 (строго соблюдается)
- **Testing:** Vitest (Unit), Playwright (E2E/Flow)

## Архитектурные решения
- **Typeshare:** Общий пакет `packages/shared` для Zod-схем и типов.
- **Validation:** Все API запросы/ответы проходят через `.parse()`.
- **Animations:** Framer Motion для микро-взаимодействий и переходов.
- **Routing:** Root (/) для Landing, Prefix (/crm) для App Workspace с отдельным Layout.
- **Auth:** Ручной Google OAuth без Passport — меньше зависимостей, нет проблем совместимости с Fastify.
- **Frontend bundler:** Vite SPA (НЕ TanStack Start/vinxi) — SSR не нужен для CRM.

## Ключевые ограничения версий
- **Vite:** `^6.4`
- **TanStack Router:** `^1.168` + `@tanstack/router-plugin ^1.168` (должны совпадать!)
- **Node:** 20 LTS
- **pnpm:** 7.32.4

## Структура монорепо
```
/
├── apps/
│   ├── web/          # Vite SPA + TanStack Router (vite | :3000)
│   └── api/          # NestJS 11 + Fastify (nest start --watch | :3001)
├── packages/
│   └── shared/       # Zod schemas + types (Single Source of Truth)
├── turbo.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Команды
```bash
pnpm dev           # запустить все приложения параллельно
pnpm build         # собрать все (shared → api & web)
pnpm typecheck     # проверить типы во всех пакетах
pnpm test          # запустить все тесты

# Отдельные пакеты:
pnpm --filter @crm/web dev
pnpm --filter @crm/api dev
pnpm --filter @crm/shared typecheck
```

## Ключевые технические заметки
- **routeTree.gen.ts** генерируется `@tanstack/router-plugin` (Vite plugin). Обновляется автоматически при `vite dev`.
- **Vite SPA**: `app/client.tsx` — точка входа (`createRoot` + `RouterProvider`). `index.html` в корне `apps/web/`.
- **Fastify**: принудительно через `pnpm.overrides` на `^5.8.5` (конфликт с `@fastify/helmet`).
- **pnpm.overrides**: НЕ добавлять overrides для `@tanstack/router-*` пакетов — это сломало предыдущую сборку.
- **TanStack Router + Plugin**: версии ОБЯЗАНЫ совпадать (`^1.168.x`). Иначе peer-конфликт в pnpm.
- **Tailwind v4 dark mode**: `@custom-variant dark (&:is(.dark *))` + `class="dark"` на `<html>` в `index.html`.
- **shadcn/ui tokens**: `@theme inline {}` маппит CSS vars → Tailwind utilities. `:root` = light, `.dark` = dark.
- **`exactOptionalPropertyTypes`**: Radix CheckboxItem `checked` — деструктурировать нельзя, передавать через `...props`.
- **tw-animate-css**: CSS-пакет для анимаций Tailwind v4 (`@import "tw-animate-css"` в globals.css).
- **`@crm/shared` + API tsconfig**: Добавлены `"main"` и `"types"` в `packages/shared/package.json` для совместимости с `moduleResolution: "Node"`. API tsconfig использует `"ignoreDeprecations": "5.0"` для подавления предупреждения.

## Auth (Google OAuth)
- **Схема:** `GET /api/auth/google` → redirect в Google → `GET /api/auth/google/callback` → проверка email в БД → JWT cookie → redirect на `/crm`
- **Строгая проверка:** Если email не в таблице `users` — redirect на `/login?error=unauthorized` (403)
- **JWT:** HttpOnly cookie, 7 дней, signed `@nestjs/jwt`, payload = `SessionUser` из `@crm/shared`
- **State CSRF:** Случайный state в signed cookie `oauth_state`, TTL 600 сек
- **Endpoints:** `GET /api/auth/google`, `GET /api/auth/google/callback`, `GET /api/auth/me`, `GET /api/auth/logout`

## База данных (Drizzle ORM)
- **Schema:** `apps/api/src/database/schema.ts` — таблица `users` (id, email, displayName, avatar, role, googleId, createdAt, updatedAt)
- **Enum roles:** `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT`
- **Миграции:** `pnpm --filter @crm/api drizzle-kit generate` / `drizzle-kit migrate`
- **Config:** `apps/api/drizzle.config.ts`

## Компоненты дизайн-системы (`app/components/ui/`)
`button` · `input` · `label` · `card` · `badge` (с role variants) · `separator` · `skeleton` · `avatar` · `sonner` · `scroll-area` · `tooltip` · `dropdown-menu` · `dialog` · `sheet`

## Frontend Auth (`apps/web/app/`)
- **AuthContext:** `context/auth.tsx` — `useAuth()` хук, `AuthProvider` обёртка. Только клиент (`enabled: typeof window !== 'undefined'`), `staleTime: 5 мин`.
- **Login страница:** `routes/login.tsx` — Google SSO кнопка, обработка ошибок (`?error=unauthorized|google_error|invalid_state`), авторедирект в `/crm` если уже залогинен.
- **Защита CRM:** `routes/crm/route.tsx` — `useEffect` редирект в `/login` если не аутентифицирован. Скелетон при загрузке. Шапка с реальным именем/аватаром пользователя + выпадающее меню с ролью и кнопкой выхода.
- **routeTree.gen.ts:** Обновлять вручную при добавлении новых роутов (авто-генерируется `pnpm dev`).

## Drizzle миграции
- Первая миграция: `apps/api/drizzle/migrations/0000_lethal_dark_beast.sql` — создаёт enum `role` + таблицу `users`.
- Seed: `pnpm --filter @crm/api db:seed` — добавляет начальных пользователей из `src/database/seed.ts`.
- Docker: `docker-compose up -d` — поднимает Postgres + Redis локально.

## Текущий статус
- [x] Environment Setup (MCP, .clauderules, .claudeignore)
- [x] Initialize Turborepo structure (`apps/web`, `apps/api`, `packages/shared`)
- [x] Setup Base apps (env validation, health endpoint, helmet, CORS, throttler, QueryClient, Axios)
- [x] Setup Design System (shadcn/ui + Tailwind v4 + dark mode + landing + dashboard preview)
- [x] Google OAuth в NestJS (ручной OAuth, JWT cookie, строгая проверка email)
- [x] Drizzle миграции + docker-compose + seed скрипт
- [x] Frontend Auth (AuthContext, Login страница, защищённый /crm layout)
- [x] Миграция с TanStack Start/vinxi → Vite SPA (typecheck 4/4, dev server :3000)
- [x] Лендинг компании (/) — outsource/outstaffing, AI/EdTech/E-Commerce, анимированный терминал в Hero
- [x] Playwright E2E setup (apps/e2e)
- [x] **PHASE 1:** Layout — Sidebar + Header
- [x] **PHASE 2:** Команда (Team management) — teams + team_members таблицы, NestJS TeamsModule, GET /api/users, frontend с карточками/диалогами/RBAC
- [x] **PHASE 3:** Проекты (Projects) — projects + project_members таблицы, NestJS ProjectsModule, frontend с карточками/фильтрами/диалогами/RBAC
- [x] **PHASE 4:** Собеседования (Interviews Kanban) — interviews таблица, NestJS InterviewsModule, Kanban DnD (dnd-kit) + button move, search params `?seniorId=`, HR переключение досок
- [x] **PHASE 7 (partial):** Профили — `/crm/profile` (редактирование своего), `/crm/users/:id` (просмотр), telegram+phone в БД, ссылки на профили из team/projects/interviews
- [x] **PHASE 5:** Финансы — мониторинг (Finance tracking) — transactions, expenses, invoices, payouts, juniorPayments, NBU rates, PDF invoice, etherscan
- [ ] **PHASE 6:** База знаний + Документы
- [ ] **PHASE 7:** Профиль (полный)
- [ ] **PHASE 8:** Финансы — смарт-контракты (USDT ERC-20)
- [ ] **PHASE 9:** Дашборд (после определения контента)

## Лендинг (/)
- **Позиционирование:** Outsource/Outstaffing компания — AI, EdTech, E-Commerce
- **Без ссылки на CRM** — только публичная страница компании
- **Анимация:** Терминал в Hero с typewriter-эффектом, циклирует сниппеты по трём доменам (Python/TypeScript), цветной курсор + ambient glow
- **Секции:** Nav (sticky) · Hero (2 колонки) · Stats (4 числа) · Services (3 карточки) · Stack (badge-теги) · Careers CTA · Footer

---

## Детальный план разработки

### PHASE 1 — Layout: Sidebar + Header
**Цель:** Полноценный shell для всех будущих модулей.

**Sidebar — RBAC навигация (видимость по ролям):**
| Пункт | ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT |
|---|---|---|---|---|---|
| Дашборд | ✓ | ✓ | ✓ | ✓ | ✓ |
| Профіль | ✓ | ✓ | ✓ | ✓ | ✓ |
| Команда | ✓ | ✓ | ✓ | ✓ | ✓ |
| Проекти | ✓ | ✓ | ✓ | ✓ | ✓ |
| Фінанси | ✓ | ✓ | ✓ | ✓ | ✓ |
| Співбесіди | ✓ | ✓ | — | ✓ | — |
| Документи | ✓ | ✓ | ✓ | ✓ | ✓ |
| База знань | ✓ | ✓ | ✓ | ✓ | ✓ |

**Header:**
- Лого + назва → navigate `/crm/dashboard`
- Иконка поиска (глобальный поиск — заглушка на старте)
- Колокольчик уведомлений (badge с кол-вом непрочитанных)
- Аватар + dropdown (имя, роль, выход)

**Технические задачи:**
- `NavSidebar` компонент с коллапсом (desktop) и sheet (mobile)
- Роуты-заглушки для всех модулей: `/crm/dashboard`, `/crm/team`, `/crm/projects`, `/crm/finance`, `/crm/interviews`, `/crm/documents`, `/crm/knowledge`, `/crm/profile`
- `NotificationsContext` — хранит список уведомлений, счётчик непрочитанных

---

### PHASE 2 — Команда (Team Management)
**Бизнес-логика:**
- Команда = HR + SENIOR(ы) + JUNIOR(ы) + ACCOUNTANT (добавляется автоматически, один на компанию)
- ADMIN видит все команды (макс 10), может создавать/редактировать любую
- HR видит только свои команды (3-4 синьора = 3-4 команды), может редактировать состав
- JUNIOR может быть в нескольких командах одновременно
- SENIOR, JUNIOR, HR, ACCOUNTANT видят список своей команды (read-only)

**DB схема (новые таблицы):**
```sql
teams: id, name, createdAt
team_members: id, teamId, userId, joinedAt
```

**Роуты:**
- `GET /api/teams` — список команд (ADMIN: все, HR: свои)
- `POST /api/teams` — создать команду (ADMIN, HR)
- `PATCH /api/teams/:id` — редактировать (ADMIN, HR-owner)
- `DELETE /api/teams/:id` — удалить (ADMIN only)
- `POST /api/teams/:id/members` — добавить участника
- `DELETE /api/teams/:id/members/:userId` — удалить участника

**UI:**
- Список карточек команд с составом
- Modal создания/редактирования команды
- Поиск и фильтры по роли/имени
- ADMIN/HR: кнопки управления, остальные: только просмотр

---

### PHASE 3 — Проекты (Projects)
**Бизнес-логика:**
- Проект создаётся когда синьер подписал договор с компанией
- Проект содержит: название компании, домен, дата начала, синьер, джун(ы), ставка, валюта, статус (active/closed)
- Проект закрывается когда синьера увольняют
- К проекту прикрепляются документы (договора, инвойсы) — ссылки на файлы в S3

**DB схема:**
```sql
projects: id, name, companyName, domain, startDate, endDate, seniorId,
          rate, currency(USDT/USD/EUR), status(active/closed), createdAt
project_members: id, projectId, userId, role, joinedAt, leftAt
```

**Роуты:**
- `GET /api/projects` — ADMIN/ACCOUNTANT: все; SENIOR: свои; HR: проекты синьоров из своих команд; JUNIOR: проекты где активный member
- `POST /api/projects` — ADMIN, HR
- `PATCH /api/projects/:id` — ADMIN, HR
- `POST /api/projects/:id/members` — добавить джуна

**UI:**
- Список проектов с карточками (компания, синьер, джун, ставка, статус)
- Детальная страница проекта
- Поиск + фильтр по статусу/синьору

---

### PHASE 4 — Співбесіди (Interviews Kanban)
**Бизнес-логика:**
- HR общается от имени синьора с рекрутерами
- Канбан-доска персональная для каждого синьора
- ADMIN видит все доски; HR видит доски своих синьоров; SENIOR видит только свою
- Карточка собеседования содержит: компания, ссылка на вакансию, ссылка на звонок, этап
- SENIOR вносит данные после каждого этапа: домен, технологии, техника, состав команды, бенефиты, пересмотр ЗП, тип оплаты (ФОП/гиг/крипта), заметки

**Колонки Kanban:**
`HR Screen` → `English Check` → `Tech Interview` → `Final Interview` → `Offer Received` → `Hired` / `Rejected` / `Archived`

**DB схема:**
```sql
interviews: id, seniorId, hrId, companyName, vacancyUrl, callUrl,
            stage(hr/english/tech/final/offer/hired/rejected/archived),
            notes(json), createdAt, updatedAt
```

**UI:**
- Kanban с drag-and-drop (dnd-kit)
- Детальная карточка с формой заметок синьора
- HR выбирает доску синьора из списка
- История перемещений карточки

---

### PHASE 5 — Фінанси: Моніторинг
**Бизнес-логика:**
1. SENIOR получает зарплату → вносит транзакцию (дата, сумма, валюта, проект, прикрепляет чек)
2. ACCOUNTANT получает уведомление → валидирует транзакцию
3. После валидации — у синьора разблокируется кнопка "Оплатить услуги"
4. Синьор оставляет себе 26%, остальные 74% платит на смарт-контракт (Phase 8)
5. Пока смарт-контракт не готов — просто фиксируем факт оплаты вручную

**Доступ по ролям:**
- SENIOR: видит свои транзакции + личный баланс
- ACCOUNTANT: видит все транзакции всех синьоров, валидирует
- ADMIN: видит всё
- HR: видит список проектов (без сумм)
- JUNIOR: не видит финансов (нет доступа к разделу)

**DB схема:**
```sql
transactions: id, seniorId, projectId, amount, currency, date,
              status(pending/validated/rejected), receiptUrl,
              validatedBy, validatedAt, notes, createdAt
project_finance_settings: id, projectId, juniorSalary, juniorWalletOverride,
                          adminShare(50), partnerShare(50), createdAt
```

**UI:**
- Таблица транзакций с фильтрами (проект, период, статус)
- Форма добавления транзакции (SENIOR) с загрузкой чека
- Кнопка валидации (ACCOUNTANT)
- Личный баланс синьора (сколько зашло / сколько причиталось нам)

---

### PHASE 6 — База знань + Документи
**База знань — доступ по ролям:**
- ADMIN: всё
- SENIOR: Корисні ресурси + своя Легенда (легенда = профиль для проекта: ФИО, дата рождения, адрес, хобби — то что знает компания)
- JUNIOR: Легенда синьора (своего), Корисні ресурси по напряму, Курси
- HR: Корисні ресурси + Легенди синьорів (своих)
- ACCOUNTANT: Таблиця даних про всіх співробітників (ФИО, email, телефон, телеграм, кошелёк)

**Документи:**
- Хранилище: AWS S3 с обязательным сжатием перед загрузкой (sharp для изображений, pdf-lib для PDF)
- Категории: Резюме (ADMIN/HR/SENIOR), Скани документів (ADMIN/HR/SENIOR), Договори (ADMIN, SENIOR — свои)
- Метаданные в БД, файл в S3

**DB схема:**
```sql
documents: id, ownerId, projectId, category(resume/scan/contract/invoice),
           name, s3Key, sizeBytes, mimeType, uploadedBy, createdAt
knowledge_articles: id, title, content(markdown), category, accessRoles(json), authorId, createdAt
legends: id, userId, fullName, birthDate, address, hobbies, notes(json), createdAt, updatedAt
```

---

### PHASE 7 — Профіль
- Фото (загрузка в S3 со сжатием)
- Имя, email (read-only — из Google), телефон, Telegram
- **USDT кошелёк** (обязательно для JUNIOR и SENIOR — используется смарт-контрактом)
- Смена кошелька — с подтверждением (важно для безопасности)
- Легенда (для SENIOR — редактируемая)

---

### PHASE 8 — Смарт-контракти (USDT ERC-20)
**Архитектура:**
- Solidity контракт `PaymentSplitter` деплоится один раз (или per-project)
- Принимает USDT ERC-20, автоматически распределяет:
  - Джуну: фиксированная сумма (из `project_finance_settings`)
  - Остаток 50/50: ADMIN кошелёк + партнёр кошелёк
- Адреса получателей конфигурируются при деплое проекта
- Frontend: ethers.js для подписания транзакции MetaMask/WalletConnect

**Генерация инвойса:**
- PDF генерируется на бэке (pdfmake или puppeteer)
- Содержит: проект, период, сумма, адрес контракта, хэш транзакции

**Технологии:**
- Hardhat (разработка/тесты контракта)
- ethers.js v6 (frontend взаимодействие)
- **Ethereum mainnet** (USDT ERC-20) — решение принято. При необходимости мигрировать на TRC-20.

---

### PHASE 9 — Дашборд
Содержание определяется позже после опыта работы с системой.
Потенциально: список активных проектов, последние транзакции, ближайшие собеседования.

---

## Бизнес-логика (ключевые правила)
- **Команды:** макс 10, ACCOUNTANT добавляется автоматически в каждую
- **Финансовый флоу:** SENIOR вносит транзакцию → ACCOUNTANT валидирует → SENIOR платит 74% на смарт-контракт
- **Распределение:** JUNIOR получает фиксированную сумму первым, остаток 50/50 между ADMIN и партнёром
- **Кошельки:** каждый пользователь хранит свой USDT адрес в профиле, можно менять
- **Легенда:** профиль синьора для клиентской компании — видят ADMIN, HR своего синьора, JUNIOR своего синьора
- **Канбан:** доска персональная у каждого синьора, история этапов сохраняется (архив = не удаление)
- **S3:** все файлы сжимаются перед загрузкой (изображения через sharp, PDF через pdf-lib)
- **Уведомления:** in-app колокольчик (Phase 1), Telegram/Email — в будущем
- **Валюта:** только USDT ERC-20 для выплат через смарт-контракт

## Активный контекст
- PHASE 1–5 полностью реализованы и работают
- Finance модуль: transactions, expenses, invoices, payouts, juniorPayments, NBU exchange rates, PDF invoice generation, etherscan integration
- Миграции: 0000–0011 применены (включая finance, partner_ledger, exchange_rate, project_logo)
- Следующий шаг: **PHASE 6** — База знаний + Документы

---

## Реализованные модули — технические детали

### Teams (PHASE 2) — ключевые особенности
- **JUNIOR в команде — производное состояние**, не хранится в `team_members`. `TeamsService.mapTeam()` получает JUNIORов из `project_members` WHERE `leftAt IS NULL` AND `project.seniorId = team's senior`
- **ADMIN исключён** из всех команд — `users.service.ts` фильтрует `ne(role, 'ADMIN')`, `addMember` бросает 400 если роль ADMIN
- **Защита ключевых членов:** нельзя удалить SENIOR (только удалить команду), последнего HR, последнего ACCOUNTANT
- `team_members` хранит: HR, SENIOR, ACCOUNTANT — НЕ JUNIOR

### Projects (PHASE 3) — ключевые особенности
- `project_members.leftAt` — soft delete: NULL = активный, timestamp = ушёл
- Только JUNIOR можно добавить как member (`addMember` проверяет роль)
- RBAC: ADMIN/ACCOUNTANT видят всё; SENIOR — только свои; HR — проекты синьоров из своих команд (через team_members); JUNIOR — где активный member
- Закрытие проекта: PATCH /api/projects/:id со `{ status: 'CLOSED', endDate: now }` — не удаляет, архивирует
- `seniorId` — FK на users.id, прямо в таблице projects (не через project_members)

### Interviews Kanban (PHASE 4) — ключевые особенности
- **DnD:** dnd-kit с `closestCenter` — обязательно! Без этого cross-column drag не работает
- Каждый `KanbanColumn` имеет `useDroppable({ id: stage })` — позволяет дроп в пустую колонку
- `interviews.position` — integer, ренормализуется при каждом move в обоих стейджах
- `?seniorId=<uuid>` в URL через TanStack Router `validateSearch` + `useSearch` — HR переключает доски
- SENIOR видит только свою доску (effectiveSeniorId = user.id, нет переключения)
- HR может создавать карточки на доске любого своего синьора
- Стейджи: `HR_SCREEN | ENGLISH_CHECK | TECH_INTERVIEW | FINAL_INTERVIEW | OFFER_RECEIVED | HIRED | REJECTED | ARCHIVED`
- Перемещение через кнопки в диалоге редактирования карточки — дополнительно к DnD

### Drizzle миграции (актуально, 0000–0011)
- `0000_*` — users + role enum
- `0001_*` — teams + team_members
- `0002_*` — projects + project_members + enums (currency, project_status)
- `0003_*` — interviews + interview_stage enum
- `0004–0011` — finance: transactions, expenses, junior_payments, invoices, invoice_transactions, payouts, payout_transactions, partner enum, exchange_rate, project_logo
- Seed: `pnpm --filter @crm/api db:seed` — создаёт пользователей, команды, проекты, собеседования

### DB таблицы (актуально)
`users` · `teams` · `team_members` · `projects` · `project_members` · `interviews` · `transactions` · `expenses` · `junior_payments` · `invoices` · `invoice_transactions` · `payouts` · `payout_transactions`

### Shared schemas (packages/shared/src/schemas/)
- `auth.ts` — SessionUser, googleCallbackSchema
- `teams.ts` — teamMemberSchema, teamSchema, createTeamSchema, updateTeamSchema, addTeamMemberSchema
- `projects.ts` — projectMemberSchema, projectSchema, createProjectSchema, updateProjectSchema, addProjectMemberSchema
- `interviews.ts` — interviewStageSchema, interviewSchema, createInterviewSchema, updateInterviewSchema, moveInterviewSchema
- `finance.ts` — transactionSchema, createTransactionSchema, validateTransactionSchema, submitPaymentSchema, expenseSchema, createExpenseSchema, invoiceSchema, createInvoiceSchema, signInvoiceSchema, payoutSchema, createPayoutSchema, submitPayoutSchema, juniorPaymentSchema, partnerBalanceSchema, financeSummarySchema, nbuRateSchema
- `users.ts` — userSchema и связанные типы
- `api.ts` — общие API типы

### Finance модуль (PHASE 5) — ключевые особенности
- `transactions` — доход SENIOR от проекта; статусы: PENDING → VALIDATED → PENDING_PAYMENT → PAID / REJECTED
- `expenses` — расходы компании (ADMIN/ACCOUNTANT), типы через `expense_type` enum
- `junior_payments` — выплаты джунам, привязаны к проекту
- `invoices` + `invoice_transactions` — инвойс объединяет транзакции; статусы: DRAFT → SIGNED / CANCELLED
- `payouts` + `payout_transactions` — выплаты партнёрам (MAKSYM/KOSTYA); статусы: PENDING_PAYMENT → PAID / CANCELLED
- `nbu-currency.service.ts` — получает курсы валют от НБУ
- `etherscan.service.ts` — интеграция с Etherscan для верификации крипто-транзакций
- `pdf-invoice.service.ts` — генерация PDF инвойсов
