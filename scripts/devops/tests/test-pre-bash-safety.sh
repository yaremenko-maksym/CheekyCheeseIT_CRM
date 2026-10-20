#!/usr/bin/env bash
# test-pre-bash-safety.sh — proves .claude/hooks/pre-bash-safety.sh still refuses
# the catastrophic commands, and stops refusing commands that merely QUOTE one.
#
# The green half is the bug report: `echo "... DROP DATABASE crm_db ..."` was
# blocked four separate times on 2026-08-17/18 — once on the command writing a
# PR description, once on the probe command written to demonstrate the problem.
# The red half is the reason the hook exists at all, re-run shape by shape after
# the narrowing: behind `sudo`, behind `&&`, through `sh -c`, with an env prefix,
# via `docker exec`, and inside a heredoc fed to psql (a heredoc body is data
# when `cat` writes a file and a command when `psql` reads it — the consuming
# command is what decides, and both directions are pinned below).
#
# Nothing here executes any of these commands: each is handed to the hook as the
# text of a tool call, which is exactly the input the hook sees in production.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-safety.sh"
DROP="DROP DATABASE crm_db"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# This hook has no context gate — it applies everywhere, so the cwd is irrelevant.
h() { hook_at "$HOOK" "$1" "$WS"; }

echo "== test-pre-bash-safety.sh =="
echo

# ── green: quoting a dangerous phrase is not running it ───────────────────────
assert_green "echo цитирует фразу про удаление живой базы" \
  -- h "echo 'никогда не делай: $DROP'"

assert_green "gh pr create --body с той же фразой (реальный инцидент 2026-08-17)" \
  -- h "gh pr create --title 'guards' --body 'хук блокирует $DROP'"

assert_green "git commit -m с той же фразой" \
  -- h "git commit -m 'fix(hooks): block $DROP only when executed'"

assert_green "heredoc пишет описание PR в файл" \
  -- h "$(printf 'cat > /tmp/pr-body.md <<EOF\n%s в тексте описания\nEOF\n' "$DROP")"

assert_green "grep ищет фразу по репозиторию" \
  -- h "grep -rn '$DROP' .claude/hooks"

assert_green "echo цитирует rm -rf /" \
  -- h "echo 'rm -rf / стерло бы систему'"

assert_green "echo цитирует форс-пуш в main" \
  -- h "echo 'запрещено: git push --force origin main'"

assert_green "echo цитирует форк-бомбу" \
  -- h "echo ':(){ :|:& };:'"

assert_green "уборка скретча: rm -rf /tmp/**" \
  -- h "rm -rf /tmp/guard-test-abc123"

assert_green "уборка скретча macOS: rm -rf /private/tmp/claude-501/**" \
  -- h "rm -rf /private/tmp/claude-501/session/scratchpad"

assert_green "обычный форс-пуш своей ветки (не main/master)" \
  -- h "git push --force-with-lease origin fix/guards-narrow-to-launch"

assert_green "обычный rm внутри проекта относительным путём" \
  -- h "rm -rf node_modules/.cache"

# ── red: the catastrophic corpus, one shape per line ──────────────────────────
assert_red "psql -c с DROP DATABASE" \
  --contains '"decision": "block"' \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "psql -c '$DROP'"

assert_red "нижний регистр через docker exec" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "docker exec -i crm-postgres psql -U crm_user -c 'drop database crm_db'"

assert_red "через sh -c" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "sh -c \"psql -c '$DROP'\""

assert_red "с префиксом переменных окружения" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "PGPASSWORD=x psql -h localhost -c '$DROP'"

assert_red "внутри && после безобидной первой команды" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "cd /tmp && psql -c '$DROP'"

assert_red "heredoc скармливается psql (тело = SQL, а не текст)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "$(printf 'psql -U crm_user <<EOF\n%s;\nEOF\n' "$DROP")"

assert_red "DROP DATABASE IF EXISTS crm_db" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "psql -c 'DROP DATABASE IF EXISTS crm_db'"

assert_red "dropdb crm_db" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "dropdb -h localhost -U crm_user crm_db"

assert_red "rm -rf /etc" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "rm -rf /etc"

assert_red "sudo rm -rf /usr/local/lib" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "sudo rm -rf /usr/local/lib"

assert_red "rm -rf / (голый корень — старое правило его пропускало)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "rm -rf /"

assert_red "rm -rf ~" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "rm -rf ~"

assert_red "rm -rf \$HOME/Desktop" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "rm -rf \$HOME/Desktop"

assert_red "rm -rf внутри sh -c" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "sh -c 'rm -rf /var/log'"

assert_red "форк-бомба" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h ":(){ :|:& };:"

assert_red "git push --force origin main" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "git push --force origin main"

assert_red "git push -f origin master" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "git push -f origin master"

assert_red "git push --force-with-lease origin refs/heads/main" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "git push --force-with-lease origin refs/heads/main"

assert_red "форс через +refspec (старое правило его пропускало)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "git push origin +main"

