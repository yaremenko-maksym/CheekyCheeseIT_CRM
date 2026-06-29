# S3 Storage — Documents (PHASE 6)

Хранилище документов для CRM. **Dev: MinIO** (docker-compose), **Prod: Cloudflare R2** (S3-совместимый API).

## Обзор

| Среда | Backend                           | Endpoint                | Region                      | Bucket               |
| ----- | --------------------------------- | ----------------------- | --------------------------- | -------------------- |
| Dev   | MinIO (Docker)                    | `http://localhost:9000` | `us-east-1` (MinIO default) | `crm-documents`      |
| Prod  | **Cloudflare R2** (S3-совместимо) | R2 S3-endpoint          | —                           | `crm-documents-prod` |

> ⚠️ **Прод = Cloudflare R2** (миграция с AWS S3). Раздел «Production setup (AWS S3)» ниже — **legacy-референс** для S3-совместимого API; R2-специфичная настройка (R2 dashboard / wrangler / R2 API-токены) + проверка `ServerSideEncryption: AES256` на R2 (R2 шифрует at-rest сам) — **TBD, отдельная задача**.

**Шифрование:** SSE-S3 (AES-256, managed by AWS, бесплатно) — включается by default на prod bucket (см. ниже). На dev MinIO `S3_USE_SSE=false` (MinIO не требует).

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

## Production setup (AWS S3)

### 1. Создать bucket

```bash
aws s3api create-bucket \
  --bucket crm-documents-prod \
  --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1
```

### 2. Включить SSE-S3 (AES-256) by default

```bash
aws s3api put-bucket-encryption \
  --bucket crm-documents-prod \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'
```

### 3. Заблокировать публичный доступ

```bash
aws s3api put-public-access-block \
  --bucket crm-documents-prod \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Скачивание у клиента — только через **pre-signed URL** (TTL 24h, генерируется API). Прямой public read запрещён.

### 4. CORS для presigned URL downloads

Браузер загружает файлы по presigned URL. Без CORS — `Access-Control-Allow-Origin` ошибка.

```bash
aws s3api put-bucket-cors \
  --bucket crm-documents-prod \
  --cors-configuration '{
    "CORSRules": [{
      "AllowedOrigins": ["https://crm.cheekycheese.it"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
      "MaxAgeSeconds": 3600
    }]
  }'
```

### 5. IAM policy — least privilege

Создать IAM user `crm-api-prod` с inline policy (только Put/Get/Delete + ListBucket для presigned URL генерации):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::crm-documents-prod", "arn:aws:s3:::crm-documents-prod/*"]
    }
  ]
}
```

Сгенерировать access key + secret для этого user — добавить в GHA secrets (см. ниже).

## GHA Secrets

Добавить в `Settings → Secrets and variables → Actions` (Repository secrets):

| Secret                       | Значение                              |
| ---------------------------- | ------------------------------------- |
| `AWS_ACCESS_KEY_ID_PROD`     | Access key из IAM user `crm-api-prod` |
| `AWS_SECRET_ACCESS_KEY_PROD` | Secret key из IAM user `crm-api-prod` |
| `S3_BUCKET_PROD`             | `crm-documents-prod`                  |
| `S3_REGION_PROD`             | `eu-central-1`                        |

**Dev secrets НЕ нужны** — в CI workflows прописаны dummy creds (`minioadmin/minioadmin`), которые работают с MinIO service запущенным рядом с postgres/redis.

## ⚠️ Production env vars (CRITICAL)

Dev/MinIO defaults в `apps/api/src/config/env.ts`:

- `AWS_ACCESS_KEY_ID=minioadmin`
- `AWS_SECRET_ACCESS_KEY=minioadmin`

Эти defaults удобны для локальной разработки (скрипт `prep-user-testing.sh` запускает API без `.env` overrides), но в production **ОБЯЗАТЕЛЬНО** переопределить через настоящие AWS creds (env vars или secrets manager). Иначе API упадёт при старте с явной ошибкой:

```
AWS_ACCESS_KEY_ID must be overridden in production (minioadmin default is for dev/MinIO only)
```

Эту защиту даёт `refine()` validator в `envSchema`: проверяет что при `NODE_ENV=production` значения `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` не равны `'minioadmin'`. Если равны — fail fast, API не стартует.

