# Contact-email env — runbook (task-infra-contact-email-env)

> **Скоуп:** проброс до прод-окружения env-переменных, нужных публичной форме
> заявок с лендинга (`POST /api/public/contact`, реализация — параллельная
> ветка `feature/landing-contact-form`, шлёт письмо всем ADMIN через Resend
> HTTP API). Этот infra-PR (`infra/contact-email-env`) заводит инфраструктуру
> ДО того, как feature-ветка смержится — тот же порядок, что у telemetry (T3
> раньше T1, см. `scripts/devops/telemetry-digest-runbook.md` §1) — чтобы не
> повторить инцидент "код приехал, инфра-шаг — нет" (vacancy i18n DDL,
> 2026-07-25).

---

## 1. Переменные — имена, откуда, куда

| Переменная             | Тип                        | Значение / откуда                                                                        | Куда пробрасывается                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`       | GitHub secret (уже создан) | Resend Dashboard → API Keys                                                              | `deploy.yml` write-env → `/opt/crm/.env.production` (рантайм API)                                                                                                                                                                                                   |
| `CONTACT_FROM_EMAIL`   | Константа (НЕ секрет)      | `noreply@cheekycheese.tech` — домен верифицирован в Resend, почтовый ящик не нужен       | `deploy.yml` write-env → `/opt/crm/.env.production` (рантайм API)                                                                                                                                                                                                   |
| `CONTACT_PUBLIC_EMAIL` | Константа (НЕ секрет)      | `hr@cheekycheese.tech` — запасной контакт-канал, который лендинг показывает пользователю | `deploy.yml` write-env → `/opt/crm/.env.production` (рантайм API); ТАКЖЕ build-arg `VITE_CONTACT_PUBLIC_EMAIL` в `nginx/Dockerfile` (landing-builder stage) — на случай если лендингу нужно вшить значение в статику на этапе сборки, а не читать с бэка в рантайме |

**Почему `CONTACT_FROM_EMAIL`/`CONTACT_PUBLIC_EMAIL` не секреты:** это публичные
email-адреса компании (аналогично `PRERENDER_API_ORIGIN=https://cheekycheese.tech`
или `VITE_API_URL=/api` — уже существующие константы прямо в `deploy.yml`), не
несут чувствительного значения. Хардкожены буквально в workflow/Dockerfile —
смена значения = обычный PR с явным diff, а не скрытая правка секрета.

## 2. `RESEND_API_KEY` — optional, НЕ fail-loud (важное отличие от TURNSTILE)

В `deploy.yml` write-env job есть два разных паттерна для секретов:

- **Fail-loud** (`TURNSTILE_SECRET_KEY`, `TELEMETRY_DIGEST_TOKEN`,
  `TELEMETRY_SESSION_SALT`) — API падает в crash-loop на буте без них
  (`env.ts` `refine()`), поэтому деплой останавливается явной `ERROR` +
  `exit 1` ДО билда/пула.
- **Optional, no-op** (`GOOGLE_INDEXING_SA_*`, `PUBLIC_LANDING_ORIGIN`) —
  сервис работает без них в no-op режиме.

`RESEND_API_KEY` — **второй паттерн**: по брифу задачи API стартует нормально
и без него, эндпоинт `POST /api/public/contact` просто отвечает 503 вместо
отправки письма. **НЕ** `exit 1`, если секрет пуст.

Единственное отличие от `GOOGLE_INDEXING_SA_*`: тот секрет может отсутствовать
неопределённо долго (владелец создаёт его позже, по желанию), а
`RESEND_API_KEY` **уже создан владельцем заранее** (проверено на момент этого
PR — `gh secret list` показывает `RESEND_API_KEY`). Поэтому пустое значение
здесь — не «ещё не настроено», а неожиданный дрейф (секрет случайно очистили/
переименовали). write-env печатает `::warning::` в лог деплоя в этом случае —
деплой всё равно продолжается (не fail-loud), но факт виден в логах, а не
тонет молча.

Как и `GOOGLE_INDEXING_SA_*`, значение в `.env.production` пишется
**условно** (`if [ -n "$RESEND_API_KEY" ]`) — пустая строка НЕ записывается
как `RESEND_API_KEY=`, чтобы не наткнуться на разницу между «не задано» и
«задано как пустая строка» для более строгого Zod-валидатора на стороне API
(тот же приём, что уже описан в `deploy.yml` для `GOOGLE_INDEXING_SA_EMAIL`).

## 3. Смена домена / ключа

- **Смена адреса `CONTACT_FROM_EMAIL` (например, другой поддомен рассылки):**
  1. Убедиться, что новый домен верифицирован в Resend (Dashboard → Domains →
     DNS-записи SPF/DKIM/DMARC добавлены и подтверждены).
  2. Обновить константу в `deploy.yml` write-env (heredoc `NODE_ENV=production` /
     `API_PORT=3001` блок) — явный PR, diff виден в review.
  3. Задеплоить — следующий прогон `deploy.yml` подхватит новое значение.
- **Смена `CONTACT_PUBLIC_EMAIL`:** аналогично — обновить константу в
  `deploy.yml` write-env И (если фича лендинга реально читает
  `VITE_CONTACT_PUBLIC_EMAIL` на этапе сборки, см. §1) build-arg в блоке
  «Build & push nginx image» того же workflow. Оба места держать в синхроне
  вручную — намеренно константы, не единый источник (см. §1 «почему не
  секреты»).
- **Ротация `RESEND_API_KEY`:**
  1. Сгенерировать новый ключ в Resend Dashboard → API Keys.
  2. Обновить значение существующего секрета (GitHub → Settings → Secrets
     and variables → Actions → `RESEND_API_KEY` → Update).
  3. Отозвать старый ключ в Resend Dashboard.
  4. Следующий деплой подхватит новое значение автоматически — никаких
     дополнительных действий не требуется (ключ пробрасывается через SSH env
     в write-env job на каждом прогоне, а не кэшируется на VPS).

## 4. Как проверить доставку (smoke)

После того как `feature/landing-contact-form` смержена и задеплоена:

1. Отправить тестовую заявку через публичную форму на лендинге (или напрямую):
   ```bash
   curl -i -X POST https://cheekycheese.tech/api/public/contact \
     -H 'Content-Type: application/json' \
     -d '{"name":"Smoke Test","email":"smoke@example.com","message":"ping"}'
   ```
2. Ожидаемый результат при корректно настроенном `RESEND_API_KEY`: `200`/`201`
   и письмо приходит на все ADMIN-адреса в течение минуты.
3. Если `RESEND_API_KEY` пуст/невалиден: эндпоинт отвечает `503` (не 500) —
   ожидаемое no-op поведение, не баг. Проверить `::warning::` в логе последнего
   `deploy.yml` прогона (`gh run view <id> --log | grep RESEND_API_KEY`).
4. Проверить, что письмо действительно приходит с `From: noreply@cheekycheese.tech`
   и что `Reply-To` указывает на email заявителя (не на `noreply@`) — так,
   чтобы ADMIN мог ответить прямо из почтового клиента.
5. Проверить в Resend Dashboard → Logs, что событие доставки залогировано без
   ошибок (bounce/domain-not-verified и т.п.).

## 5. Связанные файлы

- Workflow (build-arg + write-env): `.github/workflows/deploy.yml`
- `nginx/Dockerfile` — landing-builder stage, `ARG VITE_CONTACT_PUBLIC_EMAIL`
- Feature-ветка (бэкенд, параллельно): `feature/landing-contact-form` —
  `POST /api/public/contact`
- Этот infra-PR: `infra/contact-email-env`
