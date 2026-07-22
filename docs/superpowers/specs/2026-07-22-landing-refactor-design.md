# Landing Refactor + Vacancies — Design Spec

**Дата:** 2026-07-22
**Статус:** APPROVED (владелец, чат-сессия 2026-07-22)
**Скоуп:** редизайн `apps/landing` до уровня топовых IT-студий + модуль вакансий в CRM (ADMIN/HR) + публичный приём резюме.

---

## 1. Цель и контекст

Лендинг (`cheekycheese.tech`) сейчас — сырой одностраничник. Нужен профессиональный
лендинг уровня Linear/Vercel: блоки «о нас» и «наши проекты», страницы вакансий,
публичная форма отклика с CV. Вакансии управляются из CRM ролями **ADMIN и HR**.

**Ключевой продуктовый факт:** вакансии — канал найма **новых SENIOR'ов**. Отклики
живут внутри раздела вакансий CRM и **НЕ связаны** с канбаном собеседований
(interviews) — тот обслуживает другой процесс.

**Решения владельца (зафиксированы):**

| Вопрос                 | Решение                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Язык лендинга          | Только английский                                                                       |
| Структура              | Одностраничник `/` + `/careers` + `/careers/:slug`                                      |
| Блок «проекты»         | 3–4 анонимных кейса (драфтует ассистент, владелец правит фактуру)                       |
| Отклики → CRM          | Раздел внутри вакансии; удаляемы; БЕЗ интеграции с interviews-канбаном                  |
| CV                     | PDF ≤ 5MB (файл) + опциональные LinkedIn/GitHub ссылки                                  |
| Спам-защита            | Cloudflare Turnstile + rate-limit + honeypot                                            |
| Ретеншн                | Ручное удаление + авто-пурж: REJECTED > 90д; отклики вакансий, закрытых > 90д назад     |
| Дизайн-процесс         | Claude Design Tier 1 с участием владельца (все 4 класса устройств)                      |
| Визуальное направление | Эволюция бренда: дарк + фирменный жёлтый + dev-мотивы (терминал), уровень Linear/Vercel |
| Анимации               | Премиум-сдержанные (Framer Motion; без WebGL/3D)                                        |
| «О нас»                | Без персоналий (миссия, подход, цифры, ценности)                                        |
| Зарплатная вилка       | НЕ показывается и НЕ хранится (полей нет — YAGNI)                                       |

**Отклонённые альтернативы:** внешний ATS/форма (нет CRM-управления, данные у третьей
стороны); статические вакансии в репо (нет управления из CRM).

---

## 2. Лендинг (`apps/landing`)

### 2.1. Роуты и секции

- **`/`** (редизайн текущей страницы):
  1. **Hero** — эволюция анимированного терминала (крупнее, живее), заголовок, CTA.
  2. **About us** — миссия, подход, цифры (обновлённые stats), ценности. Без фото/имён.
  3. **Case studies** — 3–4 анонимных кейса по доменам (AI / EdTech / E-Commerce):
     формат challenge → solution → metrics. Контент — драфт ассистента, правит владелец.
  4. **Services** — существующие 3 домена, углублённые.
  5. **How we work** — процесс-таймлайн (discovery → build → ship → support). Новая секция.
  6. **Tech stack** — существующие чипы, полировка.
  7. **Careers-тизер** — до 3 живых PUBLISHED вакансий из API + ссылка на `/careers`.
     При 0 вакансий секция показывает CTA «write to hr@cheekycheese.tech» (mailto), не скрывается.
  8. **Contact / Footer**.
- **`/careers`** — список PUBLISHED вакансий (title, domain, seniority, location),
  **без фильтров/табов** (решение владельца 2026-07-23: показываем весь список как есть).
  Empty state: «no open roles» + mailto.
- **Контактный имейл везде** (nav CTA, contact, footer, careers empty state):
  `hr@cheekycheese.tech` — других имейлов на лендинге не остаётся.
- **`/careers/:slug`** — деталка вакансии (markdown-описание, отрендеренный HTML) +
  форма отклика + success-состояние после отправки.

### 2.2. Форма отклика (поля)

