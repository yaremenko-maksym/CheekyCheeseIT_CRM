# Deployment Runbook — CheekyCheeseIT CRM

> **Статус:** первый деплой выполнен 2026-06-27. Авто-деплой включён 2026-07-12.
> Разделы, требующие проверки на живом сервере, помечены `[UNTESTED]`.

## Обзор архитектуры

```
Пользователь → Cloudflare (DNS/TLS/CDN/DDoS) → Hetzner VPS (CX33)
                                                       │
                                          nginx (80/443)
                                          ├── cheekycheese.tech → Landing SPA
                                          └── app.cheekycheese.tech → CRM SPA
                                                       │
                                                 api (NestJS :3001, внутренний)
                                                 ├── postgres:5432 (внутренний)
                                                 └── redis:6379   (внутренний)

Документы: Cloudflare R2 (или self-hosted MinIO через --profile selfhosted-s3)
```

| Сервис     | Образ                                                     | Доступен снаружи              |
| ---------- | --------------------------------------------------------- | ----------------------------- |
| `postgres` | postgres:16-alpine                                        | нет (только внутри Docker)    |
| `redis`    | redis:7-alpine                                            | нет (только внутри Docker)    |
| `api`      | `ghcr.io/yaremenko-maksym/cheekycheeseit-crm-api:<tag>`   | нет (только через nginx /api) |
| `nginx`    | `ghcr.io/yaremenko-maksym/cheekycheeseit-crm-nginx:<tag>` | 80, 443                       |

Cookie-auth работает same-origin: `app.cheekycheese.tech/api/...` → nginx `/api/` → api:3001.

---

## 1. Провижн-чеклист владельца

> **Это делает владелец репо вручную, один раз. Ассистент не имеет доступа к
> этим системам и не может выполнить за вас.**

### 1.1 Hetzner VPS

1. Создать сервер: **CX33** (4 vCPU, 8 GB RAM), локация **Нюрнберг или Хельсинки** (EU).
2. ОС: **Ubuntu 22.04 LTS**.
3. Добавить SSH-ключ при создании — это будет ключ деплоя (см. §1.4).
4. Запомнить выданный IP-адрес VPS — понадобится для DNS A-записей (§1.2).

### 1.2 Cloudflare — добавить домен и настроить DNS

> **КРИТИЧНО: перед изменением NS-серверов убедитесь, что все существующие DNS-записи
> перенесены в Cloudflare (особенно MX, SPF, DKIM — почта @cheekycheese.tech жива!).**

**Шаги:**

1. В Cloudflare → "Add a Site" → ввести `cheekycheese.tech`.
2. Cloudflare покажет список существующих DNS-записей, импортированных автоматически.
   **Проверить наличие всех MX, SPF (TXT `v=spf1 ...`), DKIM (TXT `_domainkey.*`), DMARC.**
   Если какие-то записи отсутствуют — добавить вручную перед сменой NS.
3. Сменить NS-серверы у регистратора домена на те, что показывает Cloudflare.
4. Дождаться зелёного статуса ("Active") в Cloudflare — обычно 5-30 минут.
5. Добавить/обновить A-записи:

   | Запись                  | Тип | Значение   | Proxied |
   | ----------------------- | --- | ---------- | ------- |
   | `cheekycheese.tech`     | A   | `<IP VPS>` | да ✓    |
   | `www.cheekycheese.tech` | A   | `<IP VPS>` | да ✓    |
   | `app.cheekycheese.tech` | A   | `<IP VPS>` | да ✓    |

6. Настроить TLS: SSL/TLS → режим **Full (strict)**.
   - "Full (strict)" требует валидный сертификат на origin (VPS).
   - Вариант A (рекомендован): выпустить **Cloudflare Origin Certificate** (15 лет):
     SSL/TLS → Origin Server → Create Certificate → ввести `cheekycheese.tech,*.cheekycheese.tech`.
     Скачать `.pem` и `.key`. Разместить на VPS (см. §4).
   - Вариант Б: Let's Encrypt на nginx (certbot standalone) — nginx должен быть остановлен
     на время выпуска. Менее удобен (обновление каждые 90 дней).

### 1.3 Google OAuth — обновить redirect URI

В **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs**:

- Authorized JavaScript origins: `https://app.cheekycheese.tech`
- Authorized redirect URIs: `https://app.cheekycheese.tech/api/auth/google/callback`

Удалить старые localhost / туннель-записи (если были).

### 1.4 SSH deploy-ключ — создать и добавить в GitHub Secrets

```bash
# Сгенерировать ключ (без passphrase — CI не умеет вводить пароль):
ssh-keygen -t ed25519 -f ~/.ssh/crm_deploy_key -C "crm-deploy@github-actions" -N ""

# Вывести публичный ключ — добавить на VPS в ~/.ssh/authorized_keys:
cat ~/.ssh/crm_deploy_key.pub

# Вывести приватный ключ — добавить в GitHub Secret VPS_SSH_KEY:
cat ~/.ssh/crm_deploy_key
```

На VPS:

```bash
echo "<публичный ключ>" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### 1.5 Cloudflare R2 — создать бакет для документов и бакет для бэкапов

1. Cloudflare → R2 Object Storage → Create Bucket:
   - `crm-documents-prod` — для загружаемых пользователями документов
   - `crm-backups` — для ночных PG-дампов (§8)
2. Создать **ДВА ОТДЕЛЬНЫХ** R2 API Token — по одному на бакет, **не один общий**
   (`task-infra-prod-backup-safety-net`, round 2, 2026-08-03 — до этого был один
   токен на оба бакета; разделено намеренно, см. врезку ниже):
   - **Documents token** — scope: Object Read & Write, бакет `crm-documents-prod`
     ТОЛЬКО. Идёт в GitHub Secrets `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
     (§3) → `.env.production` на VPS → читает `apps/api`.
   - **Backups token** — scope: Object Read & Write, бакет `crm-backups` ТОЛЬКО
     (один и тот же токен и пишет через `pg-backup.sh`, и удаляет по сроку
     хранения — отдельный read-only токен не заводится, см. §8). Идёт **ТОЛЬКО**
     в `/etc/crm-backup.env` на VPS (§8) — **никогда** в GitHub Secrets.
   - Для каждого токена запомнить: Access Key ID, Secret Access Key.
3. Endpoint R2 выглядит так: `https://<account-id>.r2.cloudflarestorage.com`
   (одинаковый endpoint для обоих токенов — endpoint не привязан к скоупу).