GitHub Actions secrets для prod deploy (см. таблицу выше):

- `AWS_ACCESS_KEY_ID_PROD`
- `AWS_SECRET_ACCESS_KEY_PROD`
- `S3_BUCKET_PROD=crm-documents-prod`
- `S3_REGION_PROD=eu-central-1`

В deploy workflow эти secrets маппятся в env vars без суффикса `_PROD`:

```yaml
env:
  NODE_ENV: production
  AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID_PROD }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY_PROD }}
  S3_BUCKET: ${{ secrets.S3_BUCKET_PROD }}
  S3_REGION: ${{ secrets.S3_REGION_PROD }}
```

## Lifecycle policy — Glacier auto-archive (FUTURE)

Не включаем сейчас. Когда понадобится сокращать storage cost — пример для архивации чеков старше 1 года в Glacier ($0.004/GB vs Standard $0.023/GB — экономия ~83%):

```bash
# FUTURE: НЕ запускать сейчас
# aws s3api put-bucket-lifecycle-configuration \
#   --bucket crm-documents-prod \
#   --lifecycle-configuration '{
#     "Rules": [{
#       "ID": "archive-old-receipts",
#       "Status": "Enabled",
#       "Filter": {"Prefix": "documents/receipts/"},
#       "Transitions": [{"Days": 365, "StorageClass": "GLACIER"}]
#     }]
#   }'
```

Restore из Glacier — 3-5 часов (Standard) или 1-5 мин (Expedited, $0.03/GB). Применять только к категориям где это приемлемо (RECEIPT, старые SCAN). НЕ применять к AVATAR/LOGO (нужны instant access).

## Cost monitoring

### Free tier (первый год)

- 5 GB Standard storage
- 20 000 GET requests/month
- 2 000 PUT requests/month
- 100 GB egress data transfer

Текущий проект (~11 users × ~50 docs/day просмотров через presigned URL + immutable Cache-Control headers) укладывается в free tier с большим запасом — реальных GET'ов ~1 per doc per day per browser ≈ 550/day = 16 500/month.

### Billing alert

Поставить alert через AWS Budgets:

```bash
aws budgets create-budget \
  --account-id <ACCOUNT_ID> \
  --budget '{
    "BudgetName": "crm-s3-monthly",
    "BudgetLimit": {"Amount": "5", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": {"Service": ["Amazon Simple Storage Service"]}
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80
    },
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "ops@cheekycheese.it"}]
  }]'
```

Триггер на 80% от $5 → $4. Раньше чем counter добежит до реальных проблем.

## Troubleshooting

### `NoSuchBucket: The specified bucket does not exist`

**Dev:** `docker-compose logs minio-bootstrap` — bootstrap не отработал. Решение: `docker-compose down -v && docker-compose up -d` (rebuild volume).
**Prod:** проверить `S3_BUCKET` env var совпадает с реальным bucket name; bucket существует в правильном region (`aws s3api get-bucket-location --bucket crm-documents-prod`).

### `AccessDenied: Access Denied`

- IAM policy не покрывает action (`s3:PutObject` отсутствует) → исправить policy
- Bucket policy блокирует (на dev MinIO не должно быть)
- Wrong AWS credentials в env (особенно `AWS_SECRET_ACCESS_KEY` с лишним пробелом из copy-paste)

### `CORS error` при download через presigned URL

Браузер блокирует cross-origin GET. Проверить bucket CORS (`aws s3api get-bucket-cors --bucket crm-documents-prod`). `AllowedOrigins` должен содержать домен фронтенда (https://crm.cheekycheese.it). На dev MinIO CORS открыт (`*`) by default — проблем не должно быть.

### `SignatureDoesNotMatch`

Часы на сервере и AWS расходятся > 15 мин. На dev (Docker) проверить `date` внутри контейнера vs хост. На prod (EC2/ECS) — убедиться что `chrony`/`ntpd` работает.

### `RequestTimeTooSkewed`

То же что выше, но AWS отверг request как stale. Синхронизировать NTP.

### MinIO console (http://localhost:9001) не открывается

`docker-compose ps minio` → не `healthy`. Проверить `docker-compose logs minio` — обычно volume permissions issue на macOS (Docker Desktop ↔ APFS). Решение: `docker-compose down -v && docker-compose up -d minio`.
