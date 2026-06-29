# S3-совместимое хранилище — Documents

Хранилище документов для CRM. **Dev: MinIO** (docker-compose), **Prod: Cloudflare R2** (S3-совместимый API).
Код работает через `@aws-sdk/client-s3` против обоих (отличие — только env: endpoint / creds / `S3_USE_SSE`).

## Обзор

| Среда | Backend                           | Endpoint                                        | Region                      | Bucket               |
| ----- | --------------------------------- | ----------------------------------------------- | --------------------------- | -------------------- |
| Dev   | MinIO (Docker)                    | `http://localhost:9000`                         | `us-east-1` (MinIO default) | `crm-documents`      |
| Prod  | **Cloudflare R2** (S3-совместимо) | `https://<account_id>.r2.cloudflarestorage.com` | `auto`                      | `crm-documents-prod` |

**Шифрование:** R2 шифрует все данные at-rest **по умолчанию** — заголовок SSE-S3 (`ServerSideEncryption: AES256`) НЕ нужен и R2 его **отвергает** (не реализует SSE-S3 протокол). Поэтому `S3_USE_SSE=false` и в dev (MinIO), и в prod (R2). Прод-значение **захардкожено** в `deploy.yml` (см. ниже) — менять на `true` только при миграции на настоящий AWS S3.

## Локальная разработка

```bash
# Поднять MinIO рядом с postgres/redis
docker-compose up -d minio

# Bucket `crm-documents` создаётся автоматически one-shot init контейнером `minio-bootstrap`
docker-compose logs minio-bootstrap
# → "MinIO bucket crm-documents ready"

# Web console
open http://localhost:9001
# Логин: minioadmin / minioadmin
```

Чек, что всё работает:

```bash
curl -f http://localhost:9000/minio/health/live   # → 200
```

API использует MinIO через стандартный AWS SDK с `S3_ENDPOINT=http://localhost:9000` и `S3_FORCE_PATH_STYLE=true` (MinIO не поддерживает virtual-hosted style).

## Production setup (Cloudflare R2)

R2 — это S3-совместимое объектное хранилище Cloudflare. Главные отличия от AWS S3: **нет egress-платы**, доступ через **R2 API tokens** (не IAM), шифрование at-rest **встроено** (нет шага SSE), бакеты **приватные по умолчанию**.

### 1. Создать bucket

Через дашборд (Cloudflare → R2 → Create bucket, имя `crm-documents-prod`, location-hint EU) **или** Wrangler:

```bash
npx wrangler r2 bucket create crm-documents-prod
```

> Account ID — в Cloudflare dashboard (R2 → правый сайдбар «Account details»). Он же в S3-endpoint: `https://<account_id>.r2.cloudflarestorage.com`.

### 2. Создать R2 API token (S3-совместимые creds)

Cloudflare → R2 → **Manage R2 API Tokens** → Create API token:

- **Permission:** Object Read & Write (можно ограничить конкретным бакетом `crm-documents-prod`).
- На выходе — **Access Key ID** + **Secret Access Key** (это и есть S3-creds; кладём в `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` секреты, см. ниже — имена env унаследованы от AWS SDK, но указывают на R2-токен).

### 3. Шифрование — ничего не делать

R2 шифрует данные at-rest автоматически (AES-256, managed Cloudflare). Шага `put-bucket-encryption` нет; заголовок SSE-S3 не отправляется (`S3_USE_SSE=false`).

### 4. Публичный доступ — оставить закрытым

R2-бакеты приватны по умолчанию (нет публичного `r2.dev`/custom-domain — и не включаем). Скачивание у клиента — только через **pre-signed URL** (TTL 24h / 30 мин для sensitive, генерируется API).

### 5. CORS для presigned URL downloads

Браузер качает файлы по presigned URL → нужен CORS на бакете. Через дашборд (R2 → bucket → Settings → CORS policy) **или** S3 API:

```bash
aws s3api put-bucket-cors \
  --endpoint-url "https://<account_id>.r2.cloudflarestorage.com" \
  --bucket crm-documents-prod \
  --cors-configuration '{
    "CORSRules": [{
      "AllowedOrigins": ["https://app.cheekycheese.tech"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
      "MaxAgeSeconds": 3600
    }]
  }'
```

## GHA Secrets

Добавить в `Settings → Secrets and variables → Actions` (Repository secrets). Деплой (`deploy.yml`) маппит их в `/opt/crm/.env.production`:

| Secret                  | Значение (R2)                                   |
| ----------------------- | ----------------------------------------------- |
| `S3_ENDPOINT`           | `https://<account_id>.r2.cloudflarestorage.com` |
| `S3_REGION`             | `auto`                                          |
| `S3_FORCE_PATH_STYLE`   | `false` (R2 поддерживает virtual-hosted style)  |
| `S3_BUCKET`             | `crm-documents-prod`                            |
| `AWS_ACCESS_KEY_ID`     | R2 API token **Access Key ID**                  |
| `AWS_SECRET_ACCESS_KEY` | R2 API token **Secret Access Key**              |