4. **CORS-политика бакета `crm-documents-prod` — обязательна, добавлена 2026-08-05.**
   R2 → бакет → Settings → CORS Policy:

   ```json
   [
     {
       "AllowedOrigins": ["https://app.cheekycheese.tech"],
       "AllowedMethods": ["GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Бакет `crm-backups` политики не требует — к нему браузер не обращается.

> **Почему это не косметика и почему отказ бесшумный.** С 2026-08-05
> (`task-scan-cache-leak`, PR #479) `document-image.tsx` запрашивает картинки в
> CORS-режиме (`crossOrigin="anonymous"`). Так сделано не ради удобства: без него
> ответ хранилища **непрозрачен**, из него нельзя прочитать `Cache-Control`, и
> проверка `cacheWillUpdate` в service worker пропускала в кеш **всё подряд** —
> сканы документов и резюме лежали на устройствах 30 дней вопреки честному
> `private, no-store` от `s3.service.ts`. Читаемый ответ — единственный способ
> отличить аватар (`public, immutable`, кешируем) от скана паспорта (`no-store`,
> не кешируем).
>
> Цена: **если политику снять или сузить, картинки перестанут грузиться вообще** —
> все 17 мест в CRM, где используется этот компонент (аватары, логотипы проектов,
> превью документов). Отказ визуально бесшумный: `onError` прячет элемент
> (`display:none`), в консоли — обычная CORS-ошибка, никакого сообщения
> пользователю. То есть «картинок нет» будет выглядеть как «картинок и не было».
>
> Проверить политику, не заходя в панель (endpoint берётся из уже лежащего на VPS
> файла; в вывод попадают только заголовки доступа, ключи — нет):
>
> ```bash
> ( set -a; . /etc/crm-backup.env; set +a
>   curl -sI -X OPTIONS "$S3_ENDPOINT/crm-documents-prod/" \
>     -H 'Origin: https://app.cheekycheese.tech' \
>     -H 'Access-Control-Request-Method: GET' ) | grep -i '^access-control'
> ```
>
> Ожидается `Access-Control-Allow-Origin: https://app.cheekycheese.tech` и
> `Access-Control-Allow-Methods: GET`. Пусто — политика не применилась.
> Дополнительно `Access-Control-Expose-Headers` **не нужен**: `Cache-Control`
> входит в список заголовков, читаемых при CORS по умолчанию.

> **Почему два токена, а не один на оба бакета.** Единый токен на весь аккаунт
> означал: компрометация контейнера `api` (единственное место, где живут
> GitHub-secret-креды) = чтение и удаление 30 дней PG-дампов. После разделения
> секрет, попадающий в GitHub Actions/`.env.production`/контейнер `api`,
> физически не может тронуть `crm-backups` — токен с доступом к бэкапам нигде,
> кроме `/etc/crm-backup.env` на самом VPS, не существует. Это же свойство —
> причина, по которой автоматическая проверка свежести бэкапов (§8.1) идёт по
> SSH прямо с сервера, а не из GitHub Actions: у раннера просто нет и не должно
> быть кредов для `crm-backups`.

> **Правильные значения S3-env для Cloudflare R2 (наш прод-провайдер):**
> Валидатор (`apps/api/src/config/env.ts`) ожидает `S3_ENDPOINT` как валидный URL
> (`.string().url()`) — R2-endpoint `https://<account-id>.r2.cloudflarestorage.com` ему
> соответствует. Для R2:
>
> - `S3_USE_SSE=false` — R2 **не поддерживает** заголовок SSE-S3 (`ServerSideEncryption: AES256`)
>   и отвергает PutObject, если он присутствует. R2 шифрует данные at-rest сам (AES-256), поэтому
>   отсутствие заголовка — корректно и безопасно. В `deploy.yml` это значение **захардкожено `false`**
>   (не секрет). `true` ставить только при миграции на AWS S3.
> - `S3_FORCE_PATH_STYLE=false` — R2 (как и AWS S3) использует virtual-hosted-style URL
>   (`bucket.host/key`). `true` — **только** для локального MinIO (path-style `host/bucket/key`).
> - `S3_REGION=auto` для R2 (`eu-central-1` — это для AWS S3).
>
> Код уже поддерживает оба провайдера через флаг `S3_USE_SSE` (см. PR #292: `s3.service.ts`
> отправляет SSE-заголовок только при `S3_USE_SSE=true`). Доработки кода не требуется.

### 1.6 Host-firewall — впуск на :80/:443 ТОЛЬКО с Cloudflare (ОБЯЗАТЕЛЬНО)

> **Зачем (security-critical):** nginx доверяет заголовку `CF-Connecting-IP` от Cloudflare-диапазонов
> и восстанавливает из него реальный IP клиента. Этот IP пишется как **юридическое доказательство**
> при подписании контрактов и ToS. Если кто-то обратится к origin-IP VPS **напрямую, минуя Cloudflare**
> (origin-IP часто утекает), он попадёт на тот же nginx и сможет прислать **поддельный** `CF-Connecting-IP`
> → подделка юр-IP. Поэтому origin ДОЛЖЕН принимать HTTP(S) только от Cloudflare.

**Вариант A (проще): host-firewall `ufw` — разрешить :80/:443 только с Cloudflare CIDR.**

```bash
# На VPS. SSH (порт 22) — оставить открытым (лучше ограничить своим IP отдельно).
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp                       # SSH (рассмотреть `ufw allow from <ваш-IP> to any port 22`)
# Разрешить 80/443 ТОЛЬКО с актуальных Cloudflare-диапазонов:
for cidr in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
  ufw allow from "$cidr" to any port 80  proto tcp
  ufw allow from "$cidr" to any port 443 proto tcp
done
ufw enable
ufw status numbered
```

> Список CF-диапазонов меняется редко — при изменении (см. §11) пере-прогнать цикл и удалить старые правила.

**Вариант Б (надёжнее): Cloudflare Authenticated Origin Pulls (mTLS)** — origin принимает TLS только
от Cloudflare по клиентскому сертификату CF. Включается в Cloudflare → SSL/TLS → Origin Server →
Authenticated Origin Pulls + `ssl_client_certificate`/`ssl_verify_client on` в nginx. Применять, если
firewall-локдаун недостаточен (например, динамичный набор исходящих IP).

> Без §1.6 real-IP restore (§11) обходится → не считать IP-доказательство достоверным до локдауна.

### 1.7 Cloudflare Turnstile — спам-guard для формы вакансий (task-vacancies-api, PR #390)

> **КРИТИЧНО — порядок действий:** `apps/api/src/config/env.ts` фейлит **прод-бут** API
> (crash-loop), если `TURNSTILE_SECRET_KEY` не задан или остался дефолтным dev-значением
> Cloudflare "always passes" (сознательный security-фикс, не баг). **НЕ мержить PR #390**
> (public vacancy-apply endpoint), пока секрет `TURNSTILE_SECRET_KEY` не заведён в GitHub —
> иначе первый же деплой после мержа уронит прод-API в crash-loop.
> Одного заведённого секрета мало: **PR #391 (эта deploy.yml-обвязка) должен быть смержен
> ДО (или одновременно с) PR #390** — на текущем `main` переменная физически не доедет до
> `.env.production`, а DDL вакансий не применится. Порядок: секрет → merge #391 → merge #390.

**Шаги владельца в Cloudflare Dashboard:**

1. Cloudflare → **Turnstile** → **Add site**.
2. Domains: `cheekycheese.tech` **и** `localhost` (второй — чтобы виджет работал в dev/локально).
3. Widget mode: Managed (рекомендуется).
4. После создания Cloudflare покажет **Site Key** (публичный) и **Secret Key** (приватный).

**Завести в GitHub → Settings → Secrets and variables → Actions:**