| Поле            | Обязательность                   | Валидация                    |
| --------------- | -------------------------------- | ---------------------------- |
| Full name       | required                         | 2–120 chars                  |
| Email           | required                         | email                        |
| Telegram        | optional                         | @handle / t.me ссылка        |
| LinkedIn URL    | optional                         | https URL                    |
| GitHub URL      | optional                         | https URL                    |
| Cover letter    | optional                         | ≤ 2000 chars                 |
| CV (PDF)        | required                         | PDF, ≤ 5MB (клиент + сервер) |
| Turnstile token | required (invisible widget)      | server-side siteverify       |
| Honeypot        | скрытое поле, должно быть пустым | заполнено → silent reject    |

Email-подтверждение кандидату — **out of scope v1** (email-инфры в проекте нет).
Кандидат видит success-экран. Дубль-защита: тот же email + та же вакансия в течение
24ч → 429 с понятным сообщением.

### 2.3. Технические решения лендинга

- Данные — **loader'ы TanStack Router + `fetch`** на same-origin `/api`
  (nginx уже проксирует `cheekycheese.tech/api → api:3001`; конфиг менять не нужно).
  React-query на лендинг НЕ добавляем.
- Dev: в `apps/landing/vite.config.ts` добавить `server.proxy` `/api → localhost:3001`.
- Форма — контролируемая + Zod-схема из `@crm/shared` (лендинг уже билдит shared
  в Dockerfile). TanStack Form не добавляем.
- Анимации: Framer Motion (уже в deps) — scroll-reveal, gradient glow,
  micro-interactions, magnetic-кнопки, живой терминал. `prefers-reduced-motion`
  уважается (штатные механизмы Framer Motion + отключение декоративных циклов).
- SEO: per-route `<title>` + meta/OG-теги (документ-хед апдейтится в роуте; SSR нет
  и не планируется).
- Turnstile site key попадает в билд через `VITE_TURNSTILE_SITE_KEY`
  (build ARG в `apps/landing/Dockerfile` + GHA secret; dev — `.env`).
- Responsive — hard-гейт: 320/375/768/1024/1280/1440/1920, mobile-first,
  без горизонтального overflow, тач-таргеты ≥ 44px (`rules/common/responsive-design.md`).

---

## 3. БД и API (`apps/api`, новый модуль `vacancies`)

### 3.1. Таблицы (Drizzle-миграция; прод-DDL — только через deploy.yml)

**`vacancies`**

| Колонка                  | Тип                                       | Примечание                                             |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------ |
| id                       | uuid PK                                   |                                                        |
| slug                     | text UNIQUE                               | генерируется из title, редактируем до publish          |
| title                    | text                                      |                                                        |
| description_md           | text                                      | markdown                                               |
| domain                   | enum `AI \| EDTECH \| ECOMMERCE \| OTHER` |                                                        |
| seniority                | enum `SENIOR \| LEAD`                     | канал найма синьоров; расширяемо                       |
| employment_type          | enum `FULL_TIME \| PART_TIME \| CONTRACT` |                                                        |
| location                 | text                                      | напр. «Remote (Europe)»                                |
| status                   | enum `DRAFT \| PUBLISHED \| CLOSED`       | DRAFT → PUBLISHED → CLOSED; из CLOSED можно re-publish |
| published_at / closed_at | timestamp nullable                        |                                                        |
| created_by               | uuid FK users                             |                                                        |
| created_at / updated_at  | timestamp                                 |                                                        |

**`vacancy_applications`**

| Колонка                              | Тип                                 | Примечание                                             |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------ |
| id                                   | uuid PK                             |                                                        |
| vacancy_id                           | uuid FK vacancies ON DELETE CASCADE |                                                        |
| full_name                            | text                                |                                                        |
| email                                | text                                |                                                        |
| telegram / linkedin_url / github_url | text nullable                       |                                                        |
| cover_letter                         | text nullable                       | ≤ 2000                                                 |
| resume_s3_key                        | text                                | префикс `vacancy-applications/<vacancyId>/<appId>.pdf` |
| resume_size_bytes                    | integer                             | после сжатия                                           |
| status                               | enum `NEW \| VIEWED \| REJECTED`    |                                                        |
| created_at                           | timestamp                           |                                                        |

