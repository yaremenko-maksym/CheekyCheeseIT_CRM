#!/usr/bin/env bash
# test-pre-bash-live-db-guard.sh — proves .claude/hooks/pre-bash-live-db-guard.sh
# still refuses every real way to boot a dev server against the owner's live
# database, and stops refusing commands that merely NAME one.
#
# WHY BOTH HALVES ARE HERE. The hook exists because of PR #485 (an agent's API
# listened on :3000 against the live crm_db for two minutes, harmless by luck).
# It was then narrowed on 2026-08-18 because it also blocked
# `git show <ref>:pnpm-lock.yaml | grep -n vite` — a pure read. A narrowing is
# only trustworthy if the dangerous corpus is re-run against it, so the RED half
# below is written as "every shape #485 could have arrived in": env-var prefix,
# behind `&&`, through `sh -c`, absolute path to the binary, a wrapper, a
# command substitution, and a line whose quoting does not even parse.
#
# The last three cases are about a different failure: a hook that CRASHES exits
# non-zero too. This suite asserts on the contract (decision body / markers),
# not on rc≠0, and pins the difference explicitly.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-live-db-guard.sh"
SAFE_DB="postgresql://crm_user:password@localhost:5432/crm_qa"
LIVE_DB="postgresql://crm_user:password@localhost:5432/crm_db"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

h() { hook_at "$HOOK" "$@"; }