| Secret                    | Значение                  | Куда едет                                                                                         |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY`    | Secret Key из шага 4 выше | `write-env` job → `.env.production` на VPS → читает `apps/api` (`env.ts`)                         |
| `VITE_TURNSTILE_SITE_KEY` | Site Key из шага 4 выше   | `build` job → build-arg в `nginx/Dockerfile` (landing-builder stage) → запекается в landing-бандл |

- `TURNSTILE_SECRET_KEY` следует тому же пути, что и остальные API-секреты (`JWT_SECRET`,
  `SESSION_SECRET`, ...): SSH env-канал в `write-env` job → строка в `/opt/crm/.env.production`
  (mode 600) → читается контейнером `api` через `env_file` в `docker-compose.prod.yml`. `deploy.yml`
  **fail-loud**: если секрет пуст, `write-env` job падает ДО того, как что-либо задеплоится
  (явная проверка `if [ -z "$TURNSTILE_SECRET_KEY" ]`), с сообщением-ссылкой на этот раздел.
- `VITE_TURNSTILE_SITE_KEY` — build-time (не runtime) секрет: попадает в `build` job как
  Docker build-arg при сборке `nginx/Dockerfile` (та стадия, которая реально собирает
  `apps/landing` для прода — НЕ `apps/landing/Dockerfile`, который лишь дублирует ARG для
  автономной локальной сборки). Пустое значение **не роняет билд** — до мержа PR #390 (форма
  ещё не существует в бандле) это ожидаемо; `build` job печатает `::warning::` в лог, если
  секрет не задан.
- Dev/локально: значение по умолчанию — CF-документированный always-pass site key
  `1x00000000000000000000AA` (см. `apps/landing/.env.example` и корневой `.env.example`).
  На стороне API — соответствующий always-pass secret key уже в `apps/api/.env.example`.

### 1.8 Google Indexing API — мгновенная (пере)индексация вакансий (task-google-indexing-api)

> **Полностью опционально.** Без ключей `apps/api` запускает indexing-сервис в no-op режиме
> (один warning в логах на буте) — публикация/закрытие вакансий работает как обычно, просто без
> push-уведомления в Google. Это НЕ блокирует деплой и НЕ похоже на Turnstile (§1.7) — здесь нет
> fail-loud проверки в `deploy.yml`.

**Зачем.** Google Indexing API официально поддерживает **только JobPosting-страницы**: после
`publish` уведомление попадает в индекс за минуты (а не недели, как обычное сканирование), после
`close` — мгновенное удаление устаревшей вакансии из выдачи. Публичный URL вакансии:
`https://cheekycheese.tech/careers/<slug>/` (обязательный завершающий `/`).

**Шаги владельца в Google Cloud Console:**

1. Открыть/создать GCP-проект (можно переиспользовать существующий, если он уже есть для других
   Google-интеграций проекта).
2. **APIs & Services → Library** → найти **Web Search Indexing API** → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service Account** → задать имя/описание
   (например `crm-indexing`) → **Create and Continue** → роли можно пропустить (права выдаются
   через Search Console, не через IAM) → **Done**.
4. Открыть созданный service account → вкладка **Keys** → **Add Key → Create New Key** → формат
   **JSON** → скачается файл вида `<project-id>-xxxxxxxxxxxx.json`.
5. Извлечь `client_email` и `private_key` из скачанного JSON и сразу закодировать приватный ключ
   в base64 одной строкой (важно: `jq -r` разворачивает литеральные `\n` внутри JSON-строки в
   реальные переводы строк PEM-блока ДО кодирования; `tr -d '\n'` после `base64` убирает
   построчный wrap — на Linux `base64` без `-w0` заворачивает вывод на 76 символах, на macOS
   `base64` не заворачивает вовсе, поэтому `tr -d '\n'` даёт одинаковый результат на обеих ОС):

   ```bash
   # Путь к скачанному в шаге 4 JSON-ключу:
   KEY_FILE=~/Downloads/<project-id>-xxxxxxxxxxxx.json

   # → значение для секрета GOOGLE_INDEXING_SA_EMAIL:
   jq -r '.client_email' "$KEY_FILE"

   # → значение для секрета GOOGLE_INDEXING_SA_KEY_B64 (одна строка, без переводов строк):
   jq -r '.private_key' "$KEY_FILE" | base64 | tr -d '\n'
   ```

6. **Google Search Console → property `cheekycheese.tech`** (тот же verified property из §11 п.5;
   индексация запрашивается только для лендинга, поэтому дополнительно верифицировать
   `app.cheekycheese.tech` не нужно) → **Settings → Users and permissions** → внизу страницы ссылка
   **Add an owner** (не обычный "Add user" — обычный пользователь получит `403`, нужен именно
   **Owner**) → вставить `client_email` сервис-аккаунта из шага 5 → подтвердить.
7. Завести в **GitHub → Settings → Secrets and variables → Actions → Secrets** (Environment
   "production", тем же каналом что `TURNSTILE_SECRET_KEY` — см. §3 таблицу ниже):

   | Secret                       | Значение                                                                                                                                                                                          |
   | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `GOOGLE_INDEXING_SA_EMAIL`   | `client_email` из шага 5                                                                                                                                                                          |
   | `GOOGLE_INDEXING_SA_KEY_B64` | base64(`private_key`) из шага 5 — одна строка                                                                                                                                                     |
   | `PUBLIC_LANDING_ORIGIN`      | Опционально — только если базовый URL лендинга когда-либо сменится с `https://cheekycheese.tech` (этот адрес уже зашит как default в коде `apps/api`; секрет НЕ обязателен при первом провижене). |

   Все три читаются `write-env` job'ом `deploy.yml` и пишутся в `/opt/crm/.env.production` **только
   если непустые** (пустая строка не пишется вовсе — иначе есть риск, что даже пустой
   `GOOGLE_INDEXING_SA_EMAIL=` собьёт с толку валидатор Zod на стороне `apps/api`, который отличает
   "переменная отсутствует" от "переменная пустая"). Ничего не заведено → сервис остаётся в no-op.

**Как проверить, что работает:**

- Опубликовать (или закрыть) любую вакансию в CRM → в течение минуты открыть **Search Console →
  URL Inspection**, вставить `https://cheekycheese.tech/careers/<slug>/` и посмотреть, что статус
  индексации обновился (или запросить **Request Indexing** вручную, если хочется форсировать).
- Логи API на VPS: `docker compose ... logs api | grep -i indexing` — успешные уведомления
  логируются; ошибки Google API логируются, но **никогда** не блокируют публикацию/закрытие
  вакансии (fail-soft по дизайну, см. task-google-indexing-api).
- Еженедельный refresh всех `PUBLISHED`-вакансий (API-cron) и еженедельный ребилд деплоя —
  НЕЗАВИСИМЫЕ механизмы с общей целью «свежесть JobPosting»: cron шлёт URL_UPDATED в Google,
  ребилд обновляет validThrough/sitemap в статике
  (см. `schedule:` триггер в `.github/workflows/deploy.yml`, task-infra-weekly-rebuild) — оба
  привязаны к той же логике "не протухнуть между мержами", что и скользящий `validThrough`
  (build-time + 60 дней).
