# Гигиена диска прод-VPS

**Кому:** владельцу / DevOps, когда на VPS (`ssh crm-vps`) заканчивается место.
**Источник:** инцидент 2026-10-04 — 696 Docker-образов заняли ~60 ГБ, диск дошёл до 93%; ручная чистка освободила ~50.9 ГБ.

## Причина

Каждый деплой тянет свежие образы `api` и `nginx` с тегом по git SHA. Старые никто не удалял, а
`docker image prune -f` убирает только dangling (без тега) образы — SHA-теги к ним не относятся.

## Что теперь автоматически

- **Деплой** (`.github/workflows/deploy.yml`, последний шаг SSH-скрипта, только после всех
  успешных проверок): `docker image prune -af --filter "until=168h"` — удаляет неиспользуемые
  образы старше 7 дней. Образы последней недели остаются для быстрого отката. Активные образы и
  volumes не затрагиваются. Фильтр `until` считает по времени **создания** образа.
- **Логи контейнеров:** `docker-compose.prod.yml` (postgres, redis, api, nginx) и
  `services/signal-plus/docker-compose.yml` — `json-file`, `max-size: 10m`, `max-file: 5`
  (до 50 МБ на сервис). Применяется при пересоздании контейнера на деплое, без рестарта демона.
  `redis` и `postgres` получили лимит 2026-10-04, остальные — раньше.

## Симптом

Диск > 85% (`df -h /`), либо деплой падает на pull/распаковке образа с `no space left on device`.

## Диагностика

```bash
df -h /
docker system df            # образы / контейнеры / volumes / build cache
docker images | wc -l       # сотни образов = автоочистка не отрабатывает
du -xhd1 /var 2>/dev/null | sort -h | tail
du -xhd1 /var/lib/docker 2>/dev/null | sort -h | tail
```

## Ручная чистка

```bash
docker image prune -af --filter until=48h   # неиспользуемые образы старше 2 суток
docker builder prune -af --filter until=48h # build cache, если он большой (на VPS обычно пуст)
journalctl --vacuum-size=200M               # если разрастился системный журнал
```

Проверить результат: `df -h /` и `docker system df`.

## Что НЕ трогать

- **Volumes.** `postgres_data` — это данные Postgres, `redis_data`, `signal_data` — состояние
  Redis и привязка signal-cli. Не запускать `docker volume prune`, `docker system prune --volumes`,
  `docker compose down -v`.
- **Образы работающих контейнеров** (crm-nginx, crm-api, crm-postgres, crm-redis, signal-plus) —
  Docker их и так не удалит, но не форсировать `docker rmi -f`.
- **`/etc/docker/daemon.json`.** Любое изменение требует рестарта демона = даунтайм
  всего стека. Лимиты логов заданы в compose, а не в демоне — намеренно.
- `docker system prune -a` без `--filter` — снесёт всё неиспользуемое, включая образы для отката.

## Откат на образ старше 7 дней

Образ мог быть удалён очисткой. Это не препятствие: откат — `workflow_dispatch` деплоя с
`image_tag`, образ заново скачивается из GHCR (см. `docs/runbooks/deployment.md` §9).
