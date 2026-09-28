# signal-plus multi-account — design

**Date:** 2026-09-28
**Status:** approved in chat (owner), implementing
**Scope:** `services/signal-plus/**` only. Standalone Python service; not a
critical-path zone (no auth/finance/RBAC in the CRM). Independent compose
project on the VPS (`/opt/signal-plus`).

## Goal

Today signal-plus sends the morning `+` roll-call from **one** Signal
account. The owner wants **several** accounts (real people, each `+` sent
from their own number) served by the **same** service, and adding the next
person to be simple. Owner's two decisions (AskUserQuestion, 2026-09-28):

1. **Topology:** one container, a list of accounts (not one container per
   person).
2. **Group:** everyone sends to the **same** group as the owner (shared
   `SIGNAL_GROUP_ID`).

## Key fact that shapes the design

The hardened, tested modules — `signal.py`, `updater.py`, `alert.py`,
`slot.py`, `state.py` — are **already per-account**: every one takes a single
`Config` and drives `signal-cli -a <config.signal_account>`. The
single-account assumption lives in exactly three places: `Config.from_env`
(flat env → one `Config`), `state.json` (one file), and the driving loop in
`cli.py`. So "several users" = "build N `Config`s and drive them", **not** a
rewrite of the hardened core. The core's shape does not change → its 185
tests and four security rounds stay intact.

## 1. Config (`config.py`) — add a resolver above the unchanged `Config`

`Config` (the per-account, hardened dataclass every core module consumes) is
**unchanged**. New:

```
resolve_configs(env=None) -> list[Config]
```

- If `SIGNAL_ACCOUNTS` is **unset/blank** → `[Config.from_env(env)]`. Existing
  single-account deploy and every existing test are byte-for-byte unaffected
  (backward compatible).
- If `SIGNAL_ACCOUNTS` is set (comma-separated E.164) → one `Config` per
  number, built by reusing `Config.from_env` on a per-account env:
  `{**shared_env, SIGNAL_ACCOUNT: <number>, STATE_FILE: <derived>}`. Reusing
  `from_env` means all validation/parsing (handover time, skip-weekdays,
  tmpdir, gpg, alerting) is shared, zero duplication.
- **Per-account state file** derived from the shared `STATE_FILE` as base:
  `dir/<stem>-<sha256(number)[:12]><suffix>` (e.g.
  `/data/signal-plus/state-ab12cd34ef56.json`). A stable hash, **not** the raw
  number — the number is a secret we mask in logs, so it does not go into a
  filename either.