- Квота по умолчанию — 200 запросов/день на онбординге; при текущем объёме вакансий (единичные
  publish/close + один еженедельный проход по всем `PUBLISHED`) этого с большим запасом хватает.

---

## 2. Установка Docker на VPS

```bash
# На VPS (от root или с sudo):
apt update && apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Разрешить деплой-пользователю запускать docker без sudo:
usermod -aG docker $USER
# Перелогиниться или: newgrp docker

# Проверить:
docker compose version   # должно показать Compose plugin v2.x
```

> **Требуется Compose ≥ v2.22** — `docker-compose.ghcr.yml` использует `build: !reset null` для
> сброса `build:`-директивы из базового compose (синтаксис появился в Compose v2.22). На свежей
> установке `docker-compose-plugin` из официального репо (выше) версия современная — но при проблеме
> «`!reset` not recognized» обновите плагин: `apt update && apt install --only-upgrade docker-compose-plugin`.

---

## 3. GitHub Secrets — полный список

Добавить в **GitHub → Settings → Secrets and variables → Actions → Secrets** (уровень Repository).
Дополнительно создать **Environment "production"** и добавить туда же для дополнительной защиты.

| Secret                       | Значение / как получить                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `VPS_HOST`                   | IP-адрес VPS (из §1.1)                                                                                                                        |
| `VPS_USER`                   | SSH-пользователь (обычно `root` или выделенный deploy-user)                                                                                   |
| `VPS_SSH_KEY`                | Содержимое приватного ключа `~/.ssh/crm_deploy_key` (весь файл включая `-----BEGIN...-----`)                                                  |
| `POSTGRES_PASSWORD`          | `openssl rand -base64 32` — сильный пароль (≥32 символа)                                                                                      |
| `JWT_SECRET`                 | `openssl rand -base64 48` — минимум 32 символа                                                                                                |
| `SESSION_SECRET`             | `openssl rand -base64 48` — минимум 32 символа                                                                                                |
| `CREDENTIALS_ENC_KEY`        | `openssl rand -base64 32` — должно быть ровно 32 байта AES-256                                                                                |
| `GOOGLE_CLIENT_ID`           | Из Google Cloud Console → OAuth 2.0 Client (§1.3)                                                                                             |
| `GOOGLE_CLIENT_SECRET`       | Оттуда же                                                                                                                                     |
| `S3_ENDPOINT`                | R2: `https://<account-id>.r2.cloudflarestorage.com`; AWS S3: оставить пустым (SDK использует дефолтный endpoint)                              |
| `S3_REGION`                  | R2: `auto`; AWS S3 Frankfurt: `eu-central-1`                                                                                                  |
| `S3_BUCKET`                  | `crm-documents-prod` (документы — **НЕ** `crm-backups`, см. врезку ниже)                                                                      |
| `S3_FORCE_PATH_STYLE`        | R2: `false`; AWS S3: `false` (virtual-hosted style). `true` — только локальный MinIO                                                          |
| `AWS_ACCESS_KEY_ID`          | **Documents token** Access Key ID (§1.5) — скоуп ТОЛЬКО `crm-documents-prod`, или AWS IAM ключ                                                |
| `AWS_SECRET_ACCESS_KEY`      | **Documents token** Secret (§1.5) — тот же скоуп, что и выше, или AWS IAM секрет                                                              |
| `TURNSTILE_SECRET_KEY`       | Cloudflare Turnstile Secret Key (§1.7). **Обязателен ДО мержа PR #390** — иначе прод-API crash-loop на буте.                                  |
| `VITE_TURNSTILE_SITE_KEY`    | Cloudflare Turnstile Site Key (§1.7). Опционален до #390 — пустое значение не роняет билд лендинга.                                           |
| `GOOGLE_INDEXING_SA_EMAIL`   | Полностью опционален (§1.8). `client_email` из GCP service-account JSON-ключа. Пусто → indexing-сервис в no-op режиме, деплой не блокируется. |
| `GOOGLE_INDEXING_SA_KEY_B64` | Полностью опционален (§1.8). base64(`private_key` PEM) из того же JSON-ключа, одна строка.                                                    |
| `PUBLIC_LANDING_ORIGIN`      | Полностью опционален (§1.8). Нужен, только если базовый URL лендинга изменится — в коде уже есть default `https://cheekycheese.tech`.         |

> `GITHUB_TOKEN` (для GHCR login в deploy) генерируется GHA автоматически — добавлять не нужно.
>
> `S3_USE_SSE` **не входит** в список секретов — оно захардкожено `false` прямо в `deploy.yml`
> (write-env шаг), т.к. наш прод-провайдер — Cloudflare R2 (см. §1.5). Менять только при миграции на AWS S3.
>
> **Токен на `crm-backups` НЕ входит в этот список намеренно** — он живёт ТОЛЬКО в
> `/etc/crm-backup.env` на VPS, никогда в GitHub Secrets (§1.5, §8). `AWS_ACCESS_KEY_ID`/
> `AWS_SECRET_ACCESS_KEY` выше — это отдельный, documents-only токен.

**Команды генерации секретов:**

```bash
openssl rand -base64 48   # JWT_SECRET, SESSION_SECRET
openssl rand -base64 32   # CREDENTIALS_ENC_KEY, POSTGRES_PASSWORD
```

---

## 4. TLS — настройка сертификата на VPS

### Вариант A (рекомендован): Cloudflare Origin Certificate

Origin Certificate выпускается в Cloudflare Dashboard (§1.2, шаг 6) и действует 15 лет.
Cloudflare → Full (strict) завершает TLS на edge и устанавливает новое TLS-соединение до VPS.

> **Порядок ВАЖЕН (избегаем plaintext-окна CF→origin):** подними 443 на origin (origin-cert +
> раскомментированные `listen 443 ssl`) и переключи Cloudflare в **Full (strict)** ДО того, как
> включишь Proxied / переключишь NS на боевой трафик. Если включить Proxied при ещё-`Flexible`/только-:80
> origin, плечо CF→origin пойдёт по HTTP. После валидного origin-cert сразу раскомментируй HSTS в
> `security-headers.conf`.

```bash
# На VPS — создать директорию для сертов:
mkdir -p /etc/nginx/certs

# Скопировать файлы, скачанные из Cloudflare Dashboard:
# origin-cert.pem → содержит сертификат (CF выдаёт .pem или .crt)
# origin-key.key  → приватный ключ
scp origin-cert.pem root@<VPS_IP>:/etc/nginx/certs/cheekycheese.tech.crt
scp origin-key.key  root@<VPS_IP>:/etc/nginx/certs/cheekycheese.tech.key
# Для app.* можно использовать тот же wildcard-серт (*.cheekycheese.tech):
cp /etc/nginx/certs/cheekycheese.tech.crt /etc/nginx/certs/app.cheekycheese.tech.crt
cp /etc/nginx/certs/cheekycheese.tech.key /etc/nginx/certs/app.cheekycheese.tech.key

chmod 600 /etc/nginx/certs/*.key
```

После размещения сертов раскомментировать блоки `listen 443 ssl` в:

