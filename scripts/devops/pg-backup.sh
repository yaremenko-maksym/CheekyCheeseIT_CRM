#!/usr/bin/env bash
# ============================================================
# pg-backup.sh — PostgreSQL backup to S3 / Cloudflare R2
#
# Designed to run as a daily cron job ON THE VPS:
#   0 3 * * * /opt/crm/scripts/devops/pg-backup.sh >> /var/log/crm-backup.log 2>&1
#
# Required env vars (set in /etc/environment or sourced before cron):
#   POSTGRES_PASSWORD   — DB password (same as .env.production)
#   AWS_ACCESS_KEY_ID   — R2/S3 key ID
#   AWS_SECRET_ACCESS_KEY — R2/S3 secret
#   S3_ENDPOINT         — R2 endpoint: https://<account-id>.r2.cloudflarestorage.com
#                         or omit for AWS S3 (uses default AWS endpoint)
#   S3_BUCKET           — bucket name (e.g. crm-backups)
#   S3_REGION           — region (e.g. auto for R2, eu-central-1 for AWS)
#
# Optional:
#   BACKUP_RETENTION_DAYS — how many days of backups to keep in S3 (default: 30)
#   POSTGRES_CONTAINER    — docker-compose service name (default: postgres)
#   COMPOSE_DIR           — path to docker-compose files (default: /opt/crm)
#
# Dependencies (on VPS host):
#   docker                — to exec pg_dump inside the postgres container
#   aws CLI (>= 2.x)      — for S3 / R2 upload (aws s3 cp / aws s3 rm)
#     Install: curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
#              unzip awscliv2.zip && sudo ./aws/install
#
# *** UNTESTED — no VPS provisioned yet. Validate on first deploy. ***
# ============================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────
COMPOSE_DIR="${COMPOSE_DIR:-/opt/crm}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
BACKUP_FILENAME="crm-db-${TIMESTAMP}.sql.gz"
BACKUP_PATH="/tmp/${BACKUP_FILENAME}"

# ── Validate required env vars ────────────────────────────────────────────
required_vars=(POSTGRES_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_BUCKET S3_REGION)
for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "[ERROR] Required env var '$var' is not set. Aborting backup." >&2
    exit 1
  fi
done

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting backup: ${BACKUP_FILENAME}"

# ── Dump ─────────────────────────────────────────────────────────────────
# Run pg_dump inside the running postgres container (no port exposure needed).
docker compose \
  -f "${COMPOSE_DIR}/docker-compose.prod.yml" \
  -f "${COMPOSE_DIR}/docker-compose.ghcr.yml" \
  --env-file "${COMPOSE_DIR}/.env.production" \
  exec -T "${POSTGRES_CONTAINER}" \
  pg_dump \
    -U crm_user \
    -d crm_db \
    --no-password \
    --format=plain \
    --no-owner \
    --no-acl \
  | gzip -9 > "${BACKUP_PATH}"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Dump complete: $(du -sh "${BACKUP_PATH}" | cut -f1)"

# ── Upload to R2 / S3 ─────────────────────────────────────────────────────
# Build aws CLI extra args: endpoint-url for R2/MinIO; omit for AWS S3.
AWS_EXTRA_ARGS=()
if [ -n "${S3_ENDPOINT:-}" ]; then
  AWS_EXTRA_ARGS+=(--endpoint-url "${S3_ENDPOINT}")
fi

AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
aws s3 cp "${BACKUP_PATH}" \
  "s3://${S3_BUCKET}/backups/${BACKUP_FILENAME}" \
  --region "${S3_REGION}" \
  "${AWS_EXTRA_ARGS[@]+"${AWS_EXTRA_ARGS[@]}"}"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Uploaded to s3://${S3_BUCKET}/backups/${BACKUP_FILENAME}"

# ── Remove local temp file ────────────────────────────────────────────────
rm -f "${BACKUP_PATH}"
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Local temp file removed"

# ── Prune old backups from S3 (older than RETENTION_DAYS) ────────────────
CUTOFF_DATE=$(date -u -d "-${RETENTION_DAYS} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || date -u -v "-${RETENTION_DAYS}d" +"%Y-%m-%dT%H:%M:%SZ")  # macOS fallback

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Pruning backups older than ${RETENTION_DAYS} days (before ${CUTOFF_DATE})"

AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
aws s3 ls "s3://${S3_BUCKET}/backups/" \
  --region "${S3_REGION}" \
  "${AWS_EXTRA_ARGS[@]+"${AWS_EXTRA_ARGS[@]}"}" \
| awk '{print $4}' \
| while read -r obj; do
    OBJ_DATE=$(echo "${obj}" | grep -oP '\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z' | tr '-' ':' | sed 's/T/:/')
    if [ -n "${OBJ_DATE}" ] && [[ "${OBJ_DATE}" < "${CUTOFF_DATE}" ]]; then
      echo "  Deleting old backup: ${obj}"
      AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
      AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
      aws s3 rm "s3://${S3_BUCKET}/backups/${obj}" \
        --region "${S3_REGION}" \
        "${AWS_EXTRA_ARGS[@]+"${AWS_EXTRA_ARGS[@]}"}"
    fi
  done

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Backup complete. Retention: ${RETENTION_DAYS} days."

# ============================================================
# RESTORE procedure (run manually, NOT automated):
#
#   # Download the backup you want to restore:
#   aws s3 cp s3://<S3_BUCKET>/backups/crm-db-<TIMESTAMP>.sql.gz /tmp/restore.sql.gz \
#     [--endpoint-url <S3_ENDPOINT>] --region <S3_REGION>
#
#   # Stop the API to prevent writes during restore:
#   docker compose -f /opt/crm/docker-compose.prod.yml \
#                  -f /opt/crm/docker-compose.ghcr.yml \
#                  --env-file /opt/crm/.env.production \
#                  stop api
#
#   # Restore into the running postgres container:
#   gunzip -c /tmp/restore.sql.gz | \
#     docker compose -f /opt/crm/docker-compose.prod.yml \
#                    -f /opt/crm/docker-compose.ghcr.yml \
#                    --env-file /opt/crm/.env.production \
#                    exec -T postgres \
#                    psql -U crm_user -d crm_db
#
#   # Restart the API:
#   docker compose -f /opt/crm/docker-compose.prod.yml \
#                  -f /opt/crm/docker-compose.ghcr.yml \
#                  --env-file /opt/crm/.env.production \
#                  start api
#
#   rm /tmp/restore.sql.gz
# ============================================================