# ── попытки обмануть сужение (найдены прогоном, не вычиткой) ──────────────────
# `eval 'rm -rf /etc'` реально проскочил через первую версию сужения, хотя
# старое подстрочное правило его блокировало. Регрессия закрыта, кейс закреплён.
assert_red "ОБХОД: eval 'rm -rf /etc'" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "eval 'rm -rf /etc'"

assert_red "ОБХОД: eval с psql" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "eval \"psql -c '$DROP'\""

assert_red "ОБХОД: имя команды в кавычках ('rm' -rf /etc)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "'rm' -rf /etc"

assert_red "ОБХОД: абсолютный путь /bin/rm" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "/bin/rm -rf /etc"

assert_red "ОБХОД: порядок флагов rm -fr (старое правило его пропускало)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "rm -fr /etc"

assert_red "ОБХОД: длинные флаги rm --recursive --force" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "rm --recursive --force /etc"

assert_red "ОБХОД: лишние пробелы внутри SQL" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "psql -c \"DROP   DATABASE   crm_db\""

assert_red "ОБХОД: имя базы в кавычках внутри SQL" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "psql --command='drop database \"crm_db\"'"

assert_red "ОБХОД: через xargs" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "xargs -I{} psql -c '$DROP'"

# ── находки security-review PR #561 (каждая была воспроизведена ревьюером) ────
# Систематическое покрытие этого класса — в test-hook-command-corpus.sh (один
# корпус, оба направления). Здесь остаются именованные находки: читатель ЭТОГО
# теста должен видеть, на чём хук уже ломался, а не только что он зелёный.
assert_red "REVIEW HIGH-1: sudo -s съедал команду (-s не берёт значение)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "sudo -s rm -rf /etc"

assert_red "REVIEW HIGH-1: env -i — идиома «чистое окружение»" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "env -i rm -rf /etc"

assert_red "REVIEW HIGH-2: группировка { … ; } читалась как команда «{»" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "{ rm -rf /etc ; }"

assert_red "REVIEW HIGH-2: if …; then …; fi читалось как команда «then»" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "if true; then git push --force origin main; fi"

assert_red "REVIEW HIGH-2: подоболочка ( … ) склеивалась в «(git»" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "(git push --force origin main)"

assert_red "REVIEW HIGH-3: find -exec — обёртки нет ни в одном списке" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "find . -maxdepth 0 -exec rm -rf /etc \\;"

assert_red "REVIEW HIGH-3: неизвестная обёртка (script) — ловится разбором, не списком" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "script -q /dev/null rm -rf /etc"

assert_red "REVIEW MED-2: git -c core.pager исполняет — значит git не инертен" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "git -c core.pager='psql -c \"$DROP\"' log -1"

assert_red "REVIEW MED-2: awk system() — тоже не инертен" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "awk 'BEGIN{system(\"psql -c \\\"$DROP\\\"\")}'"

assert_red "REVIEW MED-2: цепочка «записал в файл -> тут же исполнил»" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "echo '$DROP;' > /tmp/x.sql && psql -f /tmp/x.sql"

assert_red "REVIEW MED-3: rm -R (заглавная) — тот же рекурсивный флаг" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "rm -Rf /etc"

assert_red "REVIEW MED-4: git -C <path> push --force (идиома из наших же правил)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "git -C /tmp/some/repo push --force origin main"

# ── найдено уже ПОСЛЕ фикса, попыткой обмануть его самого ────────────────────
assert_red "ОБХОД-2: неразрешимое слово команды с однозначными аргументами" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "\$(echo rm) -rf /etc"

assert_red "ОБХОД-2: --force-with-lease=main (флаг со значением)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "git push --force-with-lease=main origin main"

assert_red "ОБХОД-2: опасное внутри чужого языка (python3 -c)" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "python3 -c \"import os; os.system('rm -rf /etc')\""

assert_red "ОБХОД-2: env -S сам разбивает строку и запускает её" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "env -S 'rm -rf /etc'"

# ── crash is not a verdict (AC6) ──────────────────────────────────────────────
BROKEN="$(hook_with_broken_lib "$WS" pre-bash-safety.sh)"

assert_red "СЛОМАННЫЙ анализатор + опасная команда: блок, помеченный ДЕГРАДИРОВАННЫМ" \
  --contains "INTERNAL ERROR" \
  --contains "ДЕГРАДИРОВАННЫЙ РЕЖИМ" \
  -- hook_at "$BROKEN" "psql -c '$DROP'" "$WS"

assert_red "СЛОМАННЫЙ анализатор + безобидная команда: НЕ вердикт (нет decision-контракта)" \
  --contains "INTERNAL ERROR" \
  --not-contains "decision" \
  -- hook_at "$BROKEN" "ls -la" "$WS"

assert_red "ЛОВУШКА: хук со сломанным bash тоже даёт rc≠0 — но без decision-контракта" \
  --contains "syntax error" \
  --not-contains "decision" \
  -- hook_at "$(hook_with_broken_bash "$WS")" "rm -rf /etc" "$WS"