- `nginx/conf.d/crm.conf`
- `nginx/conf.d/landing.conf`

И раскомментировать HSTS заголовок в `nginx/conf.d/security-headers.conf`.

В `docker-compose.prod.yml` раскомментировать `volumes:` секцию сервиса nginx:

```yaml
volumes:
  - /etc/nginx/certs/cheekycheese.tech:/etc/nginx/certs/cheekycheese.tech:ro
  - /etc/nginx/certs/app.cheekycheese.tech:/etc/nginx/certs/app.cheekycheese.tech:ro
```

### Вариант Б: Let's Encrypt (certbot)

```bash
# На VPS (nginx должен быть остановлен для standalone mode):
docker compose -f /opt/crm/docker-compose.prod.yml stop nginx
apt install -y certbot
certbot certonly --standalone \
  -d cheekycheese.tech -d www.cheekycheese.tech
certbot certonly --standalone \
  -d app.cheekycheese.tech
```

Обновление каждые 90 дней — настроить `cron` или `systemd timer`:

```bash
# /etc/cron.d/certbot-renew
0 3 1 * * root certbot renew --pre-hook "docker stop crm-nginx-1" \
                               --post-hook "docker start crm-nginx-1"
```

---

## 5. Drizzle миграции в продакшене [UNTESTED]

> Стратегия `db:push` (drizzle-kit push) — идемпотентная синхронизация схемы.
> Безопасна для повторного запуска. **НЕ запускать `db:seed` в продакшене.**

Текущая продакшн-стратегия: в workflow `deploy.yml` есть шаг попытки запустить
`drizzle-kit push` внутри запущенного API-контейнера. Однако `drizzle-kit` — dev
dependency и **отсутствует в prod-образе API** (который прогнан через `pnpm deploy --prod`).

**Практическое решение (рекомендуется до автоматизации):**

```bash
# На VPS после `docker compose up -d`:
# Временно добавить DATABASE_URL из .env.production и запустить push через node:

docker run --rm \
  --network crm_backend \
  --env-file /opt/crm/.env.production \
  node:20-alpine \
  sh -c "
    npm install -g drizzle-kit &&
    # Нужна схема — смонтировать или использовать другой подход
    echo 'Requires schema files — use approach below'
  "
```

**Более надёжный подход (один раз при изменении схемы):**

```bash
# Локально, с DATABASE_URL указывающим на продакшн через SSH-туннель:
ssh -L 5433:postgres:5432 <VPS_USER>@<VPS_HOST> -N &
DATABASE_URL=postgresql://crm_user:<POSTGRES_PASSWORD>@localhost:5433/crm_db \
  pnpm --filter @crm/api db:push
kill %1  # остановить туннель
```

**Долгосрочное решение (Coder-задача):** добавить `drizzle-kit` как runtime-dep в
prod-образ API или создать отдельный migrate-контейнер в `docker-compose.prod.yml`.

---

## 6. Bootstrap — два первых ADMIN-пользователя

> **Выполняется ОДИН РАЗ после первого деплоя. НЕ запускать db:seed на проде.**
> `db:seed` создаёт тестовые данные (dev-сид) — не нужны в продакшене.

После `docker compose up -d` и успешных миграций:

```sql
-- Подключиться к postgres на VPS:
docker compose -f /opt/crm/docker-compose.prod.yml \
               -f /opt/crm/docker-compose.ghcr.yml \
               --env-file /opt/crm/.env.production \
               exec postgres psql -U crm_user -d crm_db

-- Вставить двух ADMIN-пользователей.
-- Только email + display_name + role. Все остальные колонки берут дефолты схемы:
--   id=gen_random_uuid(), created_at/updated_at=now(), senior_share_percent=26,
--   legal_full_name=NULL, google_id=NULL (заполнится при первом входе через Google SSO).
-- НЕ вписывать legal_full_name здесь — юр. ФИО задаётся отдельно при работе с контрактами.
-- НЕ вписывать senior_share_percent=NULL — колонка NOT NULL (упадёт); опускаем → дефолт 26
--   (для ADMIN доля 50/50 считается отдельно, это поле к нему не применяется).
-- Email'ы заменить на реальные Google-аккаунты В МОМЕНТ bootstrap (НЕ коммитить в репо):
INSERT INTO users (email, display_name, role) VALUES
  ('<email-konstantin>', 'Константин', 'ADMIN'),   -- ← реальный Google email владельца 1
  ('<email-maksym>',     'Максим',     'ADMIN')     -- ← реальный Google email владельца 2
ON CONFLICT (email) DO NOTHING;

\q
```

После INSERT — войти через Google SSO на `https://app.cheekycheese.tech`.
Вход только через Google OAuth (ручного OAuth нет в продакшене, `dev-login` endpoint
активен только при `NODE_ENV=development`).

---

## 7. Первый деплой (пошагово)

1. Убедиться что все секреты добавлены в GitHub (§3).
2. Убедиться что VPS провижнен (§1-2) и SSH-ключ проверен:
   ```bash
   ssh -i ~/.ssh/crm_deploy_key <VPS_USER>@<VPS_IP> echo "SSH OK"
   ```
3. Запустить деплой вручную:
   GitHub → Actions → **Deploy** → Run workflow → Branch: `main` → Run.
4. Следить за логами в Actions (build → write-env → copy-compose → deploy).
5. После успеха — проверить стек на VPS:
   ```bash
   ssh <VPS_USER>@<VPS_IP> \
     docker compose -f /opt/crm/docker-compose.prod.yml \
                    -f /opt/crm/docker-compose.ghcr.yml \
                    --env-file /opt/crm/.env.production \
                    ps
   ```
   Все сервисы должны показывать `(healthy)`.
6. Запустить bootstrap ADMIN-пользователей (§6).
7. Настроить TLS если ещё не сделано (§4).
8. Smoke-test:
   - `https://cheekycheese.tech` — отображается лендинг.
   - `https://app.cheekycheese.tech` — редирект на Google Login (не 502).
   - `https://app.cheekycheese.tech/api/health` — `{"status":"ok"}`.
   - Войти через Google SSO — попасть в CRM.
9. **Авто-деплой включён** (с 2026-07-12 — двухканальная модель):
   - **Человеческий пуш/merge** (владелец через GitHub UI, revert, hotfix) —
     `push: branches: [main]` в `deploy.yml` запускает Deploy напрямую.
   - **Авто-merge через `merge-approved`** — `auto-merge-on-label.yml` после
     сквоша явно диспатчит `deploy.yml` (`gh workflow run --ref main`), потому
     что GITHUB_TOKEN-пуши не создают push-события для workflows (GitHub
     anti-recursion защита; `workflow_dispatch` — документированное исключение,
     работает без PAT).
   - Двойного запуска нет: на авто-мердже push-триггер молчит (GITHUB_TOKEN),
     диспатч-шаг срабатывает; на ручном мердже push срабатывает, dispatch не участвует.
   - Race condition покрыт `concurrency: deploy-production` + `cancel-in-progress: true`.

   **Экстренно отключить авто-деплой:**
   1. Закомментировать `push:` блок в `.github/workflows/deploy.yml`.
   2. Удалить шаг «Dispatch production deploy» из
      `.github/workflows/auto-merge-on-label.yml`.
   3. Закоммитить и запушить.