- **Validation** (mirrors `_parse_skip_weekdays`' style): reject blank entries
  and duplicate numbers (a duplicate would collide on state file and
  double-send), `ConfigError` naming `SIGNAL_ACCOUNTS`.

Shared across all accounts (one value each, unchanged): `SIGNAL_GROUP_ID`,
`SIGNAL_CLI_BIN`, `SIGNAL_DATA_DIR`, `SIGNAL_CLI_GPG_FINGERPRINT`,
`SIGNAL_TMPDIR`, `HANDOVER_TIME`, `SIGNAL_SKIP_WEEKDAYS`, and all alert vars.

## 2. Run model (`cli.py`) — single-threaded slot-ordered scheduler

The independence of each account's random slot matters: two `+` at the same
instant look automated. Sequentially blocking `run_cycle` per account would
collapse the slots (account 2 only starts waiting after account 1 sends). So:

- Add optional `slot_override: datetime | None` to `run_cycle`. When
  `wait_for_slot` and `slot_override` is given, use it instead of
  `pick_slot`. Backward compatible (existing callers pass none → pick as
  before).
- New `run_accounts_once(configs, ...)`: pick each account's slot up front,
  **sort ascending by slot**, then drive `run_cycle(cfg, slot_override=slot)`
  in that order. Single-threaded → never two `signal-cli` at once → no
  concurrency assumptions about the shared signal-cli data dir or the shared
  auto-update binary swap. Earliest-slot-first ordering preserves each
  account's independent send time; already-sent / skipped accounts no-op
  immediately when reached (idempotency check runs before the slot wait).
- New `run_daemon_multi(configs, ...)`: `run_accounts_once` then sleep
  `DAEMON_RECHECK_INTERVAL`, repeat (same shape as `run_daemon`).
- `main_with_config` (single `Config`) stays **exactly as-is** — the tested
  N=1 real path. New `main_with_configs(configs, argv, ...)` handles N>1:
  `--groups` iterates all accounts (prints a masked-account header each),
  `--now` drives each `run_cycle(wait_for_slot=False)`, `--once`/daemon use the
  scheduler. `main()` branches: `len==1 → main_with_config`, else
  `main_with_configs`. Zero regression risk to the single-account path.

## 3. Alert attribution

Alerts are already per-config, but the text is account-agnostic — with N
accounts the owner cannot tell **whose** `+` failed. Add
`config.masked_account()` to the handover/exhaustion alert subject (log + DM)
and to the handover-email subject. Masked, never the raw number (same
discipline as everywhere else). Single-account gets a harmless `[+3***7]`
prefix.

## 4. Healthcheck (`docker-healthcheck.py`)

`check(now)` iterates `resolve_configs()` and is healthy only if **every**
account is healthy; otherwise UNHEALTHY naming the first bad account (masked).
Single-account behavior identical (list of one). Existing tests unaffected.

## 5. Docs

`.env.example`: document `SIGNAL_ACCOUNTS` and that per-account state files are
derived automatically. `README.md`: a "Добавить участника" section — append
the number to `SIGNAL_ACCOUNTS`, redeploy, then link that number once by QR in
the same container (`signal-cli -a <number> link ...`; one data dir holds
several linked devices).

## Testing (TDD, no network — conftest blocks sockets + empties PATH)

- `test_config.py`: single-account fallback; multi parse; blank/duplicate
  rejection; per-account state-path derivation; shared group across configs.
- `test_cli.py`: scheduler drives accounts in slot order; each sends once; one
  already-sent no-ops while the other sends; `--groups`/`--now` iterate all;
  `run_daemon_multi` loops; alert subject carries the masked account.
- `test_docker_healthcheck.py`: healthy only when all accounts resolved;
  unhealthy names the offending account.

## 6. Test send for a freshly-linked account (added mid-design, owner)

Before a newly-linked account joins the real roll-call, verify it end-to-end
by sending one `+` to **its own** group named «тест». Owner decisions
(AskUserQuestion, 2026-09-28): find the group **by name** «тест» (auto, no id
to copy); invoke **per account** — `signal-plus --test <account>` — which must
work even for an account **not yet** in `SIGNAL_ACCOUNTS`.

- **`signal.list_groups_json`** — `signal-cli --output json listGroups`.
  Schema verified against `AsamK/signal-cli` v0.14.7 `ListGroupsCommand.java`
  (`JsonGroup` record: `id`, `name`). The human `listGroups` output has no
  documented format to parse; JSON does.
- **`signal.find_group_id_by_name(json, name)`** — pure, fails closed
  (`None`), matches name case-insensitively/trimmed.
- **`cli.run_test_send(config)`** — list groups (json) → find «тест» → `receive`
  → `send +` to that group id (via `replace(config, signal_group_id=...)`).
  **Stateless**: never reads/writes idempotency state; a test is not the daily
  roll-call. Returns `True` only if the `+` went out; every failure logs one
  masked-account error.
- **`config.config_for_account(account, env)`** — build a `Config` for an
  arbitrary account from the shared env, independent of `SIGNAL_ACCOUNTS`.
- **`cli.main`** intercepts `--test <account>` before `resolve_configs`
  (account need not be in the list), runs `run_test_send`, exits 0/1.

Workflow: create «тест» group on the new account → link by QR → `--test
<num>` confirms it sends → add the number to `SIGNAL_ACCOUNTS` → live.

## Out of scope (YAGNI)

Per-account group (owner chose shared), per-account alert recipient
(owner alerts stay shared), per-account window/handover. The resolver keeps
these shared; a later change can lift any of them to per-account without
touching the core.