# ── SHARED LIBRARY: the comment stripper in lib/cmdscan.py ────────────────────
# Three hooks consume that library (devserver-ttl-gate, live-db-guard and THIS one, the
# broadest). The stripper decided a "#" starts a comment by reading the previous character;
# an ESCAPED space leaves a space there without ending the word, so `echo a\ # && <cmd>` had
# everything after the # dropped as a comment - a destructive command included. bash: "#"
# begins a comment only at a word start, and an escaped space does not end a word. Each
# consumer carries its own case. (This file exercises pre:bash:safety.)
assert_red "safety: команда спрятана после экранированного пробела и #: echo a\\ # && psql ..." \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "echo a\\ # && psql -c '$DROP'"

assert_red "safety: то же с ;" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "echo a\\ # ; psql -c '$DROP'"

assert_red "safety: кавычка, затем экранированный пробел" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "echo 'x'\\ # && psql -c '$DROP'"

assert_red "safety: экранированный перевод строки не заканчивает слово" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "echo a\\
# && psql -c '$DROP'"

assert_green "safety: настоящий комментарий с DROP внутри по-прежнему ничего не запускает" \
  -- h "echo hi # psql -c '$DROP'"

# ── SR-H-20: round 5 hid commands from THIS hook, and nothing here caught it ───
# The fail-closed comment-free reading lived inside launches(); this hook walks
# scan.segments directly and never calls it, so two shapes that RUN the second command in
# both bash and zsh were allowed here while blocked before the comment stripper existed
# (measured against 7964505a2): a parameter expansion whose default value holds a space
# then # (bash and zsh both treat that # as plain text), and a process substitution
# immediately followed by # (the # is part of the word). The second reading is now merged
# into scan() itself, so every consumer gets it without opting in.
NL=$'\n'
assert_red "SR-H-20 форма 1: подстановка параметра с пробелом и # в значении по умолчанию" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "echo \${x:- #}; psql -c '$DROP'"

assert_red "SR-H-20 форма 2: подстановка процесса, сразу за которой #" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "cat <(true)# ; psql -c '$DROP'"

assert_red "SR-H-20 форма 1, разделитель &&" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "echo \${x:- #} && psql -c '$DROP'"

assert_red "SR-H-20 форма 2, разделитель новая строка" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "cat <(true)#${NL}psql -c '$DROP'"

# SR-M-22 - the word-boundary rule itself. The comment-free union (above) would mask a
# regression in the stripper, so ask the stripper ALONE: for these cases it must produce
# every segment on its own, i.e. nothing is left for the second reading to add.
ALT_ONLY_PY='
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("cmdscan", os.environ["CMDSCAN"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
sys.exit(0 if not m.scan(os.environ["CMD"]).alt_only else 1)
'
stripper_alone_sees_all() { CMDSCAN="$REPO_ROOT/.claude/hooks/lib/cmdscan.py" CMD="$1" python3 -I -c "$ALT_ONLY_PY"; }
stripper_needed_help() { ! stripper_alone_sees_all "$1"; }
assert_green "SR-M-22: стриппер САМ видит команду после экранированного пробела и #" \
  -- stripper_alone_sees_all "echo a\\ # && psql -c '$DROP'"
assert_green "SR-M-22: то же с ;" \
  -- stripper_alone_sees_all "echo a\\ # ; psql -c '$DROP'"
assert_green "SR-M-22: кавычка, затем экранированный пробел" \
  -- stripper_alone_sees_all "echo 'x'\\ # && psql -c '$DROP'"
assert_green "SR-M-22: форма 1 стриппер сам НЕ видит — её держит второе чтение (и это задокументировано)" \
  -- stripper_needed_help "echo \${x:- #}; psql -c '$DROP'"
assert_green "SR-M-22: форма 2 стриппер сам НЕ видит — её держит второе чтение" \
  -- stripper_needed_help "cat <(true)# ; psql -c '$DROP'"

# ── SR-H-24: an interpreter flag scan must never step over the CODE flag ─────────
# `bash -c '<payload>' dev-ttl.sh`: the payload is the command, dev-ttl.sh is $0. A forward
# scan for the wrapper token (added for SR-M-21, so any interpreter flag may precede it)
# jumped over -c AND its payload, so the string bash actually runs was never scanned - this
# hook allowed a destructive command that it blocked before. A code flag before the token now
# cancels the unwrap and the payload reaches nested-code scanning.
assert_red "SR-H-24: bash -c <деструктив> dev-ttl.sh" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "bash -c \"psql -c '$DROP'\" dev-ttl.sh"

assert_red "SR-H-24: sh -c <rm -rf /etc> x dev-ttl.sh" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "sh -c 'rm -rf /etc' x dev-ttl.sh"

assert_red "SR-H-24: объединённая короткая группа -ec" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "bash -ec \"psql -c '$DROP'\" x dev-ttl.sh"

assert_red "SR-H-24: -o pipefail -c <деструктив> dev-ttl.sh" \
  --contains "[pre:bash:safety] BLOCK" \
  -- h "bash -o pipefail -c \"psql -c '$DROP'\" dev-ttl.sh"

assert_green "SR-H-24: настоящая обёртка (dev-ttl.sh — первый операнд) по-прежнему не трогает safety" \
  -- h "bash -o pipefail scripts/devops/dev-ttl.sh -- ls -la"

guard_test_summary "test-pre-bash-safety.sh"