---

## 8. Автоматические бэкапы PG

> **Инцидент (обнаружено 2026-08-03):** на живом VPS не было НИ ОДНОГО из
> трёх условий ниже — ни `/etc/crm-backup.env`, ни crontab-строки, ни даже
> самого файла `pg-backup.sh` (он никогда не копировался на сервер). Прод с
> финансами, контрактами и персональными данными работал без единой
> резервной копии с самого первого деплоя, и ничто это не обнаруживало.
> `task-infra-prod-backup-safety-net` закрывает файловую часть автоматически
> (§8, шаг 1 ниже) и добавляет постоянный сигнал, если бэкапы перестанут
> появляться (§8.1) — но установка cron и секретов ниже **по-прежнему
> ручная**, и её обязательно довести до конца.

Скрипт: `scripts/devops/pg-backup.sh`.
Расписание: ежедневно в 3:00 UTC.

**Шаг 1 (автоматизирован, ничего делать не нужно).** Каждый `Deploy`-прогон
копирует `scripts/devops/pg-backup.sh` на VPS в
`/opt/crm/scripts/devops/pg-backup.sh` (тот же `copy-compose`-механизм, что
уже используется для `check-security-headers.sh`/`check-nginx-perimeter.sh`)
и на каждый прогон переустанавливает бит исполнения (`chmod +x`, шаг
"Ensuring pg-backup.sh is executable" в `deploy` job) — так что сам файл на
сервере теперь гарантированно свежий и исполняемый после любого деплоя.

**Шаг 2 (ручной, делает владелец — секреты и SSH-доступ на CI не выносятся).**

> **Порядок важен: сначала env-файл, потом cron.** Раньше здесь стояла
> cron-строка БЕЗ загрузки `/etc/crm-backup.env` — а `pg-backup.sh` переменные
> сам не читает, он требует их из окружения (`required_vars` в его шапке).
> Такая строка падает на первом же запуске с `Required env var
'POSTGRES_PASSWORD' is not set`. Готовая рабочая строка — ниже, после
> создания файла.

Создать файл с env-переменными для cron (cron не наследует ~/.bashrc):

> **Креды здесь — НЕ значения из GitHub Secret `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.**
> Это **Backups token** — ОТДЕЛЬНЫЙ R2 API Token, скоуп ТОЛЬКО `crm-backups` (§1.5). GitHub
> Secret с тем же именем — это **Documents token**, скоуп ТОЛЬКО `crm-documents-prod`, и он
> НЕ имеет доступа к `crm-backups`. Это намеренное разделение (§1.5) — Backups token
> заводится в Cloudflare отдельно и попадает **только** в этот файл, никогда в GitHub.

```bash
cat > /etc/crm-backup.env << 'EOF'
POSTGRES_PASSWORD=<значение из GitHub Secret POSTGRES_PASSWORD>
AWS_ACCESS_KEY_ID=<Access Key ID Backups-токена — см. врезку выше, НЕ GitHub Secret>
AWS_SECRET_ACCESS_KEY=<Secret Access Key Backups-токена — см. врезку выше, НЕ GitHub Secret>
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=crm-backups
S3_REGION=auto
BACKUP_RETENTION_DAYS=30
EOF
chmod 600 /etc/crm-backup.env
```

Установить cron-строку (она загружает env-файл сама):

```bash
0 3 * * * set -a; . /etc/crm-backup.env; set +a; /opt/crm/scripts/devops/pg-backup.sh >> /var/log/crm-backup.log 2>&1
```

> **`set -a` здесь обязателен, не украшение — не «упрощать» до `. file && script`.**
> Загрузка файла создаёт переменные в ТЕКУЩЕЙ оболочке, а `pg-backup.sh`
> запускается ОТДЕЛЬНЫМ процессом и необъявленных на экспорт переменных не
> наследует. Проверено опытом 2026-08-04: `. env && child.sh` → дочерний процесс
> видит пустое значение; `set -a; . env; set +a; child.sh` → видит. Прежняя
> формулировка в этом файле (`source ... && ...`) была сломана дважды: помимо
> экспорта, cron исполняет команды через `/bin/sh`, а это на Ubuntu `dash`, где
> команды `source` не существует вовсе — только точка. Альтернатива, если
> хочется без `set -a`, — прописать `export` перед каждой строкой env-файла.

Зависимость: `aws` CLI v2 — установить по инструкции в заголовке скрипта.

**После установки cron — обязательно прогнать `pg-backup.sh` вручную один
раз** (`set -a; . /etc/crm-backup.env; set +a; /opt/crm/scripts/devops/pg-backup.sh`)
и убедиться, что объект появился в бакете (см. §8.1) — не полагаться только
на ожидание следующего 03:00 UTC. Именно этот шаг раньше пропускали и
никогда не замечали.

**Restore:** процедура восстановления описана в комментарии в конце `pg-backup.sh`.

### 8.1 Как убедиться, что бэкапы реально идут (не просто настроены)

Раньше это состояние (настроен ли cron и реально ли он отрабатывает) ничем
не проверялось — отсюда инцидент выше. Теперь есть два независимых способа
проверить:

- **Автоматический сигнал (task-infra-prod-backup-safety-net, round 2,
  2026-08-03).** `deploy.yml`'s `deploy` job на каждый прогон (после любого
  мержа в `main` + еженедельный ребилд по воскресеньям, см. `schedule:` в
  `deploy.yml`) идёт по SSH на VPS (тот же `appleboy/ssh-action` + `VPS_HOST`/
  `VPS_SSH_KEY`, что и остальные SSH-шаги деплоя — не отдельный канал) и
  гоняет `scripts/devops/check-backup-freshness.sh` ПРЯМО НА СЕРВЕРЕ. Это не
  случайный выбор: креды, которые могут читать `crm-backups`, специально
  живут ТОЛЬКО в `/etc/crm-backup.env` на VPS (§1.5) и никогда не попадают в
  GitHub Actions — проверка обязана исполняться там же, где эти креды
  легитимно есть, иначе GitHub-секреты снова понадобились бы для чтения
  бэкапного бакета, что и обесценило бы разделение токенов.

  Скрипт на сервере читает `/etc/crm-backup.env` и возвращает ТОЛЬКО
  `STATUS=`/`AGE_HOURS=`/`OBJECTS=` — ни ключи, ни endpoint, ни имена
  объектов наружу не идут (см. заголовок скрипта). `deploy.yml` различает
  **три** исхода, а не сваливает их в один:

  | STATUS                     | Значит                                              | Реакция                               |
  | -------------------------- | --------------------------------------------------- | ------------------------------------- |
  | `not_configured`           | `/etc/crm-backup.env` отсутствует или неполный      | Alert: «бэкапы не настроены»          |
  | `stale`                    | Объект есть, но старше 24ч (или объектов нет вовсе) | Alert: «бэкапы протухли»              |
  | `fresh`                    | Объект младше 24ч                                   | Закрывает открытый alert (если был)   |
  | _(SSH упал / скрипт упал)_ | Проверить не удалось — НЕ значит «бэкапов нет»      | Ничего не трогает, только `::warning` |

  Первые три — определённые состояния (обрабатывает
  `scripts/devops/interpret-backup-freshness.sh`); последнее — намеренно
  **не** трогает alert-issue вообще: если проверка не смогла посмотреть на
  бакет (SSH недостижим, скрипт упал непредвиденно), утверждать «бэкапов
  нет» было бы ложью, а не сигналом. Реальный alert (open/comment/close)
  идёт через **ту же** механику, что уже используется для красного `Deploy`
  (`scripts/devops/post-merge-alert.sh`, `scripts/devops/resolve-alert-
