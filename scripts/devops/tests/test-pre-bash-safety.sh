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

guard_test_summary "test-pre-bash-safety.sh"