> `S3_USE_SSE` в секретах **не нужен** — `deploy.yml` хардкодит `S3_USE_SSE=false` (R2 не принимает SSE-S3 заголовок). **Dev secrets НЕ нужны** — в CI прописаны dummy creds (`minioadmin/minioadmin`) с MinIO service рядом с postgres/redis.

## ⚠️ Production env vars (CRITICAL)

Dev/MinIO defaults в `apps/api/src/config/env.ts`:

- `AWS_ACCESS_KEY_ID=minioadmin`
- `AWS_SECRET_ACCESS_KEY=minioadmin`

Эти defaults удобны локально, но в production **ОБЯЗАТЕЛЬНО** переопределить настоящими R2-token creds (через GHA secrets выше). Иначе API падает при старте с явной ошибкой:

```
AWS_ACCESS_KEY_ID must be overridden in production (minioadmin default is for dev/MinIO only)
```

Защиту даёт `refine()` в `envSchema`: при `NODE_ENV=production` значения `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` не должны равняться `'minioadmin'` — иначе fail-fast.

`deploy.yml` пишет в `/opt/crm/.env.production` (фрагмент):

```bash
S3_ENDPOINT=<из secrets>
S3_FORCE_PATH_STYLE=<из secrets, false для R2>
S3_REGION=<из secrets, auto>
S3_BUCKET=<из secrets, crm-documents-prod>
S3_USE_SSE=false        # хардкод — R2 отвергает SSE-S3 заголовок
AWS_ACCESS_KEY_ID=<из secrets, R2 token>
AWS_SECRET_ACCESS_KEY=<из secrets, R2 token>
```

## Storage classes / lifecycle (FUTURE)

R2 поддерживает Standard + Infrequent Access classes и lifecycle-правила (дашборд → bucket → Settings → Object lifecycle rules) для авто-перевода старых объектов в IA. Сейчас НЕ настраиваем (объём мал). У R2 **нет Glacier** и **нет egress-платы**, так что cost-pressure минимальный — включать IA только когда storage реально вырастет (например RECEIPT/SCAN старше года). AVATAR/LOGO — всегда Standard (instant access).

## Cost monitoring

### R2 free tier / pricing

- **10 GB-month** storage бесплатно, далее ~$0.015/GB-month.
- **Class A** (write/list) 1M operations/month бесплатно, далее $4.50/M.
- **Class B** (read) 10M operations/month бесплатно, далее $0.36/M.
- **Egress: $0** (главное преимущество R2 vs S3 — нет платы за исходящий трафик).

Текущий проект (~11 users × ~50 docs/day через presigned URL + immutable Cache-Control) укладывается в free tier с огромным запасом (~16 500 read-ops/month ≪ 10M).

### Billing alert

Cloudflare → Billing → **Notifications** → создать budget-alert на R2 spend (например $5/month). У R2 нет AWS-Budgets-CLI; настраивается в дашборде.

## Troubleshooting

### `NoSuchBucket: The specified bucket does not exist`

**Dev:** `docker-compose logs minio-bootstrap` — bootstrap не отработал. Решение: `docker-compose down -v && docker-compose up -d` (rebuild volume).
**Prod:** проверить `S3_BUCKET` совпадает с реальным именем бакета в R2 (`npx wrangler r2 bucket list`); `S3_ENDPOINT` содержит правильный account_id.

### `AccessDenied` / `Access Denied`

- R2 API token не покрывает action (нужен Object Read & Write) или ограничен другим бакетом → пересоздать токен с нужными правами.
- Wrong creds в env (особенно `AWS_SECRET_ACCESS_KEY` с лишним пробелом из copy-paste).

### `CORS error` при download через presigned URL

Браузер блокирует cross-origin GET. Проверить CORS-политику бакета (R2 dashboard → bucket → Settings → CORS, или `aws s3api get-bucket-cors --endpoint-url <r2-endpoint> --bucket crm-documents-prod`). `AllowedOrigins` должен содержать домен фронтенда (`https://app.cheekycheese.tech`). На dev MinIO CORS открыт (`*`) by default.

### `NotImplemented` на PutObject (SSE)

R2 отвергает `ServerSideEncryption: AES256`. Убедиться, что `S3_USE_SSE=false` в проде (захардкожено в `deploy.yml`; в `apps/api/src/documents/s3.service.ts` заголовок отправляется только при `useSse=true`).

### `SignatureDoesNotMatch` / clock skew

Часы сервера разошлись > 15 мин. Dev (Docker): сверить `date` в контейнере vs хост. Prod (VPS): убедиться, что `chrony`/`systemd-timesyncd` работает (NTP-синхронизация).

### MinIO console (http://localhost:9001) не открывается

`docker-compose ps minio` → не `healthy`. Проверить `docker-compose logs minio` — обычно volume permissions issue на macOS (Docker Desktop ↔ APFS). Решение: `docker-compose down -v && docker-compose up -d minio`.