**Почему НЕ таблица `documents`:** она привязана к `users` (ownerId/uploadedBy),
а кандидаты — не юзеры. Прямой R2-ключ на строке отклика проще, дешевле и
изолирован от user-документов. Переиспользуем `S3Service` + `CompressionService`
как сервисы, не таблицу.

### 3.2. Endpoints

**Публичные (без auth, отдельный контроллер `public-vacancies.controller.ts`):**

- `GET /api/public/vacancies` — только PUBLISHED; поля: slug, title, domain,
  seniority, employmentType, location, publishedAt. Без счётчиков откликов.
- `GET /api/public/vacancies/:slug` — то же + descriptionMd. 404 для
  DRAFT/CLOSED/несуществующих (не раскрываем существование).
- `POST /api/public/vacancies/:slug/apply` — multipart (поля + PDF).
  Пайплайн защиты — §4. Ответ 201 `{ ok: true }` без id (не раскрываем внутренние id).

**Приватные (JwtGuard + RolesGuard `@Roles(ADMIN, HR)`):**

- `GET /api/vacancies` (все статусы, + счётчик откликов) · `POST /api/vacancies` ·
  `PATCH /api/vacancies/:id` (правки + смена статуса) · `DELETE /api/vacancies/:id`
  (только DRAFT без откликов; иначе — закрывать).
- `GET /api/vacancies/:id/applications` · `PATCH …/applications/:appId`
  (status NEW→VIEWED→REJECTED) · `DELETE …/applications/:appId` (строка + R2-объект) ·
  `GET …/applications/:appId/resume-url` (presigned GET, TTL 10 мин,
  `S3Service.getPresignedDownloadUrl`).

Zod-схемы всех DTO — `packages/shared/src/schemas/vacancies.ts`, экспорт из index.

### 3.3. RBAC: кто смотрит → что видит

| Роль                                | Вакансии                      | Отклики / CV                           |
| ----------------------------------- | ----------------------------- | -------------------------------------- |
| Аноним (лендинг)                    | только PUBLISHED (public DTO) | ничего (403/404)                       |
| ADMIN, HR                           | все статусы, CRUD             | полный доступ, скачивание CV, удаление |
| SENIOR / JUNIOR / ACCOUNTANT / DROP | 403 на приватные endpoints    | 403                                    |

Сайдбар CRM: пункт «Вакансии» виден только ADMIN/HR (надпись — консистентно
с текущим языком сайдбара).

---

## 4. Защита публичного `apply` (security-критично)

Порядок проверок (fail-fast, дешёвые раньше дорогих):

1. **Rate-limit** по IP — отдельный жёсткий бакет существующего throttler'а
   (порядок: ~5 попыток/час на IP на apply; списки вакансий — мягче).
2. **Honeypot** — заполнено → 201-мимикрия (silent drop, лог).
3. **Turnstile** — server-side POST на CF siteverify с `TURNSTILE_SECRET_KEY`;
   невалидный токен → 400.
4. **Дубль** — email+vacancy за 24ч → 429.
5. **Размер** ≤ 5MB (multipart limit на Fastify-уровне + проверка буфера).
6. **MIME + magic-bytes** — только `application/pdf`, паттерн
   `detectMimeFromBuffer` из documents-модуля; несовпадение → 415.
7. **Сжатие + strip метаданных** — `CompressionService.compressPdf`.
8. **Персист** — DB-row-first, затем R2 upload, компенсация (delete row) при
   падении R2 — паттерн `DocumentsService.upload`.
9. **Нотификация** — `NotificationsService.create` каждому ADMIN/HR:
   новый `NotificationType` `VACANCY_APPLICATION`, link на CRM-страницу вакансии.

Инпуты санитизируются Zod-схемой; markdown вакансий рендерится на лендинге
безопасным рендерером (санитизация HTML). PII кандидатов (email/telegram) не
попадает в логи. **security-reviewer обязателен на PR** (public endpoint +
file upload + RBAC + PII).

---

## 5. Ретеншн (оптимизация хранения)

- **Ручное**: DELETE отклика в CRM удаляет строку + R2-объект
  (`S3Service.delete` идемпотентен).