channel.sh`, `KIND=backup`) — приватный телеметрийный репозиторий, либо
  этот репозиторий как fallback, если PAT недоступен. Issue закрывается
  автоматически, когда следующая проверка находит `STATUS=fresh`. Эта
  проверка **не роняет сам деплой** (см. комментарий в `deploy.yml` рядом с
  шагом "Check backup freshness on VPS (SSH)") — свежесть бэкапа никак не
  связана с тем, успешно ли прошла ЭТА выкатка, поэтому это отдельный
  операционный сигнал, а не гейт мержа.

- **Ручная проверка в любой момент (на самом VPS, теми же кредами):**
  ```bash
  set -a; . /etc/crm-backup.env; set +a
  aws s3 ls "s3://${S3_BUCKET}/backups/" --region "${S3_REGION}" \
    --endpoint-url "${S3_ENDPOINT}"
  ```
  Самый свежий объект по времени (`crm-db-<timestamp>.sql.gz`) не должен
  быть старше суток. (С ноутбука владельца эта команда не отработает —
  Backups token туда намеренно не попадает, см. §1.5.)

---

## 9. Rollback

```bash
# Список доступных тегов (git SHA) в GHCR:
# GitHub → Packages → cheekycheeseit-crm-api → версии

# Задеплоить конкретный тег вручную через workflow_dispatch:
# GitHub → Actions → Deploy → Run workflow → image_tag: <git-sha>

# Или прямо на VPS (экстренный rollback без CI):
ssh <VPS_USER>@<VPS_IP>
cd /opt/crm
IMAGE_TAG=<старый-sha> docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  pull api nginx
IMAGE_TAG=<старый-sha> docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  up -d
```

---

## 10. Обслуживание

```bash
# Логи:
docker compose -f /opt/crm/docker-compose.prod.yml \
               -f /opt/crm/docker-compose.ghcr.yml \
               --env-file /opt/crm/.env.production \
               logs -f api

docker compose ... logs -f nginx

# Перезапустить только API (например, после изменения .env):
docker compose ... restart api

# Полная остановка:
docker compose ... down