# SR-M-19 - a check whose pass does not mean what the reader assumes. "The hook allowed
# it" cannot tell a launch that was PINNED from a command the hook never RECOGNISED as a
# launch: both exit 0. Every green case that is launch-shaped therefore also asserts that
# cmdscan recognises it as a launch (assert_launch_green), and the non-launches that must
# stay quiet assert the opposite (assert_not_a_launch). Without this, deleting a launcher
# from the recognition list turns the whole suite green for the wrong reason.
RECOGNISE_PY='
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("cmdscan", os.environ["CMDSCAN"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
hits = m.launches(m.scan(os.environ["CMD"]))
sys.exit(0 if hits else 1)
'
recognised() { CMDSCAN="$REPO_ROOT/.claude/hooks/lib/cmdscan.py" CMD="$1" python3 -I -c "$RECOGNISE_PY"; }
not_recognised() { ! recognised "$1"; }

# the command string is the argument after `-- h` in an assert_* call
_cmd_of() {
  local seen=0 a
  for a in "$@"; do
    if [ "$seen" = 2 ]; then printf '%s' "$a"; return; fi
    if [ "$seen" = 1 ] && [ "$a" = "h" ]; then seen=2; continue; fi
    [ "$a" = "--" ] && seen=1
  done
}

assert_launch_green() {
  assert_green "$@"
  local c; c="$(_cmd_of "$@")"
  assert_green "  ...и распознан как запуск (не просто «разрешён»): ${c:0:80}" -- recognised "$c"
}
assert_not_a_launch() {
  local desc="$1"; shift
  assert_green "$desc" "$@"
  local c; c="$(_cmd_of "$@")"
  assert_green "  ...и НЕ распознан как запуск: ${c:0:80}" -- not_recognised "$c"
}

echo "== test-pre-bash-live-db-guard.sh =="
echo

# ── green: naming a launcher is not launching it ──────────────────────────────
assert_not_a_launch "READ: git show | grep -n vite (сообщённое ложное срабатывание)" \
  -- h "git show HEAD:pnpm-lock.yaml | grep -n vite"

assert_not_a_launch "READ: ls -la node_modules/.bin/vite" \
  -- h "ls -la node_modules/.bin/vite"

assert_not_a_launch "READ: grep -rn 'pnpm dev' по правилам" \
  -- h "grep -rn 'pnpm dev' .claude/rules"

assert_not_a_launch "READ: node -e печатает строку, содержащую dist/main.js" \
  -- h "node -e \"console.log('apps/api/dist/main.js')\""

assert_not_a_launch "READ: echo цитирует команду запуска" \
  -- h "echo 'потом запусти: pnpm --filter @crm/api dev'"

assert_green "НЕ dev-сервер: vitest run (самозавершается)" \
  -- h "vitest run apps/api"

assert_green "НЕ dev-сервер: pnpm --filter @crm/web build" \
  -- h "pnpm --filter @crm/web build"

# NB: cwd is the scratch dir, not $REPO_ROOT — when these tests run from inside
# an agent worktree, $REPO_ROOT itself matches the worktree context and the case
# would pass or fail depending on where the suite was started from.
assert_green "вне worktree/scratchpad — сессия владельца не гейтится" \
  -- h "pnpm --filter @crm/api dev" "$WS"

assert_launch_green "явно безопасные значения: crm_qa + свободный порт" \
  -- h "DATABASE_URL=$SAFE_DB API_PORT=3011 pnpm --filter @crm/api dev"

# An empty DATABASE_URL is only safe with PGDATABASE pinned on the same launch:
# otherwise libpq takes the database from a service file or the USER NAME, and
# PGUSER=crm_db is the live database (measured). See the red half below.
assert_launch_green "явно пустая DATABASE_URL + PGDATABASE=crm_qa + --port 3010" \
  -- h "DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"

# ── red: every shape the #485 boot could have arrived in ──────────────────────
assert_red "голый запуск: ни DATABASE_URL, ни порта" \
  --contains '"decision": "block"' \
  --contains 'API_PORT=3011 scripts/devops/dev-ttl.sh -- pnpm --filter @crm/api dev' \
  --contains "[pre:bash:live-db-guard] BLOCK" \
  -- h "pnpm --filter @crm/api dev"

assert_red "префикс переменных окружения указывает на ЖИВУЮ crm_db" \
  --contains "crm_db" \
  -- h "DATABASE_URL=$LIVE_DB API_PORT=3011 pnpm --filter @crm/api dev"

# pg percent-decodes the database name before connecting, so each of these IS
# crm_db. The hook used to compare the still-encoded text (PR #579 closed the
# same hole in seed-db-guard.ts / integration-db-guard.ts). The base is the
# SAFE_DB prefix so only the name differs; the safe port keeps the port reason
# out of the way, which makes --contains "crm_db" prove the NAME reason fired.
LIVE_BASE="postgresql://crm_user:password@localhost:5432"
for enc in 'crm%5Fdb' 'crm%5fdb' '%63rm_db' 'cr%6d_db' 'crm_%64b' '%63%72%6d%5f%64%62' \
           'crm%5Fdb?sslmode=disable' '%20crm_db' 'crm_db%20' '%20crm%5Fdb%20'; do
  assert_red "закодированное имя живой базы: $enc" \
    --contains '"decision": "block"' \
    --contains "crm_db (" \
    -- h "DATABASE_URL=$LIVE_BASE/$enc API_PORT=3011 pnpm --filter @crm/api dev"
done

# Literal (not %20) leading and trailing whitespace inside the quoted value.
assert_red "пробелы вокруг имени живой базы (литеральные, в кавычках)" \
  --contains "crm_db (" \
  -- h "DATABASE_URL=\"$LIVE_BASE/  crm_db  \" API_PORT=3011 pnpm --filter @crm/api dev"

# FAIL CLOSED: a name the hook cannot determine is not a safe one. The old code
# had no such branch — an unparseable value simply failed to equal crm_db.
for bad in "$LIVE_BASE" "$LIVE_BASE/" "$LIVE_BASE/%20" "postgresql://crm_user@localhost:5432?sslmode=disable"; do
  assert_red "имя базы не определить → отказ, не пропуск: $bad" \
    --contains '"decision": "block"' \
    --contains "cannot determine the database name" \
    -- h "DATABASE_URL='$bad' API_PORT=3011 pnpm --filter @crm/api dev"
done

# SCHEME: only postgres/postgresql. Anything else cannot be shown to reach a
# database the hook can name (and `not-a-url` / `host:port` have no scheme at all).
for bad in 'not-a-url' 'localhost:5432' "mysql://crm_user@localhost/crm_qa" "http://localhost/crm_qa" \
           "file:///crm_qa"; do
  assert_red "схема не postgres/postgresql → отказ: $bad" \
    --contains '"decision": "block"' \
    --contains "is not postgres/postgresql" \
    -- h "DATABASE_URL='$bad' API_PORT=3011 pnpm --filter @crm/api dev"
done

# DOT SEGMENTS and every path that is not a plain name: allowlist of shape, so
# the attacker's encodings do not have to be enumerated. `/./crm_db` etc. decode
# to something with "." or "/" in it.
for enc in './crm_db' '%2e/crm_db' '%2E%2E/crm_db' '../crm_db' 'scratch/../crm_db' 'x/crm_db' \
           'crm_db/' 'crm_db/.' 'crm%2Fdb' 'crm_db%00' 'crm_db;' 'crm-qa'; do
  assert_red "путь — не простое имя → отказ: $enc" \
    --contains '"decision": "block"' \
    --contains "is not a plain" \
    -- h "DATABASE_URL='$LIVE_BASE/$enc' API_PORT=3011 pnpm --filter @crm/api dev"
done

# An unescaped "/" in the password moves the URL parser's idea of the path.
assert_red "незакодированный / в пароле: имя сдвигается, всё равно отказ" \
  --contains '"decision": "block"' \
  -- h "DATABASE_URL='postgresql://u:p/ss@localhost:5432/crm_db' API_PORT=3011 pnpm --filter @crm/api dev"

# QUERY STRING: libpq honours dbname=, so the path says scratch while the
# connection lands in crm_db. Keys are decoded and case-folded.
for q in 'dbname=crm_db' 'dbname=crm%5Fdb' 'DBNAME=crm_db' 'dbn%61me=crm_db' 'db=crm_db' 'database=crm_db' \
         'sslmode=disable&dbname=crm_db' 'dbname=%20crm_db%20' 'dbname=a/../crm_db'; do
  assert_red "query выбирает живую базу при безобидном пути: $q" \
    --contains '"decision": "block"' \
    -- h "DATABASE_URL='$LIVE_BASE/crm_qa?$q' API_PORT=3011 pnpm --filter @crm/api dev"
done
# FRAGMENT (SR-H-1). urlsplit cuts at "#" and sees an empty query; libpq ends the
# path only at "?" and still applies a "?dbname=" after the fragment, so
# `postgres://h/scratch#?dbname=crm_db` is crm_db there (measured: PQconnectStart +
# PQdb, libpq 15). Any "#" is refused. The first three are the named regression
# cases; the rest pin that the refusal does not depend on what follows it.
for frag in '#?dbname=crm_db' '#?dbname=crm%5Fdb' '#?DBNAME=crm_db' '#' '#frag' '#frag?sslmode=disable'; do
  assert_red "# в URL → отказ (libpq читает дальше фрагмента): crm_qa$frag" \
    --contains '"decision": "block"' \
    --contains "contains a # fragment" \
    -- h "DATABASE_URL='$LIVE_BASE/crm_qa$frag' API_PORT=3011 pnpm --filter @crm/api dev"
done
assert_red "сообщение про # называет %23" \
  --contains "%23" \
  -- h "DATABASE_URL='$LIVE_BASE/crm_qa#x' API_PORT=3011 pnpm --filter @crm/api dev"
assert_red "# перед путём, после хоста" \
  --contains "contains a # fragment" \
  -- h "DATABASE_URL='postgres://crm_user@localhost:5432#/crm_db' API_PORT=3011 pnpm --filter @crm/api dev"
assert_red "query dbname без имени" \
  --contains "cannot determine the database name" \
  -- h "DATABASE_URL='$LIVE_BASE/crm_qa?dbname=' API_PORT=3011 pnpm --filter @crm/api dev"

# ENVIRONMENT door: PGDATABASE is what libpq/pg use when the URL names none, and
# `DATABASE_URL=` (explicit empty) is an idiom this hook allows.
assert_red "DATABASE_URL= + PGDATABASE=crm_db" \
  --contains "PGDATABASE names the live database" \
  -- h "DATABASE_URL= PGDATABASE=crm_db API_PORT=3011 vite --port 3010"
assert_red "безопасный URL + PGDATABASE=crm_db" \
  --contains "PGDATABASE names the live database" \
  -- h "DATABASE_URL=$SAFE_DB PGDATABASE=crm_db API_PORT=3011 pnpm --filter @crm/api dev"
assert_red "PGDATABASE с пробелами вокруг crm_db" \
  --contains "PGDATABASE names the live database" \
  -- h "DATABASE_URL= PGDATABASE=' crm_db ' vite --port 3010"
assert_red "PGDATABASE=crm%5Fdb (не простое имя)" \
  --contains "is not a plain" \
  -- h "DATABASE_URL= PGDATABASE=crm%5Fdb vite --port 3010"
assert_red "PGDATABASE из пробелов" \
  --contains "cannot determine the database name from PGDATABASE" \
  -- h "DATABASE_URL= PGDATABASE=' ' vite --port 3010"

# STRICT RULE (libpq's fallback chain). With DATABASE_URL empty, libpq takes the
# database from PGDATABASE, then a service file, then the USER NAME — PGUSER=crm_db
# is the live database (measured in libpq 15 and node-pg). So the launch must pin a
# non-empty allowlisted PGDATABASE as its OWN prefix; that single requirement also
# defeats an inherited PGUSER and every earlier export/load, none of which is
# enumerated. The cost — `DATABASE_URL= vite` alone is refused — is deliberate.
assert_red "пустой URL без PGDATABASE: libpq упадёт на имя пользователя" \
  --contains "PGDATABASE is not pinned inline" \
  --contains 'Corrected launches - copy one: `DATABASE_URL= PGDATABASE=crm_qa vite --port 3010` (web) or' \
  --contains 'or `DATABASE_URL= PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev` (api)' \
  -- h "DATABASE_URL= vite --port 3010"
assert_red "PGUSER=crm_db + пустой URL (имя пользователя = имя базы)" \
  --contains "PGDATABASE is not pinned inline" \
  -- h "DATABASE_URL= PGUSER=crm_db vite --port 3010"
assert_red "PGUSER=crm_db + пустой PGDATABASE (пустой — это и есть фолбэк на пользователя)" \
  --contains "cannot determine the database name from PGDATABASE" \
  -- h "DATABASE_URL= PGUSER=crm_db PGDATABASE= vite --port 3010"
assert_red "голый PGDATABASE= больше не способ «сбросить» значение" \
  --contains "cannot determine the database name from PGDATABASE" \
  -- h "DATABASE_URL= PGDATABASE= vite --port 3010"

# PGSERVICE / PGSERVICEFILE beat PGDATABASE in libpq (measured), so they are
# refused even with PGDATABASE pinned, and with a non-empty URL too.
for svc in 'PGSERVICE=live' 'PGSERVICEFILE=/tmp/x/pg_service.conf' 'PGSERVICE=live PGSERVICEFILE=/tmp/x'; do
  assert_red "PGSERVICE*: $svc (PGDATABASE закреплён)" \
    --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
    -- h "DATABASE_URL= PGDATABASE=crm_qa $svc vite --port 3010"
  assert_red "PGSERVICE*: $svc (URL непустой)" \
    --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
    -- h "DATABASE_URL=$SAFE_DB $svc API_PORT=3011 pnpm --filter @crm/api dev"
done
assert_red "export PGSERVICE=... ранее в команде" \
  --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
  -- h "export PGSERVICE=live; DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"

# SRP-M-4: detection comes from the helper the file already has (assignments(): NAME=,
# printf -v, read, ${NAME:=}) and the cmdscan env, not from a pattern of its own. An
# earlier anchored regex had gaps for exactly these forms; each is a case now. A
# command that merely MENTIONS the assignment is refused too - fail closed, on purpose.
for pre in 'declare -x PGSERVICE=live;' 'declare PGSERVICE=live;' 'typeset -x PGSERVICE=live;' \
           'local PGSERVICE=live;' 'readonly PGSERVICE=live;' 'export -- PGSERVICE=live;' \
           'export PGSERVICEFILE=/tmp/x;' 'printf -v PGSERVICE %s live;' 'read -r PGSERVICE;' \
           ': ${PGSERVICE:=live};' 'A="x y" PGSERVICE=live' 'env PGSERVICE=live'; do
  assert_red "PGSERVICE: $pre" \
    --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
    -- h "$pre DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
done
assert_red "PGSERVICE=... как аргумент запуска: fail closed (упоминание тоже отказ)" \
  --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
  -- h "DATABASE_URL= PGDATABASE=crm_qa vite --port 3010 --note PGSERVICE=live"
assert_red "echo с PGSERVICE=... перед запуском: fail closed" \
  --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
  -- h "echo PGSERVICE=live; DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"

# SR-M-1: everything that sets PGDATABASE somewhere other than the launch prefix.
# cmdscan reads an exported value; a later bare assignment, a sourced file or
# printf -v / read / ${V:=} is what the process actually gets. The strict rule
# refuses all of them because only a literal prefix on the launch counts.
for pre in 'export PGDATABASE=qa; PGDATABASE=crm_db;' 'declare -x PGDATABASE=qa; PGDATABASE=crm_db;' \
           'typeset -x PGDATABASE=qa; PGDATABASE=crm_db;' 'set -a; PGDATABASE=crm_db;' 'PGDATABASE=crm_db;' \
           'export PGDATABASE=crm_qa;' 'printf -v PGDATABASE %s crm_db;' 'read -r PGDATABASE;' \
           ': ${PGDATABASE:=crm_db};' ': ${PGDATABASE=crm_db};'; do
  assert_red "PGDATABASE не префикс запуска: $pre" \
    --contains '"decision": "block"' \
    --contains "PGDATABASE" \
    -- h "$pre DATABASE_URL= vite --port 3010"
done
assert_red "экспортированный (не инлайн) PGDATABASE: причина — «только через export/загрузку»" \
  --contains "reaches the launch only through an earlier export" \
  --contains 'or `DATABASE_URL= PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev` (api)' \
  -- h "export PGDATABASE=crm_qa; DATABASE_URL= vite --port 3010"

# SR-M-1 / ENV_LOAD: DATABASE_URL has the same gap. An export earlier in the command
# is accepted ONLY while nothing can change it afterwards.
for pre in 'export DATABASE_URL=postgresql://u@h/crm_qa; DATABASE_URL=postgresql://u@h/crm_db; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; DATABASE_URL=postgresql://u@h/crm_db; export API_PORT=3011;' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; printf -v DATABASE_URL %s postgresql://u@h/crm_db; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; read -r DATABASE_URL; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; : ${DATABASE_URL:=x}; DATABASE_URL=postgresql://u@h/crm_db; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; : ${DATABASE_URL:=x}; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; : ${DATABASE_URL=x}; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; set -a; source .env; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; . ./env.sh; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; eval "$(cat .env)"; API_PORT=3011'; do
  assert_red "DATABASE_URL не префикс запуска, а ниже его можно изменить: $pre" \
    --contains "DATABASE_URL is not set inline on the launch itself" \
    -- h "$pre pnpm --filter @crm/api dev"
done
# cmdscan does not record `declare -x`, so this one is already refused by the older
# "not set inline" reason; pinned as a block, not by which reason fires.
assert_red "DATABASE_URL: declare -x + bare-присвоение" \
  --contains '"decision": "block"' \
  -- h "declare -x DATABASE_URL=postgresql://u@h/crm_qa; DATABASE_URL=postgresql://u@h/crm_db; API_PORT=3011 pnpm --filter @crm/api dev"

# SR-H-6 — DECOYS. The pin must be among the LEADING assignment words of the launch. An
# argument that merely looks like an assignment (`--x PGDATABASE=crm_qa`) is not a pin,
# and used to switch the whole rule off. Every revert count quoted for the three groups
# above measured the tests, not the rule, because none of them carried a decoy: each
# group below repeats its cases WITH one, which is what makes reverting the rule turn
# them red for the right reason.
for pre in 'export PGDATABASE=qa; PGDATABASE=crm_db;' 'declare -x PGDATABASE=qa; PGDATABASE=crm_db;' \
           'typeset -x PGDATABASE=qa; PGDATABASE=crm_db;' 'set -a; PGDATABASE=crm_db;' \
           'export PGDATABASE=crm_qa;' 'export PGDATABASE=crm_qa; PGDATABASE=crm_db;'; do
  assert_red "ДЕКОЙ PGDATABASE (аргумент, не префикс): $pre" \
    --contains '"decision": "block"' \
    --contains "PGDATABASE" \
    -- h "$pre DATABASE_URL= vite --port 3010 --x PGDATABASE=crm_qa"
done
for pre in 'export DATABASE_URL=postgresql://u@h/crm_qa; DATABASE_URL=postgresql://u@h/crm_db; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; printf -v DATABASE_URL %s postgresql://u@h/crm_db; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; set -a; source .env; API_PORT=3011' \
           'export DATABASE_URL=postgresql://u@h/crm_qa; eval "$(cat .env)"; API_PORT=3011'; do
  assert_red "ДЕКОЙ DATABASE_URL (аргумент, не префикс): $pre" \
    --contains "DATABASE_URL is not set inline on the launch itself" \
    -- h "$pre pnpm --filter @crm/api dev --x DATABASE_URL=postgresql://u@h/crm_qa"
done
# The env-load group: PGDATABASE exported earlier, a file loaded, and the decoy at the end.
for load in 'set -a; source .env.local;' 'source .env;' 'eval "$(cat .env)";' 'set -o allexport;'; do
  assert_red "ДЕКОЙ env-файл + export PGDATABASE: $load" \
    --contains "reaches the launch only through an earlier export" \
    -- h "export PGDATABASE=crm_qa; $load DATABASE_URL= vite --port 3010 --x PGDATABASE=crm_qa"
done

# SR-H-5 — the shell expands the value AFTER the hook read it. `export U="h/crm_db?"`
# then `DATABASE_URL=postgres://$U/qa` is `postgres://h/crm_db?/qa`, which
# pg-connection-string resolves to crm_db. Any `$` or backtick in the value is refused.
for val in 'postgres://$U/qa' 'postgres://${U}/qa' 'postgres://h/$(echo crm_db)' 'postgres://h/`echo crm_db`' \
           'postgres://h/crm_$X' 'postgres://h/qa?dbname=$D'; do
  assert_red "оболочка раскроет значение после проверки: $val" \
    --contains "contains shell expansion" \
    -- h "DATABASE_URL='$val' API_PORT=3011 pnpm --filter @crm/api dev"
done
assert_red "SR-H-5 буквальный сценарий из ревью" \
  --contains "contains shell expansion" \
  -- h 'export U="h/crm_db?"; DATABASE_URL=postgres://$U/qa vite --port 3010'

# SR-M-7 — `env -i`, `env -u`, `env --unset` undo the pin AFTER the hook read it:
# `DATABASE_URL= PGDATABASE=crm_qa PGUSER=crm_db env -u PGDATABASE vite` reaches crm_db
# through the user-name fallback. Refused for every launch, with or without a pin.
for envform in 'env -u PGDATABASE' 'env -i' 'env --unset=PGDATABASE' 'env --unset PGDATABASE' \
               'env --ignore-environment' 'env -iu PGDATABASE' 'env -S "vite --port 3010"' \
               'env -C /tmp' 'env -v -u PGDATABASE' 'env -0u PGDATABASE' 'env -vi' 'env -' \
               '/usr/bin/env -u PGDATABASE' '"env" -u PGDATABASE' \
               "'env' -u PGDATABASE" 'env --unse=PGDATABASE' 'env --ignore-env' 'env --chdir=/tmp' \
               'env --split-string=x' 'env -u PGDATABASE -u PGUSER'; do
  assert_red "env стирает закреплённое значение: $envform" \
    --contains "is followed by the option" \
    -- h "DATABASE_URL= PGDATABASE=crm_qa PGUSER=crm_db $envform vite --port 3010"
done
assert_red "env -u DATABASE_URL при непустом безопасном URL" \
  --contains "is followed by the option" \
  -- h "DATABASE_URL=$SAFE_DB API_PORT=3011 env -u DATABASE_URL pnpm --filter @crm/api dev"

# SR-H-8 — bash computes the command word, shlex does not. Each of these runs
# `env -u PGDATABASE` in real bash (measured by the review), so the child has no
# PGDATABASE, an empty DATABASE_URL and PGUSER=crm_db. The closed answer: the command
# word must be a plain literal AND the launcher the analyzer resolved, so no spelling
# of env needs to be recognised.
for cw in '$E' '$HOME/bin/vite' '{env,-u,PGDATABASE}' '/usr/bin/en?' '"$(which env)"' '`which env`' \
          'e*v' '~/bin/vite' '\env'; do
  assert_red "командное слово — не простой литерал: $cw" \
    --contains '"decision": "block"' \
    -- h "E=env; DATABASE_URL= PGDATABASE=crm_qa PGUSER=crm_db $cw -u PGDATABASE vite --port 3010"
done
assert_red "то же для DATABASE_URL: \$E -u DATABASE_URL" \
  --contains '"decision": "block"' \
  -- h "E=env; DATABASE_URL=$SAFE_DB API_PORT=3011 \$E -u DATABASE_URL pnpm --filter @crm/api dev"
# SR-M-12 — wrappers the hook does not model, and that rewrite the environment or privilege.
for wrap in 'exec -c' 'sudo' 'command' 'npx' 'nice' 'time' 'nohup' 'command env -u PGDATABASE'; do
  assert_red "обёртка, которую хук не моделирует: $wrap" \
    --contains "wrapper the hook does not model" \
    -- h "DATABASE_URL= PGDATABASE=crm_qa PGUSER=crm_db $wrap vite --port 3010"
done

# The launcher-equality half of the rule: tools that cmdscan resolves THROUGH to the
# launcher without recording a wrapper. dotenv / dotenvx / doppler / env-cmd /
# cross-env load or rewrite an environment (a .env may carry PGDATABASE=crm_db), and
# nothing else refused them: the written word is plain and no wrapper is recorded.
for tool in 'dotenv --' 'dotenvx run --' 'doppler run --' 'env-cmd' 'cross-env A=1' 'yarn' 'ssh host'; do
  assert_red "инструмент, через который анализатор «видит» запуск: $tool" \
    --contains "not the launcher the analyzer resolved" \
    -- h "DATABASE_URL= PGDATABASE=crm_qa $tool vite --port 3010"
done

# SR-H-9 — env options take operands. `env -P /usr/bin -u PGDATABASE` slipped past a
# walk that stopped at the first non-dash word, and the pin could be FORGED:
# `env -P PGDATABASE=crm_qa vite` makes real env swallow the assignment as the -P
# operand, while the walk counted it as a pin. Any dash-led word after env is refused.
assert_red "env -P /usr/bin -u PGDATABASE" \
  --contains "is followed by the option" \
  -- h "DATABASE_URL= PGDATABASE=crm_qa PGUSER=crm_db env -P /usr/bin -u PGDATABASE vite --port 3010"
assert_red "ПОДДЕЛЬНЫЙ пин: env -P проглатывает PGDATABASE=crm_qa как операнд" \
  --contains "is followed by the option" \
  -- h "DATABASE_URL= PGUSER=crm_db env -P PGDATABASE=crm_qa /abs/node_modules/.bin/vite --port 3010"
assert_red "поддельный пин: env -u X PGDATABASE=crm_qa" \
  --contains "is followed by the option" \
  -- h "DATABASE_URL= PGUSER=crm_db env -u X PGDATABASE=crm_qa vite --port 3010"

# SR-M-10 — EVERY env word is checked, not only the first. A second env after plain
# assignments, or env env, with the option on the later one.
for form in 'env A=1 env -u PGDATABASE' 'env env -u PGDATABASE' 'env A=1 env -i' \
            'env A=1 B=2 env --unset=PGDATABASE' 'env -- env -u PGDATABASE'; do
  assert_red "второй env с опцией: $form" \
    --contains "is followed by the option" \
    -- h "DATABASE_URL= PGDATABASE=crm_qa PGUSER=crm_db $form vite --port 3010"
done

# SR-M-11 — assignments() ran over raw text, so a spliced name hid from it. The
# regexes now run over the shlex-normalized command.
assert_red "PGSERV''ICE=svc через declare -x (склейка имени пустыми кавычками)" \
  --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
  -- h "declare -x PGSERV''ICE=svc; DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_red "PGSERVICEFIL\"\"E=/tmp/x" \
  --contains "PGSERVICE / PGSERVICEFILE is set or mentioned" \
  -- h "export PGSERVICEFIL\"\"E=/tmp/x; DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_red "s''ource .env скрывает загрузку env-файла от ENV_LOAD" \
  --contains "DATABASE_URL is not set inline on the launch itself" \
  -- h "export DATABASE_URL=postgresql://u@h/crm_qa; s''ource .env; API_PORT=3011 pnpm --filter @crm/api dev"

NL=$'\n'
P_API="DATABASE_URL=$SAFE_DB PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev"
P_WEB="DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
LIVE_API="DATABASE_URL=$LIVE_DB API_PORT=3012 pnpm --filter @crm/api dev"
BARE_API="pnpm --filter @crm/api dev"

# ═══ SR-H-13 - EVERY launch in the command is judged, not only the first ═══════
# `... crm_qa ... pnpm dev & ... crm_db ... pnpm dev` was allowed because only hits[0]
# was looked at; the same with ;  &&  ||  | and a newline, and with a safe vite first.
for sep in ' & ' '; ' ' && ' ' || ' ' | ' "$NL"; do
  assert_red "второй запуск живой (crm_db) после безопасного, разделитель [${sep//$NL/NL}]" \
    --contains "launch 2" --contains "crm_db" \
    -- h "$P_API$sep$LIVE_API"
  assert_red "первый живой, второй безопасный [${sep//$NL/NL}]" \
    --contains "launch 1" --contains "crm_db" \
    -- h "$LIVE_API$sep$P_API"
  assert_red "безопасный web, затем голый api [${sep//$NL/NL}]" \
    --contains "launch 2" \
    -- h "$P_WEB$sep$BARE_API"
done
assert_red "три запуска, средний живой" \
  --contains "launch 2" \
  -- h "$P_API & $LIVE_API & $P_WEB"
assert_red "три запуска, последний без закрепления" \
  --contains "launch 3" \
  -- h "$P_API & $P_WEB & $BARE_API"
assert_launch_green "два полностью закреплённых запуска (api + web) — обоих судят и оба проходят" \
  -- h "$P_API & $P_WEB"

# ═══ SR-H-14 - package scripts that boot a server ARE launches ═════════════════
# `start` is `node dist/main` for the api and `vite preview` for the web app, and ci.yml,
# e2e.yml and sw-smoke.spec.ts all boot the api that way, so an agent mirroring CI used to
# get no pin at all. `-r` was wrongly a value flag (it swallowed `dev`), and run-script was
# treated as exec. Each form: recognised, refused unpinned, accepted pinned.
for form in 'pnpm --filter @crm/api start' 'pnpm -C apps/api start' 'pnpm --dir apps/api start' \
            'npm start' 'npm run start' 'yarn start' 'turbo start' 'turbo run start' \
            'pnpm -r dev' 'pnpm -r start' 'pnpm run-script dev' 'pnpm run-script start' \
            'pnpm run start' 'pnpm --filter @crm/web preview' 'bun run dev'; do
  assert_green "распознан как запуск: $form" -- recognised "$form"
  assert_red "без закрепления — отказ: $form" \
    --contains '"decision": "block"' \
    -- h "$form"
  assert_launch_green "с закреплением и портом — разрешён и распознан: $form" \
    -- h "DATABASE_URL=$SAFE_DB PGDATABASE=crm_qa API_PORT=3011 $form"
done
for nl in 'pnpm test' 'pnpm install' 'pnpm add start-foo' 'pnpm --filter @crm/api test' \
          'pnpm build' 'pnpm typecheck' 'npm run build' 'pnpm --filter @crm/e2e test'; do
  assert_not_a_launch "не запуск (и не должен им стать): $nl" -- h "$nl"
done

# ═══ SR-H-15 - our own wrapper run THROUGH an interpreter ═════════════════════
# `bash scripts/devops/dev-ttl.sh -- <launch>` was allowed with NO pin while the same
# command without `bash` was refused: the 2026-08-05 shape through a side door.
for w in 'bash scripts/devops/dev-ttl.sh -- pnpm --filter @crm/api dev' \
         'sh scripts/devops/dev-ttl.sh --ttl 60 -- vite --port 3010' \
         'bash -x scripts/devops/dev-ttl.sh -- pnpm --filter @crm/api dev' \
         'zsh scripts/devops/dev-ttl.sh -- pnpm -r dev' \
         'dash scripts/devops/dev-ttl.sh -- pnpm --filter @crm/api start'; do
  assert_green "распознан как запуск: $w" -- recognised "$w"
  assert_red "интерпретатор + dev-ttl.sh без закрепления — отказ: $w" \
    --contains '"decision": "block"' \
    -- h "$w"
  assert_red "...и с закреплением: интерпретатор — обёртка, которую хук не моделирует: $w" \
    --contains "wrapper the hook does not model" \
    -- h "DATABASE_URL=$SAFE_DB PGDATABASE=crm_qa API_PORT=3011 $w"
done

# ═══ SR-M-18 - a comment is not a command ═════════════════════════════════════
# A line that begins with # was a segment whose command word was `#`, and the words after
# it were judged as a launch: a full refusal for a comment.
assert_not_a_launch "строка-комментарий с запуском внутри" -- h '# pnpm --filter @crm/api dev'
assert_not_a_launch "комментарий после команды" -- h 'ls -la # then run vite --port 3000'
assert_not_a_launch "комментарий на второй строке" -- h "ls${NL}# pnpm --filter @crm/api dev"
assert_launch_green "комментарий после ЗАКРЕПЛЁННОГО запуска упоминает crm_db и 3001" \
  -- h "$P_API # not crm_db, not :3001"
assert_launch_green "# внутри слова — не комментарий" \
  -- h "$P_API --note a#b"
assert_red "комментарий не прячет следующую строку" \
  --contains '"decision": "block"' \
  -- h "# harmless${NL}$BARE_API"
assert_red "комментарий после ; не прячет следующий запуск" \
  --contains '"decision": "block"' \
  -- h "ls; # note${NL}$BARE_API"

# ═══ SHARED LIBRARY: the comment stripper in lib/cmdscan.py ════════════════════
# Three hooks consume it (devserver-ttl-gate, safety and THIS one; each has its own case in
# its own suite). The stripper read the previous character to decide a "#" starts a comment,
# and an ESCAPED space leaves a space there without ending the word: `echo a\ # && <launch>`
# had the launch dropped as a comment. bash: "#" begins a comment only at a word start; an
# escaped space does not end a word. (This file exercises pre:bash:live-db-guard.)
assert_red "live-db: запуск спрятан после экранированного пробела и #: echo a\\ # && ..." \
  --contains '"decision": "block"' \
  -- h "echo a\\ # && $BARE_API"
assert_red "live-db: то же с ;" \
  --contains '"decision": "block"' \
  -- h "echo a\\ # ; $BARE_API"
assert_red "live-db: кавычка, затем экранированный пробел" \
  --contains '"decision": "block"' \
  -- h "echo 'x'\\ # && $BARE_API"
assert_red "live-db: экранированный перевод строки не заканчивает слово" \
  --contains '"decision": "block"' \
  -- h "echo a\\${NL}# && $BARE_API"
assert_red "live-db: три обратных слеша — пробел остаётся экранированным" \
  --contains '"decision": "block"' \
  -- h "echo \\\\\\ # && $BARE_API"
assert_not_a_launch "live-db: два обратных слеша — слэш сам экранирован, пробел разделяет слова, это комментарий" \
  -- h "echo a\\\\ # $BARE_API"

# The fail-closed half: launches() also reads the command WITHOUT comment stripping, so a
# future slip in the stripper can only produce a refusal, never silence. Proven on its own
# by breaking the stripper on purpose (every # becomes a comment, the old bug) and checking
# the launch is still found; genuine comments still must not become launches.
BROKEN_STRIPPER_PY='
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("cmdscan", os.environ["CMDSCAN"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m._starts_word = lambda text, i: True
sys.exit(0 if m.launches(m.scan(os.environ["CMD"])) else 1)
'
with_broken_stripper() { CMDSCAN="$REPO_ROOT/.claude/hooks/lib/cmdscan.py" CMD="$1" python3 -I -c "$BROKEN_STRIPPER_PY"; }
without_broken_stripper() { ! with_broken_stripper "$1"; }
assert_green "union: при СЛОМАННОМ стриппере запуск после экранированного пробела всё равно найден" \
  -- with_broken_stripper "echo a\\ # && pnpm --filter @crm/api dev"
assert_green "union: при сломанном стриппере — то же с ;" \
  -- with_broken_stripper "echo a\\ # ; vite --port 3010"
assert_green "union: при сломанном стриппере настоящий комментарий всё ещё не запуск" \
  -- without_broken_stripper "echo hi # pnpm --filter @crm/api dev"
assert_green "union: при сломанном стриппере строка-комментарий не запуск" \
  -- without_broken_stripper "# pnpm --filter @crm/api dev"

# ═══ the two LOW message defects: advice that names the forms ═════════════════
# `pnpm exec nest start --debug` and `pnpm ... exec node --inspect dist/main` were refused
# with "write the launcher directly", which does not say what to write.
for form in 'pnpm exec nest start --debug' 'pnpm --filter @crm/api exec node --inspect dist/main'; do
  assert_red "отказ называет рабочие формы: $form" \
    --contains 'node --inspect apps/api/dist/main' \
    --contains 'NODE_OPTIONS=--inspect pnpm' \
    -- h "DATABASE_URL=$SAFE_DB PGDATABASE=crm_qa API_PORT=3011 $form"
done
assert_launch_green "названная форма 1 действительно принимается: node --inspect" \
  -- h "DATABASE_URL=$SAFE_DB PGDATABASE=crm_qa API_PORT=3011 node --inspect apps/api/dist/main"
assert_launch_green "названная форма 2 действительно принимается: NODE_OPTIONS=--inspect" \
  -- h "NODE_OPTIONS=--inspect DATABASE_URL=$SAFE_DB PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev"

# TWO VIEWS, REFUSE IF EITHER MATCHES. Normalizing through shlex resolves spliced quotes
# but flattens the command: newlines vanish, so a pattern anchored on the start of a
# statement no longer matches `source .env` on its own line. The raw-text pass catches
# it; the normalized pass catches the spliced form. Removing either one turns a case
# below red.
NL=$'\n'
assert_red "source .env на отдельной строке (нормализация теряет границы строк)" \
  --contains "DATABASE_URL is not set inline on the launch itself" \
  -- h "export DATABASE_URL=$SAFE_DB${NL}source .env${NL}API_PORT=3011 pnpm --filter @crm/api dev"
assert_red ". ./env.sh на отдельной строке" \
  --contains "DATABASE_URL is not set inline on the launch itself" \
  -- h "export DATABASE_URL=$SAFE_DB${NL}. ./env.sh${NL}API_PORT=3011 pnpm --filter @crm/api dev"
assert_red "set -a на отдельной строке, затем source" \
  --contains "DATABASE_URL is not set inline on the launch itself" \
  -- h "export DATABASE_URL=$SAFE_DB${NL}set -a${NL}source .env${NL}API_PORT=3011 pnpm --filter @crm/api dev"

# env-file loaders with an empty URL and no pinned PGDATABASE: refused by the strict rule.
for load in 'set -a; source .env.local;' 'source .env;' '. ./env.sh;' 'eval "$(cat .env)";' 'set -o allexport;'; do
  assert_red "env-файл + пустой DATABASE_URL без PGDATABASE: $load" \
    --contains "PGDATABASE is not pinned inline" \
    -- h "$load DATABASE_URL= vite --port 3010"
done
assert_red "--env-file + пустой DATABASE_URL без PGDATABASE" \
  --contains "PGDATABASE is not pinned inline" \
  -- h "DATABASE_URL= node --env-file=.env apps/api/dist/main.js"


# PINNED GREENS: a guard that refuses legitimate scratch URLs gets switched off,
# which is as bad as one that admits the live database.
for ok in crm_qa crm_db_scratch crm_dbx xcrm_db CRM_DB Crm_Db crm_db1 crm qa1 'crm%5Fqa' '%63rm_qa'; do
  assert_launch_green "разрешённое имя: $ok" \
    -- h "DATABASE_URL='$LIVE_BASE/$ok' API_PORT=3011 pnpm --filter @crm/api dev"
done
assert_launch_green "scheme postgres:// (короткая форма)" \
  -- h "DATABASE_URL='postgres://crm_user:password@localhost:5432/crm_qa' API_PORT=3011 pnpm --filter @crm/api dev"
assert_launch_green "uppercase scheme: urlsplit lowercases it, the name checks still run" \
  -- h "DATABASE_URL='POSTGRESQL://crm_user@localhost:5432/crm_qa' API_PORT=3011 pnpm --filter @crm/api dev"
assert_launch_green "URL без порта и без пароля" \
  -- h "DATABASE_URL='postgresql://crm_user@localhost/crm_qa' API_PORT=3011 pnpm --filter @crm/api dev"
assert_launch_green "посторонние query-параметры" \
  -- h "DATABASE_URL='$LIVE_BASE/crm_qa?sslmode=require&application_name=x&connect_timeout=5' API_PORT=3011 pnpm --filter @crm/api dev"
assert_launch_green "query dbname = безопасное имя" \
  -- h "DATABASE_URL='$LIVE_BASE/crm_qa?dbname=crm_qa' API_PORT=3011 pnpm --filter @crm/api dev"
assert_launch_green "options без crm_db" \
  -- h "DATABASE_URL='$LIVE_BASE/crm_qa?options=-c%20statement_timeout%3D5000' API_PORT=3011 pnpm --filter @crm/api dev"
# The wrapper itself is fine; only the forms that CLEAR or SPLIT the environment are not.
assert_launch_green "обычный env-враппер с закреплёнными значениями" \
  -- h "env DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_red "ЛЮБАЯ опция после env — отказ, даже безобидная -v: операнды опций хук не моделирует" \
  --contains "is followed by the option" \
  -- h "env -v DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "env -- ограничивает опции, дальше только присваивания" \
  -- h "env -- DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_red "env --null — тоже отказ: закрытое определение «простого» запуска, а не список опасных опций" \
  --contains "is followed by the option" \
  -- h "env --null DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "env с присваиванием, значение которого похоже на флаг: FOO=-i" \
  -- h "env FOO=-i DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "dev-ttl.sh-обёртка: закрепление остаётся в ведущих словах" \
  -- h "scripts/devops/dev-ttl.sh --ttl 7200 -- DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "PGDATABASE безопасный + пустой DATABASE_URL" \
  -- h "DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "inline DATABASE_URL побеждает ранний export + загрузку env-файла" \
  -- h "export DATABASE_URL=postgresql://u@h/crm_live; set -a; source .env; DATABASE_URL=$SAFE_DB API_PORT=3011 pnpm --filter @crm/api dev"
assert_launch_green "PGUSER=crm_db, но PGDATABASE закреплён — закреплённое имя главнее пользователя" \
  -- h "DATABASE_URL= PGUSER=crm_db PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "env-файл, но PGDATABASE закреплён инлайн" \
  -- h "set -a; source .env.local; DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "env-файл, но DATABASE_URL непустой и безопасный (URL с путём главнее PGDATABASE)" \
  -- h "set -a; source .env.local; DATABASE_URL=$SAFE_DB API_PORT=3011 pnpm --filter @crm/api dev"
assert_launch_green "export безопасного DATABASE_URL БЕЗ повторного присвоения" \
  -- h "export DATABASE_URL=$SAFE_DB; export API_PORT=3011; pnpm --filter @crm/api dev"
assert_launch_green "точка как аргумент (cd .) — не source" \
  -- h "cd . && DATABASE_URL= PGDATABASE=crm_qa vite --port 3010"
assert_launch_green "имя с crm_db внутри чужого слова в options: crm_db_x" \
  -- h "DATABASE_URL='$LIVE_BASE/crm_qa?options=-c%20app.crm_db_x%3D1' API_PORT=3011 pnpm --filter @crm/api dev"

# The decoding must not turn into a blanket refusal of other databases.
assert_launch_green "закодированное, но НЕ живое имя: crm%5Fqa" \
  -- h "DATABASE_URL=$LIVE_BASE/crm%5Fqa API_PORT=3011 pnpm --filter @crm/api dev"

assert_launch_green "безопасное имя с query: crm_qa?sslmode=disable" \
  -- h "DATABASE_URL=$LIVE_BASE/crm_qa?sslmode=disable API_PORT=3011 pnpm --filter @crm/api dev"

assert_red "safe DB, но живой порт владельца 3001" \
  --contains "3001" \
  -- h "DATABASE_URL=$SAFE_DB API_PORT=3001 pnpm --filter @crm/api dev"

assert_red "внутри &&: cd apps/api && nest start --watch" \
  --contains '"decision": "block"' \
  -- h "cd apps/api && nest start --watch"

assert_red "через sh -c" \
  --contains '"decision": "block"' \
  -- h "sh -c 'pnpm --filter @crm/api dev'"

assert_red "абсолютный путь к бинарнику vite" \
  --contains '"decision": "block"' \
  -- h "$REPO_ROOT/node_modules/.bin/vite --host"

assert_red "собранный API напрямую: node apps/api/dist/main.js" \
  --contains '"decision": "block"' \
  -- h "node apps/api/dist/main.js"

assert_red "обёртки nohup+env поверх запуска в фоне" \
  --contains '"decision": "block"' \
  -- h "nohup env DATABASE_URL=$LIVE_DB pnpm dev &"

assert_red "timeout 600 перед запуском" \
  --contains '"decision": "block"' \
  -- h "timeout 600 pnpm --filter @crm/api dev"

assert_red "TTL-обёртка есть, но окружение не задано" \
  --contains '"decision": "block"' \
  -- h "scripts/devops/dev-ttl.sh --ttl 7200 -- pnpm --filter @crm/api dev"

assert_red "подстановка в позиции команды: \$(echo pnpm) dev" \
  --contains '"decision": "block"' \
  -- h "\$(echo pnpm) dev"

assert_red "кавычки не парсятся — разбор деградирован, но запуск всё равно ловится" \
  --contains '"decision": "block"' \
  -- h "pnpm --filter @crm/api dev \"unbalanced"

# ── попытки обмануть сужение (каждая найдена прогоном, не вычиткой) ───────────
# `eval` реально ускользал: старое подстрочное правило его ловило, первая версия
# сужения — нет. Поэтому кейс живёт здесь, а не в описании PR.
assert_red "ОБХОД: eval 'pnpm dev'" \
  --contains '"decision": "block"' \
  -- h "eval 'pnpm --filter @crm/api dev'"

assert_red "ОБХОД: кавычки внутри имени команды (p''npm)" \
  --contains '"decision": "block"' \
  -- h "p''npm --filter @crm/api dev"

assert_red "ОБХОД: имя команды в кавычках (\"pnpm\" dev)" \
  --contains '"decision": "block"' \
  -- h "\"pnpm\" dev"

assert_red "ОБХОД: экранированное имя (\\pnpm dev)" \
  --contains '"decision": "block"' \
  -- h "\\pnpm dev"

assert_red "ОБХОД: env -i + абсолютный путь к nest" \
  --contains '"decision": "block"' \
  -- h "env -i DATABASE_URL=postgresql://h/crm_db /abs/node_modules/.bin/nest start"

assert_red "ОБХОД: bash -c 'exec pnpm dev'" \
  --contains '"decision": "block"' \
  -- h "bash -c 'exec pnpm dev'"

assert_red "ОБХОД: xargs -I{} pnpm dev" \
  --contains '"decision": "block"' \
  -- h "xargs -I{} pnpm dev"

assert_red "ОБХОД: pnpm -r --filter=@crm/api run dev" \
  --contains '"decision": "block"' \
  -- h "pnpm -r --filter=@crm/api run dev"

# ── находки security-review PR #561 ──────────────────────────────────────────
# Систематическое покрытие — test-hook-command-corpus.sh. Здесь именованные
# находки: в каждой из них разбор НЕ падал, он уверенно отвечал неверно.
assert_red "REVIEW HIGH-1: env -i — заявлен покрытым в теле PR, а проходил" \
  --contains '"decision": "block"' \
  -- h "env -i pnpm dev"

assert_red "REVIEW HIGH-1: sudo -s (-s не берёт значение)" \
  --contains '"decision": "block"' \
  -- h "sudo -s pnpm dev"

assert_red "REVIEW HIGH-2: { pnpm dev ; } — «{» как командное слово" \
  --contains '"decision": "block"' \
  -- h "{ pnpm dev ; }"

assert_red "REVIEW HIGH-3: неизвестная обёртка script" \
  --contains '"decision": "block"' \
  -- h "script -q /dev/null pnpm dev"

assert_red "REVIEW HIGH-3: find -exec" \
  --contains '"decision": "block"' \
  -- h "find . -maxdepth 0 -exec pnpm dev \\;"

# MED-5: префикс на ЧУЖОМ сегменте ничего не даёт запуску — тот унаследует
# живую пару. Это форма инцидента #485, и раньше плоский словарь её отбеливал.
assert_red "REVIEW MED-5: безопасный префикс на соседнем сегменте, а не на запуске" \
  --contains '"decision": "block"' \
  -- h "DATABASE_URL=$SAFE_DB API_PORT=3011 echo ok && pnpm dev"

assert_red "REVIEW MED-5: запуск ДО export — порядок сегментов имеет значение" \
  --contains '"decision": "block"' \
  -- h "pnpm dev ; export DATABASE_URL=$SAFE_DB API_PORT=3011"

assert_red "REVIEW LOW: API_PORT=03001 — для Node это 3001" \
  --contains "3001" \
  -- h "API_PORT=03001 DATABASE_URL=$SAFE_DB pnpm --filter @crm/api dev"

assert_green "export действительно переносится на следующий сегмент" \
  -- h "export DATABASE_URL=$SAFE_DB
export API_PORT=3011
pnpm dev"

# ── найдено уже ПОСЛЕ фикса ──────────────────────────────────────────────────
assert_red "ОБХОД-2: env -S сам разбивает строку и запускает её" \
  --contains '"decision": "block"' \
  -- h "env -S 'pnpm dev'"

# ── crash is not a verdict (AC6) ──────────────────────────────────────────────
BROKEN="$(hook_with_broken_lib "$WS" pre-bash-live-db-guard.sh)"

assert_red "СЛОМАННЫЙ анализатор + опасный запуск: блок, но помечен как ДЕГРАДИРОВАННЫЙ" \
  --contains "INTERNAL ERROR" \
  --contains "ДЕГРАДИРОВАННЫЙ РЕЖИМ" \
  -- hook_at "$BROKEN" "pnpm --filter @crm/api dev"

assert_red "СЛОМАННЫЙ анализатор + безобидное чтение: НЕ вердикт (нет decision-контракта)" \
  --contains "INTERNAL ERROR" \
  --not-contains "decision" \
  -- hook_at "$BROKEN" "grep -rn 'pnpm dev' .claude/rules"

assert_red "ЛОВУШКА: хук со сломанным bash тоже даёт rc≠0 — но без decision-контракта" \
  --contains "syntax error" \
  --not-contains "decision" \
  -- hook_at "$(hook_with_broken_bash "$WS")" "pnpm --filter @crm/api dev"

guard_test_summary "test-pre-bash-live-db-guard.sh"