- **Cron** (паттерн salary-cron, ежесуточно):
  - отклики `status=REJECTED` c `created_at` старше 90 дней → удалить (строка + R2);
  - отклики вакансий с `closed_at` старше 90 дней → удалить (строка + R2).
    Fail-loud логирование количества удалённого; ошибки R2 не прерывают батч
    (объект догоняется следующим прогоном).

---

## 6. CRM-экраны (`apps/web`)

- **`/vacancies`** — таблица/карточки вакансий: статус-бейджи, счётчик откликов,
  создание (диалог/форма), publish/close-действия.
- **`/vacancies/:id`** — редактирование полей + markdown-редактор описания
  (переиспользуем существующий lazy CodeMirror) + **таб «Отклики»**: карточки
  кандидатов (имя, контакты, cover letter, дата), скачивание CV (presigned),
  смена статуса, удаление с конфирм-диалогом. Индикатор NEW.
- Дизайн — синканная система `CheekyCheeseIT CRM` (Claude Design), responsive
  по общим правилам.

---

## 7. Тесты (AC-каркас; детальные AC — в task-файлах плана)

- **Unit (Vitest, api):** vacancies.service (CRUD, статус-переходы, slug),
  apply-пайплайн (все ветки отказа §4), retention-cron (граничные даты).
- **Integration (реальная БД):** RBAC-гарды — 403 для SENIOR/JUNIOR/ACCOUNTANT/DROP
  на приватных endpoints; публичный флоу end-to-end; 404 на DRAFT-slug; rate-limit.
- **E2E (Playwright, apps/e2e):** CRM — создать вакансию → publish → отклик через
  публичный API → увидеть в CRM → сменить статус → удалить. Turnstile в тестах —
  официальные CF-тест-ключи (always-pass).
- **Лендинг:** vitest-компонентные (форма, валидация, состояния) + Playwright-прогон
  по тест-ширинам 320–1920 (нет горизонтального overflow, тач-таргеты ≥ 44px).
- **Fidelity-гейт:** ui-ux-designer Mode B — diff макет ↔ localhost на всех классах
  устройств для лендинга И CRM-экранов (`design-fidelity-review.md`).

---

## 8. Деплой и конфигурация

- nginx: без изменений (proxy `/api` уже есть на обоих доменах).
- Новые env: `TURNSTILE_SECRET_KEY` (api, prod env + `.env.example`);
  `VITE_TURNSTILE_SITE_KEY` (landing build ARG в Dockerfile + GHA secret + dev `.env`).
- Прод-DDL (2 таблицы + enums) — через миграционный шаг deploy.yml (SSH нет).
- R2: тот же bucket, префикс `vacancy-applications/`.

**Owner-TODO (блокеры на своих этапах):**

1. Создать Cloudflare Turnstile site (домены `cheekycheese.tech`, localhost для dev) →
   site key + secret → GH secrets + prod env (нужно к этапу реализации apply).
2. Claude Design сессии — генерация макетов (нужно до вёрстки).
3. Финальная правка фактуры кейсов и текстов вакансий (можно после вёрстки драфтов).

---

## 9. Процесс реализации (после аппрува спеки)

1. `superpowers:writing-plans` → implementation plan с фазами и task-файлами.
2. Claude Design (Tier 1, с владельцем): макеты лендинга (все секции, 4 класса
   устройств, состояния) + CRM-экраны вакансий → артефакты `docs/design/<slug>.md` +
   `docs/design/assets/<slug>/`.
3. PM-декомпозиция → волны агентов ≤ 3–4 (`orchestration-routing.md` Решение 1:
   API-модуль / лендинг / CRM-экраны — почти disjoint по файлам; E2E — после).
4. Полный ревью-пайплайн: code-reviewer + **security-reviewer** (обязателен) +
   manual-qa (живой стек) + fidelity-аудит Mode B → User Testing → merge-сигнал
   владельца → деплой → прод-smoke.

## 10. Out of scope v1

- Email-уведомления кандидату (нет email-инфры).
- Связь откликов с interviews-канбаном (решение владельца).
- Мультиязычность лендинга (только EN).
- Зарплатные поля/вилки.
- Подписка на вакансии, RSS, job-агрегаторы.