# ДЕСТРУКТИВНО (уничтожает все данные):
docker compose ... down -v
```

---

## 11. Заметки по архитектуре

### Cloudflare + real client IP

Когда Cloudflare проксирует трафик (Proxied = да), `$remote_addr` в nginx — это
IP Cloudflare, а не реального клиента. Nginx настроен (в `nginx/conf.d/crm.conf`
и `landing.conf`) с блоком `set_real_ip_from <CF-CIDR>` + `real_ip_header CF-Connecting-IP`,
что восстанавливает реальный IP клиента в `$remote_addr` до того как он попадёт
в `X-Forwarded-For` к API.

Это критично: IP записывается как юридическое доказательство при подписании контрактов
и ToS, а также используется rate-limiter'ом NestJS.

> **Без host-firewall (§1.6) этот механизм обходится:** прямое обращение к origin-IP минуя Cloudflare
> позволяет подделать `CF-Connecting-IP`, т.к. nginx доверяет CF-диапазонам. Локдаун origin на
> Cloudflare (§1.6) — обязательное условие достоверности IP-доказательства. `set_real_ip_from`
> доверяет ТОЛЬКО CF-CIDR (не `0.0.0.0/0`) — проверь это при обновлении CF-диапазонов.

Список CF CIDR нужно обновлять при изменении Cloudflare (редко, но бывает):

- IPv4: https://www.cloudflare.com/ips-v4
- IPv6: https://www.cloudflare.com/ips-v6

**X-Forwarded-For: nginx ПЕРЕЗАПИСЫВАЕТ, не аппендит (проверено для `/api/public/*`).**
Deployment-нота из security-review PR #390 (public vacancy-apply endpoint, `POST
/api/public/vacancies/:slug/apply`, опирается на `req.ip` для rate-limit): все `location /api/`
блоки в `nginx/conf.d/crm.conf` **и** `nginx/conf.d/landing.conf` (HTTP и HTTPS server-блоки, оба
файла) используют `proxy_set_header X-Forwarded-For $remote_addr;` — это **перезаписывает**
заголовок значением `$remote_addr` (уже восстановленным из `CF-Connecting-IP` через
`set_real_ip_from`), а не аппендит к входящему клиентскому XFF (как сделал бы
`$proxy_add_x_forwarded_for`). Это уже корректно настроено — клиент не может подделать XFF,
который увидит API. Публичный `/api/public/*` эндпоинт вакансий проксируется через тот же
`location /api/` блок (нет отдельного location для `/api/public/*`), поэтому наследует ту же
защиту. Изменений в `nginx.conf`/`conf.d/*` для этого не потребовалось — только фиксация факта.

### VITE_API_URL

Значение `/api` запекается в CRM SPA bundle на этапе сборки образа nginx (BuildArg).
При изменении — пересобрать образ (CI делает это автоматически при каждом деплое).

### Drizzle migrations vs seed

- `db:push` (`drizzle-kit push`) — идемпотентная синхронизация схемы. Запускать на каждый деплой.
- `db:seed` (`tsx src/database/seed.ts`) — создаёт тестовые данные. **НИКОГДА в продакшене.**
  Только два ADMIN-пользователя вручную (§6).

### SEO: prerender + деиндекс CRM + Lighthouse gate (task-infra-seo-gates)

**Владелец: только `cheekycheese.tech` (лендинг) должен быть индексируем. `app.cheekycheese.tech`
(CRM) — рабочий инструмент, деиндексирован намеренно.**

**1. Деиндекс CRM.** `nginx/conf.d/crm.conf` (оба server-блока, :80 и :443) отдаёт
`X-Robots-Tag: noindex, nofollow, noarchive` на **каждый** ответ app-домена — не только HTML, но и
статику (js/css/шрифты/картинки/sw.js/index.html), т.к. nginx **не наследует** `add_header` в
location, который сам определяет свой `add_header` (классическая nginx-гоча — см. комментарий в
самом `crm.conf`). Заголовок продублирован явно в каждом таком location. `location = /robots.txt`
на app-домене отдаёт inline `User-agent: *\nDisallow: /` — файла в `apps/web/dist` нет и не нужен.
`apps/web/index.html` НЕ получил meta-тег `noindex` (вне зоны DevOps) — nginx-заголовок покрывает и
HTML, и ассеты, этого достаточно.

**2. Лендинг остаётся индексируемым.** `nginx/conf.d/landing.conf` НЕ получил X-Robots-Tag и НЕ
получил отдельный `location` для `/robots.txt`/`/sitemap.xml` — оба файла отдаются напрямую из
`apps/landing/dist` (Vite копирует `apps/landing/public/*` в корень dist), как только
task-landing-seo-prerender положит их в `apps/landing/public/`. **Owner-TODO после того как эта
задача смержена и задеплоена:** проверить `curl https://cheekycheese.tech/sitemap.xml`, что sitemap
НЕ содержит URL на `app.cheekycheese.tech` (это ответственность Coder-задачи, но именно владелец —
последняя проверка перед отправкой в Google Search Console, см. пункт 4 ниже).

**3. Prerender в прод-сборке.** `nginx/Dockerfile` (`landing-builder` stage) переведён с
`node:20-alpine` на `mcr.microsoft.com/playwright:v1.59.1-noble` (Chromium требует glibc — Alpine
не подходит; версия запинена под `@playwright/test` из `pnpm-lock.yaml`, апгрейдить вместе). После
обычного `vite build` идёт **forward-compatible guard**: если у `apps/landing/package.json` есть
скрипт `build:prerender` (добавляет отдельная параллельная задача
task-landing-seo-prerender/`feature/landing-seo-prerender`) — гоняется он (Playwright обходит роуты
лендинга и пишет статический HTML для краулеров); если скрипта ещё нет — шаг no-op с
`::warning::` в логе сборки, используется обычный CSR-дист. Это значит: **инфра-PR и PR с
prerender-скриптом можно мержить в любом порядке**, ни один не ломает деплой другого.
`PRERENDER_API_ORIGIN=https://cheekycheese.tech` передаётся build-arg'ом в `deploy.yml` — во время
сборки образа старый контейнер ещё жив и обслуживает прод-трафик (switchover — позже, на шаге
`docker compose up -d` в deploy job), так что обращение к реальному прод-API за данными для
пререндера (например, опубликованные вакансии) безопасно.

**4. Lighthouse CI гейт.** `.github/workflows/lighthouse.yml` — отдельный workflow (НЕ job в
`ci.yml`, т.к. триггерится только на `apps/landing/**`-диффы через `paths:`, в отличие от всегда
идущих required-checks `ci.yml`). Собирает лендинг тем же forward-compatible guard'ом, что и
`nginx/Dockerfile` (если скрипта `build:prerender` ещё нет — обычный `vite build`), затем
`npx @lhci/cli@0.15.1 autorun` против `scripts/devops/lighthouserc.json` (staticDistDir —
встроенный статик-сервер lhci, без доп. зависимостей) на **mobile И desktop** пресетах (matrix)
с ассертами `performance/accessibility/best-practices/seo ≥ 0.90`, 3 прогона, медиана.
**НЕ LHCI-дефолт** — `@lhci/utils/src/assertions.js` дефолтит `aggregationMethod` на `optimistic`
(для `minScore`-ассертов это буквально `Math.max` по трём прогонам — берёт ЛУЧШИЙ результат, не
медианный; проверено эмпирически: 3 локальных прогона дали performance 85/92/86, `optimistic`
молча пропустил порог 0.9 по лучшему значению 0.92). `scripts/devops/lighthouserc.json` явно
задаёт `"aggregationMethod": "median"` на уровне `ci.assert` — не убирать, посчитав избыточным
рядом с `numberOfRuns`. Красный ассерт красит PR-check (`Lighthouse (mobile)` / `Lighthouse
(desktop)`) — **это НЕ required
status check** (branch protection без required checks — см. `devops.md` "Branch Protection"), так
что red flag виден, но не блокирует merge жёстко; PM/reviewer должны требовать зелёный перед
`merge-approved` на любом PR трогающем `apps/landing/**`.

**5. Google Search Console — ЕДИНСТВЕННЫЙ шаг, который не автоматизируется (owner-TODO):**

1. https://search.google.com/search-console → "Add property" → `cheekycheese.tech` (Domain
   property, не URL-prefix — покрывает `www.` и без-`www` разом).
2. Верифицировать владение через Cloudflare DNS TXT-запись (Search Console покажет значение)
   ИЛИ HTML-файл (не подходит — SPA без статик-хостинга произвольных файлов через Cloudflare
   Pages; DNS TXT — самый простой вариант при уже настроенном Cloudflare DNS из §1.2).
3. После верификации → Sitemaps → отправить `https://cheekycheese.tech/sitemap.xml` (файл появится
   после того как task-landing-seo-prerender смержена и задеплоена — до этого 404, это нормально).
4. **НЕ добавлять `app.cheekycheese.tech` как отдельный property** — CRM намеренно деиндексирован,
   верифицировать его в GSC незачем и создаёт риск случайного "Request indexing" внутренних страниц.

---

## 12. Что ещё НЕ протестировано автоматически

- Drizzle migrations внутри prod API-контейнера (§5) — `drizzle-kit` не в prod-образе.
- `pg-backup.sh` — требует aws CLI и работающий R2/S3 бакет.
- `scripts/devops/check-backup-freshness.sh` + `scripts/devops/interpret-backup-freshness.sh` —
  все состояния (not_configured / stale / fresh / aws-error) и отсутствие утечки секретов в
  вывод проверены локально через `CRM_BACKUP_ENV_FILE`/`FAKE_MODE=1`/подставной `aws`
  (см. `task-infra-prod-backup-safety-net`), но НЕ по реальному SSH на VPS и НЕ против
  реального бакета `crm-backups` — R2-бакет и Backups-токен (§1.5) ещё не созданы
  владельцем.
- TLS / Cloudflare Full (strict) handshake с origin-cert на nginx.
- Реальный smoke-test через `https://app.cheekycheese.tech/api/health`.
- `set_real_ip_from` CF CIDR — корректность real-IP restore под Cloudflare proxied.
- Host-firewall (§1.6) — что origin реально недостижим напрямую минуя Cloudflare
  (проверить: запрос на origin-IP в обход CF должен таймаутиться/отклоняться).
- `pg-backup.sh` retention-prune — что старые бэкапы реально удаляются (epoch-сравнение).
- `ngx_http_realip_module` присутствует в nginx-образе (в `nginx:alpine` есть по умолчанию;
  убедиться, что кастомный nginx Dockerfile его не выпиливает).
- `deploy.yml` `permissions:` least-privilege — что job'ы успешно работают с урезанным токеном
  (build: packages:write, deploy: packages:read, остальные: contents:read).
- **task-infra-seo-gates** (nginx configtest + curl-смоук пройдены локально через docker, см. PR —
  но НЕ на реальном проде): `curl -I https://app.cheekycheese.tech/` реально содержит
  `X-Robots-Tag: noindex`; `https://app.cheekycheese.tech/robots.txt` реально отдаёт `Disallow: /`
  через Cloudflare (не только напрямую на origin); `mcr.microsoft.com/playwright:v1.59.1-noble` как
  базовый образ `landing-builder` не увеличивает build-время деплоя выше приемлемого (первый
  реальный прод-деплой после мержа — замерить).
