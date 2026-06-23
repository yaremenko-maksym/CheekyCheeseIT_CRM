# Deployment Runbook — CheekyCheeseIT CRM

> **Статус:** черновик (VPS не провижнен). Весь pipeline построен и задокументирован.
> End-to-end деплой **не протестирован** — нет реального VPS.
> Разделы помечены `[UNTESTED]` там, где требуется проверка на живом сервере.

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
2. Создать R2 API Token: R2 → Manage API Tokens → Create API Token.
   - Scope: Object Read & Write на оба бакета.
   - Запомнить: Access Key ID, Secret Access Key.
3. Endpoint R2 выглядит так: `https://<account-id>.r2.cloudflarestorage.com`

> **Замечание по env-валидатору (`apps/api/src/config/env.ts`):**
> Текущий валидатор ожидает `S3_ENDPOINT` как валидный URL (`.string().url()`).
> Для Cloudflare R2 это `https://<account-id>.r2.cloudflarestorage.com` — валидный URL.
> **Проблема:** `S3_USE_SSE=true` отправляет заголовок `ServerSideEncryption: AES256`,
> который R2 **не поддерживает** (вернёт ошибку). Установите `S3_USE_SSE=false` для R2.
> Если `S3_FORCE_PATH_STYLE=true` нужен для R2 — проверьте поведение клиента AWS SDK
> с R2-endpoint (обычно R2 работает с path-style). **Задача для Coder:** при проблемах
> с R2 — правка `S3_USE_SSE` логики в `apps/api/src/s3/s3.service.ts` для автоопределения.

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

---

## 3. GitHub Secrets — полный список

Добавить в **GitHub → Settings → Secrets and variables → Actions → Secrets** (уровень Repository).
Дополнительно создать **Environment "production"** и добавить туда же для дополнительной защиты.

| Secret                  | Значение / как получить                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `VPS_HOST`              | IP-адрес VPS (из §1.1)                                                                                           |
| `VPS_USER`              | SSH-пользователь (обычно `root` или выделенный deploy-user)                                                      |
| `VPS_SSH_KEY`           | Содержимое приватного ключа `~/.ssh/crm_deploy_key` (весь файл включая `-----BEGIN...-----`)                     |
| `POSTGRES_PASSWORD`     | `openssl rand -base64 32` — сильный пароль (≥32 символа)                                                         |
| `JWT_SECRET`            | `openssl rand -base64 48` — минимум 32 символа                                                                   |
| `SESSION_SECRET`        | `openssl rand -base64 48` — минимум 32 символа                                                                   |
| `CREDENTIALS_ENC_KEY`   | `openssl rand -base64 32` — должно быть ровно 32 байта AES-256                                                   |
| `GOOGLE_CLIENT_ID`      | Из Google Cloud Console → OAuth 2.0 Client (§1.3)                                                                |
| `GOOGLE_CLIENT_SECRET`  | Оттуда же                                                                                                        |
| `S3_ENDPOINT`           | R2: `https://<account-id>.r2.cloudflarestorage.com`; AWS S3: оставить пустым (SDK использует дефолтный endpoint) |
| `S3_REGION`             | R2: `auto`; AWS S3 Frankfurt: `eu-central-1`                                                                     |
| `S3_BUCKET`             | `crm-documents-prod`                                                                                             |
| `S3_FORCE_PATH_STYLE`   | R2: `true`; AWS S3: `false`                                                                                      |
| `AWS_ACCESS_KEY_ID`     | R2 API Token Access Key ID (§1.5) или AWS IAM ключ                                                               |
| `AWS_SECRET_ACCESS_KEY` | R2 API Token Secret или AWS IAM секрет                                                                           |

> `GITHUB_TOKEN` (для GHCR login в deploy) генерируется GHA автоматически — добавлять не нужно.

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

-- Вставить двух ADMIN-пользователей (заменить email на реальные Google-аккаунты):
INSERT INTO users (
  id,
  email,
  display_name,
  legal_full_name,
  role,
  senior_share_percent,
  created_at,
  updated_at
) VALUES
  (
    gen_random_uuid(),
    'admin1@gmail.com',         -- ← реальный Google email владельца 1
    'Admin One',
    'Ім''я По-Батькові Прізвище',
    'ADMIN',
    NULL,
    NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    'admin2@gmail.com',         -- ← реальный Google email владельца 2 (если нужен)
    'Admin Two',
    'Ім''я По-Батькові Прізвище',
    'ADMIN',
    NULL,
    NOW(), NOW()
  )
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
9. **После успешного ручного деплоя** — включить автодеплой:
   В `.github/workflows/deploy.yml` раскомментировать блок:
   ```yaml
   push:
     branches: [main]
   ```
   Закоммитить и запушить.

---

## 8. Автоматические бэкапы PG

Скрипт: `scripts/devops/pg-backup.sh`.
Расписание: ежедневно в 3:00 UTC.

```bash
# На VPS — установить cron:
crontab -e
# Добавить строку:
0 3 * * * /opt/crm/scripts/devops/pg-backup.sh >> /var/log/crm-backup.log 2>&1
```

Создать файл с env-переменными для cron (cron не наследует ~/.bashrc):

```bash
cat > /etc/crm-backup.env << 'EOF'
POSTGRES_PASSWORD=<значение из GitHub Secret>
AWS_ACCESS_KEY_ID=<значение из GitHub Secret>
AWS_SECRET_ACCESS_KEY=<значение из GitHub Secret>
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=crm-backups
S3_REGION=auto
BACKUP_RETENTION_DAYS=30
EOF
chmod 600 /etc/crm-backup.env
```

Обновить cron-строку для source env:

```bash
0 3 * * * source /etc/crm-backup.env && /opt/crm/scripts/devops/pg-backup.sh >> /var/log/crm-backup.log 2>&1
```

Зависимость: `aws` CLI v2 — установить по инструкции в заголовке скрипта.

**Restore:** процедура восстановления описана в комментарии в конце `pg-backup.sh`.

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

Список CF CIDR нужно обновлять при изменении Cloudflare (редко, но бывает):

- IPv4: https://www.cloudflare.com/ips-v4
- IPv6: https://www.cloudflare.com/ips-v6

### VITE_API_URL

Значение `/api` запекается в CRM SPA bundle на этапе сборки образа nginx (BuildArg).
При изменении — пересобрать образ (CI делает это автоматически при каждом деплое).

### Drizzle migrations vs seed

- `db:push` (`drizzle-kit push`) — идемпотентная синхронизация схемы. Запускать на каждый деплой.
- `db:seed` (`tsx src/database/seed.ts`) — создаёт тестовые данные. **НИКОГДА в продакшене.**
  Только два ADMIN-пользователя вручную (§6).

---

## 12. Что НЕ протестировано (нет VPS)

- Фактическое выполнение workflow `deploy.yml` на реальном VPS.
- Drizzle migrations внутри prod API-контейнера (§5) — `drizzle-kit` не в prod-образе.
- `pg-backup.sh` — требует aws CLI и работающий R2/S3 бакет.
- TLS / Cloudflare Full (strict) handshake с origin-cert на nginx.
- Реальный smoke-test через `https://app.cheekycheese.tech/api/health`.
- `set_real_ip_from` CF CIDR — корректность real-IP restore под Cloudflare proxied.
