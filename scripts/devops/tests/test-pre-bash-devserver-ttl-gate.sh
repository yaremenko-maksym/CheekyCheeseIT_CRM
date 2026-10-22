#!/usr/bin/env bash
# test-pre-bash-devserver-ttl-gate.sh — proves .claude/hooks/pre-bash-devserver-ttl-gate.sh
# still demands the TTL wrapper for every real dev-server boot inside an agent
# worktree, and no longer fires on commands that merely name one.
#
# WHY THIS FILE EXISTS AT ALL. This hook was not in the original scope: the
# reported false positive named only pre-bash-live-db-guard. But both hooks
# carried the SAME launcher regex, copy-pasted, so narrowing one left
# `git show <ref>:pnpm-lock.yaml | grep -n vite` still blocked — reproduced on
# 2026-08-18 with the narrowed live-db-guard already in place. "The scoped hook
# now allows it" would have been a true statement and a useless fix.
#
# The wrapper check is per-SEGMENT on purpose: a mention of dev-ttl.sh in one
# segment must not whitelist an unwrapped boot in another. That decoy is the
# last red case below.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-devserver-ttl-gate.sh"
TTL="scripts/devops/dev-ttl.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

h() { hook_at "$HOOK" "$@"; }

echo "== test-pre-bash-devserver-ttl-gate.sh =="
echo

# ── green ─────────────────────────────────────────────────────────────────────
assert_green "READ: git show | grep -n vite (тот же ложный случай, что у соседа)" \
  -- h "git show HEAD:pnpm-lock.yaml | grep -n vite"

assert_green "READ: rg -n 'nest start' по apps/api" \
  -- h "rg -n 'nest start' apps/api"

assert_green "READ: ls node_modules/.bin/vite" \
  -- h "ls -la node_modules/.bin/vite"

assert_green "НЕ dev-сервер: vitest / playwright самозавершаются" \
  -- h "pnpm --filter @crm/e2e test"

assert_green "правильно обёрнутый запуск проходит" \
  -- h "$TTL --ttl 7200 -- pnpm --filter @crm/api dev"

assert_green "обёрнутый запуск с префиксом переменных окружения" \
  -- h "$TTL -- DATABASE_URL=postgresql://h:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev"

assert_green "вне worktree/scratchpad — стек владельца не гейтится" \
  -- h "pnpm --filter @crm/api dev" "$WS"

# ── red ───────────────────────────────────────────────────────────────────────
assert_red "голый pnpm dev в worktree" \
  --contains '"decision": "block"' \
  --contains "[pre:bash:devserver-ttl-gate] BLOCK" \
  -- h "pnpm --filter @crm/api dev"

assert_red "vite после cd" \
  --contains '"decision": "block"' \
  -- h "cd apps/web && vite --port 3010"

assert_red "nest start через sh -c" \
  --contains '"decision": "block"' \
  -- h "sh -c 'cd apps/api && nest start'"

assert_red "собранный API: node apps/api/dist/main.js" \
  --contains '"decision": "block"' \
  -- h "node apps/api/dist/main.js"

assert_red "фоновый nohup" \
  --contains '"decision": "block"' \
  -- h "nohup pnpm --filter @crm/web dev &"

assert_red "ПРИМАНКА: dev-ttl.sh упомянут в другом сегменте, запуск не обёрнут" \
  --contains '"decision": "block"' \
  -- h "echo $TTL && pnpm --filter @crm/api dev"

assert_red "кавычки не парсятся — деградированный разбор всё равно ловит запуск" \
  --contains '"decision": "block"' \
  -- h "pnpm --filter @crm/api dev \"unbalanced"

# ── находки security-review PR #561 ──────────────────────────────────────────
# Систематическое покрытие — test-hook-command-corpus.sh; здесь именованные.
assert_red "REVIEW HIGH-1: env -i pnpm dev" \
  --contains '"decision": "block"' \
  -- h "env -i pnpm dev"

assert_red "REVIEW HIGH-2: ! pnpm dev (отрицание как командное слово)" \
  --contains '"decision": "block"' \
  -- h "! pnpm dev"

assert_red "REVIEW HIGH-2: подоболочка (pnpm dev)" \
  --contains '"decision": "block"' \
  -- h "(pnpm dev)"

assert_red "REVIEW HIGH-2: цикл while … do … done" \
  --contains '"decision": "block"' \
  -- h "while true; do pnpm dev; done"

assert_red "REVIEW HIGH-3: script -q /dev/null pnpm dev" \
  --contains '"decision": "block"' \
  -- h "script -q /dev/null pnpm dev"

assert_red "ОБХОД-2: обёртка внутри обёртки (nohup + script)" \
  --contains '"decision": "block"' \
  -- h "nohup script -q /dev/null pnpm dev &"

# Приманка наоборот: dev-ttl.sh должен ОБЁРТЫВАТЬ запуск, а не просто стоять
# рядом с ним. Здесь он в аргументах самого запуска — TTL не применяется.
assert_red "ПРИМАНКА-2: dev-ttl.sh аргументом запуска, а не обёрткой" \
  --contains '"decision": "block"' \
  -- h "script -q /dev/null pnpm dev -- $TTL"

# Обратная сторона той же проверки: когда обёртка стоит там, где надо, TTL
# действительно применяется — даже если внешняя обёртка разбирается неточно
# (`script` меняет грамматику между BSD и GNU). Хук не должен требовать
# обёртку дважды.
assert_green "неточная внешняя обёртка поверх настоящей TTL-обёртки — TTL применён" \
  -- h "script -q /dev/null $TTL -- pnpm dev"

# ── crash is not a verdict (AC6) ──────────────────────────────────────────────
BROKEN="$(hook_with_broken_lib "$WS" pre-bash-devserver-ttl-gate.sh)"

assert_red "СЛОМАННЫЙ анализатор + необёрнутый запуск: блок, помеченный ДЕГРАДИРОВАННЫМ" \
  --contains "INTERNAL ERROR" \
  --contains "DEGRADED MODE" \
  -- hook_at "$BROKEN" "pnpm --filter @crm/api dev"

assert_red "СЛОМАННЫЙ анализатор + безобидное чтение: НЕ вердикт" \
  --contains "INTERNAL ERROR" \
  --not-contains "decision" \
  -- hook_at "$BROKEN" "grep -rn 'pnpm dev' .claude/rules"

assert_red "ЛОВУШКА: хук со сломанным bash тоже даёт rc≠0 — но без decision-контракта" \
  --contains "syntax error" \
  --not-contains "decision" \
  -- hook_at "$(hook_with_broken_bash "$WS")" "pnpm --filter @crm/api dev"

# ── package scripts that boot a server: start / preview (SR-H-14) ──────────────
# The hot-path prefilter used to look only for vite|nest|dev|dist/main, so a command with
# none of those words never reached the analyzer. These pass the prefilter now.
for form in 'pnpm --filter @crm/api start' 'pnpm -C apps/api start' 'npm start' 'turbo start' \
            'pnpm -r dev' 'pnpm run-script dev' 'pnpm --filter @crm/web preview'; do
  assert_red "ТТЛ-гейт: без обёртки — отказ: $form" \
    --contains '"decision": "block"' \
    -- h "$form"
  assert_green "ТТЛ-гейт: с обёрткой проходит: $form" \
    -- h "$TTL -- $form"
done
assert_red "ТТЛ-гейт: интерпретатор + dev-ttl.sh не отменяет проверку обёртки у соседнего запуска" \
  --contains '"decision": "block"' \
  -- h "bash $TTL -- pnpm --filter @crm/api dev & pnpm --filter @crm/api start"

# ── SHARED LIBRARY: the comment stripper in lib/cmdscan.py ────────────────────
# Three hooks consume that library (this one, live-db-guard, safety), and the stripper
# decided a "#" starts a comment by reading the previous character. An ESCAPED space
# leaves a space there without ending the word, so `echo a\ # && <launch>` had everything
# after the # dropped as a comment - the launch included - for every one of them. bash's
# rule is stated plainly: "#" begins a comment only at a word start, and an escaped space
# does not end a word. Each hook carries its OWN case, because a test that only covered one
# consumer would leave the other two to chance. (This file exercises pre:bash:devserver-ttl-gate.)
assert_red "ТТЛ-гейт: запуск спрятан после экранированного пробела и #: echo a\\ # && ..." \
  --contains '"decision": "block"' \
  -- h "echo a\\ # && pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт: то же с ;" \
  --contains '"decision": "block"' \
  -- h "echo a\\ # ; pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт: кавычка, затем экранированный пробел" \
  --contains '"decision": "block"' \
  -- h "echo 'x'\\ # && pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт: экранированный перевод строки не заканчивает слово" \
  --contains '"decision": "block"' \
  -- h "echo a\\
# && pnpm --filter @crm/api dev"

assert_green "ТТЛ-гейт: настоящий комментарий по-прежнему не запуск" \
  -- h "echo hi # pnpm --filter @crm/api dev"

assert_green "ТТЛ-гейт: строка-комментарий целиком — не запуск" \
  -- h "# pnpm --filter @crm/api dev"

# ── SR-M-22: the word-boundary rule must be observable HERE, not masked ─────────
# The comment-free second reading finds a launch the stripper hid, so a regression in the
# stripper's word-boundary rule left every case above green (measured: with the backslash
# check disabled this file stayed 46/0). A launch found ONLY by the second reading carries
# the label "[comment-free reading]"; for the escaped-space cases the stripper must find
# the launch by itself, so the label must be ABSENT. That pins the rule, not its fallback.
for esc in "echo a\\ # && pnpm --filter @crm/api dev" "echo a\\ # ; pnpm --filter @crm/api dev" \
           "echo 'x'\\ # && pnpm --filter @crm/api dev"; do
  assert_red "ТТЛ-гейт: правило границы слова само находит запуск (метки второго чтения нет): $esc" \
    --contains '"decision": "block"' \
    --not-contains "comment-free reading" \
    -- h "$esc"
done

# ── SR-H-20: shapes the stripper cannot know about are caught by the second reading ──
# A parameter expansion whose default value holds a space then #, and a process
# substitution immediately followed by #, both run the next command in bash and zsh.
# They are refused here, and they carry the label - the second reading did the work.
assert_red "ТТЛ-гейт SR-H-20 форма 1: \${x:- #} затем запуск" \
  --contains '"decision": "block"' \
  --contains "comment-free reading" \
  -- h "echo \${x:- #}; pnpm --filter @crm/api dev"

assert_red "ТТЛ-гейт SR-H-20 форма 2: <(true)# затем запуск" \
  --contains '"decision": "block"' \
  --contains "comment-free reading" \
  -- h "cat <(true)# ; pnpm --filter @crm/api dev"

# ── SR-H-24 / SR-M-21: an interpreter in front of dev-ttl.sh ────────────────────
# A launch behind `bash -c '<payload>' dev-ttl.sh` has dev-ttl.sh as $0, NOT as the wrapper:
# the payload is a bare launch and must be refused. With any other interpreter flag before
# the wrapper (the PR #485 shapes) the wrapper is real and the launch is wrapped.
for form in "bash -c 'pnpm --filter @crm/api dev' dev-ttl.sh" "sh -c 'pnpm --filter @crm/api dev' x dev-ttl.sh" \
            "bash -ec 'pnpm --filter @crm/api dev' x dev-ttl.sh" \
            "bash -o pipefail -c 'pnpm --filter @crm/api dev' dev-ttl.sh"; do
  assert_red "ТТЛ-гейт: payload за -c — голый запуск, dev-ttl.sh здесь \$0: $form" \
    --contains '"decision": "block"' \
    -- h "$form"
done
for flags in '-o pipefail' '--norc' '--' '+x' '-O extglob' '--rcfile /tmp/rc'; do
  assert_green "ТТЛ-гейт: настоящая обёртка за флагами интерпретатора проходит: bash $flags" \
    -- h "bash $flags $TTL -- pnpm --filter @crm/api dev"
done

# ── SR-H-24, the FAMILY (this hook's consumer view) ─────────────────────────────
# A code flag's payload is never discarded, wherever the flag sits in the interpreter's option
# region (see the safety suite for the history: three attempts, only the position-independent
# one is an invariant). Here the payload is a bare launch; every placement must be refused.
for sh in bash sh dash zsh ksh; do
  for t in "-c '@P@' @W@" "@W@ -c '@P@'" "--rcfile @W@ -c '@P@'" "--init-file @W@ -c '@P@'" \
           "-o pipefail -c '@P@' @W@" "-o @W@ -c '@P@'" "-O extglob -c '@P@' @W@" "+O @W@ -c '@P@'" \
           "+o @W@ -c '@P@'" "-ec '@P@' x @W@" "-xc '@P@' @W@" "-c '@P@' -- @W@" "@W@ -- -c '@P@'" \
           "-x -e -c '@P@' @W@ -- ls" "@W@ -x -c '@P@'" "-c '@P@' -c '@P@' @W@" \
           "-c 'ls' -c '@P@' @W@" "-c 'ls' -c '@P@'" "-c 'ls' x -ec '@P@'"; do
    cmd="$sh ${t//@P@/pnpm --filter @crm/api dev}"; cmd="${cmd//@W@/dev-ttl.sh}"
    assert_red "ТТЛ-гейт SR-H-24 (семейство): $cmd" \
      --contains '"decision": "block"' \
      -- h "$cmd"
  done
done

# ══ 2026-10-21: the gate inspected text that is DATA, not launcher position ══
# Four refusals in one day, none of them a launch. The hook's own header claimed
# it "only looks at the command in launcher position"; that was false for a
# heredoc body and for a package-runner subcommand, and the header is corrected
# in the same change. Each repro is a GREEN case here, with its hit count in the
# label — the counts are what made the diagnosis specific (one defect would not
# produce three "launches" from one markdown note).
#
# The asymmetry is the whole point of this section: a false positive costs a
# retry, a false negative cost two minutes of an API on :3000 against the live
# database (PR #485, 2026-08-05). So every green below is paired with reds that
# pin the launch shape it must not have relaxed.

# ── repro 1: a read-only dependency query ─────────────────────────────────────
# `pnpm` is deliberately NOT in UNDERSTOOD (membership there sets confident=True
# and short-circuits readings(), which is how that list leaked in round 3). The
# grant is per-subcommand: a vetted print-and-exit query behind a flag grammar
# that is complete. Everything else about a runner stays uncertain.
assert_green "РЕПРО-1: pnpm why vite — запрос к зависимостям, не запуск (1 ложное срабатывание)" \
  -- h "pnpm why vite"

for q in "ls vite" "list vite" "info vite" "view vite" "audit" "outdated" \
         "licenses" "why --json vite" "ls --depth 2 vite" "--filter @crm/api why vite" \
         "-r why vite" "--depth=2 ls vite"; do
  assert_green "РЕПРО-1 (семейство read-only подкоманд): pnpm $q" \
    -- h "pnpm $q"
done

# The grant must not widen to a subcommand that DOES launch, nor survive a flag
# the grammar does not know. These are the reds that make the green honest.
assert_red "РЕПРО-1 обратная сторона: pnpm exec vite — подкоманда, которая ЗАПУСКАЕТ (без inline DATABASE_URL)" \
  --contains '"decision": "block"' \
  -- h "pnpm exec vite --port 3010"

assert_red "РЕПРО-1 обратная сторона: pnpm dlx vite (без inline порта)" \
  --contains '"decision": "block"' \
  -- h "pnpm dlx vite"

assert_red "РЕПРО-1 обратная сторона: npm exec -- vite (\`--\` раньше съедал командное слово)" \
  --contains '"decision": "block"' \
  -- h "npm exec -- vite"

for bad in "-c vite" "--call vite" "--unknown-flag why vite"; do
  assert_red "РЕПРО-1 обратная сторона: грамматика флагов неполна → сегмент остаётся недостоверным: pnpm $bad" \
    --contains '"decision": "block"' \
    -- h "pnpm $bad"
done

# ── the grant is decided by the WHOLE argv, not by the subcommand name ────────
# Two findings in one review round, both of them a name that does not describe a
# behaviour:
#   `npm version` / `pnpm version` rewrites package.json, commits, tags, and RUNS
#     the project's preversion/version/postversion scripts — the exec surface this
#     design refuses to hand over, reached through a door marked "tell me the version".
#   `pnpm audit` is a query; `npm audit fix` and `pnpm audit --fix` rewrite the
#     lockfile and can trigger an install.
#
# READ THE TWO HALVES OF THIS SECTION TOGETHER, because they assert different
# things and swapping them is how the section would rot:
#   * the GREEN half says the GATE must not refuse these — neither form boots a
#     dev server, so refusing them would be a new false positive;
#   * the RED half probes the GRANT. A launcher-looking token in the same argv is
#     refused only while the segment stays UNCERTAIN. Re-add `version`, or vet
#     `fix` / `--fix`, and these go green — which is the regression signal.
assert_green "ПОЛНЫЙ argv: npm version patch не запуск — гейт не должен его трогать" \
  -- h "npm version patch"

assert_green "ПОЛНЫЙ argv: pnpm audit --fix не запуск — гейт не должен его трогать" \
  -- h "pnpm audit --fix"

assert_red "ПОЛНЫЙ argv (зонд гранта): version исключён — сегмент недостоверен, launcher в argv отказан" \
  --contains '"decision": "block"' \
  -- h "npm version vite"

assert_red "ПОЛНЫЙ argv (зонд гранта): npm audit fix — операнд-глагол снимает грант" \
  --contains '"decision": "block"' \
  -- h "npm audit fix vite"

assert_red "ПОЛНЫЙ argv (зонд гранта): pnpm audit --fix — флаг вне грамматики снимает грант" \
  --contains '"decision": "block"' \
  -- h "pnpm audit --fix vite"

assert_red "ПОЛНЫЙ argv (зонд гранта): licenses допускает только слово list" \
  --contains '"decision": "block"' \
  -- h "pnpm licenses vite"

assert_green "ПОЛНЫЙ argv: pnpm licenses list — ровно вычитанная форма" \
  -- h "pnpm licenses list"

# ── SR-M-1: грант выдан ТОЛЬКО pnpm/npm, чьи семантики проверены ──────────────
# Критерий PKG_QUERY_SPEC проверялся на pnpm и npm, а ключом стояли все пять
# PKG_RUNNERS. ИЗМЕРЕНО: на turbo 2.11.7 `turbo why dev` запускает и таск `why`,
# и таск `dev` — у turbo операнд САМ является именем таска; yarn 1.22.22 для 7 из
# 15 имён проваливается в `yarn run <script>`. Шестнадцать форм
# `turbo|yarn <granted> dev` переключились с BLOCK на ALLOW.
#
# Дырой это не стало только потому, что turbo.json не определяет ни одного из
# пятнадцати имён, — то есть гейт был прав благодаря фактам, которых он не читает.
# Заведи таск `info` — и гейт замолчит, причём молча: confident=True отключает и
# readings(), то есть страховки тоже нет.
#
# Часть этих случаев — ОСОЗНАННЫЕ ложные срабатывания (`turbo ls dev` только
# печатает список). Это принятое направление: повтор стоит минуту, тихая дыра с
# триггером в другом файле стоит базы.
for form in "why dev" "info dev" "ls dev" "ls preview" "outdated start"; do
  assert_red "SR-M-1: turbo не получает грант: turbo $form" \
    --contains '"decision": "block"' \
    -- h "turbo $form"
  assert_red "SR-M-1: yarn не получает грант: yarn $form" \
    --contains '"decision": "block"' \
    -- h "yarn $form"
done

assert_red "SR-M-1: bun тоже остаётся недостоверным" \
  --contains '"decision": "block"' \
  -- h "bun why dev"

# Обратная сторона: обычные формы turbo/yarn не начали отказываться.
for ok in "turbo build" "turbo test" "turbo run build --filter=@crm/web" "yarn install"; do
  assert_green "SR-M-1 обратная сторона: ничего нового не запрещено: $ok" \
    -- h "$ok"
done

assert_green "SR-M-1: грант pnpm/npm сохранён: npm why vite" \
  -- h "npm why vite"

# ── CR-H-1: `-w` — одно слово, две грамматики ─────────────────────────────────
# Для pnpm `-w` это `--workspace-root` и значения не берёт; для npm это
# `--workspace <name>` и берёт. ИЗМЕРЕНО: `npm -w info start` отказывался на base
# и проходил на head, а настоящий npm 10.7.0 запускал скрипт `start` в воркспейсе
# с именем `info`. Достижимо только если воркспейс назван как одна из выданных
# подкоманд — то есть гейт был прав благодаря факту, которого он не читает.
for form in "start" "dev" "preview"; do
  assert_red "CR-H-1: npm -w <workspace> $form — значение флага съедено, грант не выдан" \
    --contains '"decision": "block"' \
    -- h "npm -w info $form"
done
assert_red "CR-H-1: длинная форма тоже: npm --workspace info start" \
  --contains '"decision": "block"' \
  -- h "npm --workspace info start"
assert_green "CR-H-1 обратная сторона: у pnpm -w булев (--workspace-root), запрос проходит" \
  -- h "pnpm -w ls"

# ── CR-M-4: одна грамматика флагов на оба потребителя ─────────────────────────
# Грант читал одну таблицу, предикат запуска — другую, и спасал более строгий из
# них. Теперь оба зовут pkg_value_flags(). `--depth` объявлен БУЛЕВЫМ: его
# грамматика зависит от позиции, и из двух чтений только это падает закрыто —
# `--depth 2` до подкоманды оставляет `2` в позиции подкоманды, которой нет ни в
# одной таблице запросов.
for amb in "--depth vite ls" "--depth 2 ls vite"; do
  assert_red "CR-M-4: неоднозначная позиция флага → грант не выдан: pnpm $amb" \
    --contains '"decision": "block"' \
    -- h "pnpm $amb"
done
assert_green "CR-M-4: после подкоманды флаг однозначен: pnpm ls --depth 2 vite" \
  -- h "pnpm ls --depth 2 vite"

# ── repros 2-4: a heredoc body is DATA, and a QUOTED delimiter proves it ───────
# Stage 2 of lib/cmdscan.py was always emphatic that a heredoc body is data,
# never code — and stage 1 (substitution extraction) ran FIRST and had already
# mined it. So a markdown bullet and a Python string literal were read as
# command substitutions. All three reported shapes used a quoted delimiter, i.e.
# exactly the case where bash itself guarantees the body is inert (verified by
# execution, not by reading: `cat <<'EOF'` with `$(echo X)` in the body prints
# the text, `cat <<EOF` prints X).
MD_NOTE=$'cat > notes.md <<\'EOF\'\n- `pnpm dev` boots the web app\n- `vite` is the bundler\n- `node dist/main` boots the api\nEOF'
assert_green "РЕПРО-2: markdown-заметка, три упоминания в обратных кавычках (3 ложных срабатывания)" \
  -- h "$MD_NOTE"

PR_BODY=$'gh pr create --title t --body "$(cat <<\'EOF\'\nBefore: the gate refused `pnpm why vite`.\nEOF\n)"'
assert_green "РЕПРО-3: текст описания PR в heredoc (1 ложное срабатывание)" \
  -- h "$PR_BODY"

PY_HEREDOC=$'python3 - <<\'PYEOF\'\nprint("- `vite` is the bundler")\nprint("- `pnpm dev` boots the web app")\nPYEOF'
assert_green "РЕПРО-4: строковые литералы python в heredoc (2 ложных срабатывания)" \
  -- h "$PY_HEREDOC"

# `<<\EOF` quotes the delimiter exactly as `<<'EOF'` does (checked by running
# bash, which prints the text unexpanded). HEREDOC_RE never matched this form,
# so such a body used to be read as ordinary code.
ESC_DELIM=$'cat > notes.md <<\\EOF\n$(pnpm --filter @crm/api dev)\nEOF'
assert_green "РЕПРО-2/4 родственная форма: <<\\\\EOF тоже экранирует разделитель — тело инертно" \
  -- h "$ESC_DELIM"

# Found by attacking the span scanner rather than by reading it: an escaped
# quote before the opener makes the span scanner and the segmenter take different
# routes through the line. On main this was refused; the refusal was wrong, and
# the proof is execution rather than argument — run the shape and the body lands
# in the file verbatim, no marker file, nothing executed. A quoted delimiter is
# inert no matter what precedes the opener.
ESC_QUOTE_BEFORE=$'echo \\" ; cat > n.md <<\'EOF\'\n$(pnpm --filter @crm/api dev)\nEOF'
assert_green "СУЖЕНИЕ: экранированная кавычка перед закавыченным heredoc — тело всё равно инертно (проверено исполнением)" \
  -- h "$ESC_QUOTE_BEFORE"

# ── the other direction: an UNQUOTED body really is expanded by the shell ─────
UNQ_SUBST=$'cat > out.txt <<EOF\n$(pnpm --filter @crm/api dev)\nEOF'
assert_red "НЕ ослаблено: <<EOF без кавычек — подстановка в теле реально исполняется" \
  --contains '"decision": "block"' \
  -- h "$UNQ_SUBST"

UNQ_BACKTICK=$'cat > out.txt <<EOF\n`vite --port 3010`\nEOF'
assert_red "НЕ ослаблено: <<EOF без кавычек, обратные кавычки в теле" \
  --contains '"decision": "block"' \
  -- h "$UNQ_BACKTICK"

UNQ_DASH=$'cat > out.txt <<-EOF\n\t$(pnpm dev)\n\tEOF'
assert_red "НЕ ослаблено: <<-EOF (срезание табов) без кавычек" \
  --contains '"decision": "block"' \
  -- h "$UNQ_DASH"

AFTER_HEREDOC=$'cat > note.md <<\'EOF\'\nnothing here\nEOF\npnpm --filter @crm/api dev'
assert_red "НЕ ослаблено: запуск ПОСЛЕ закрытого heredoc — защита тела не покрывает соседа" \
  --contains '"decision": "block"' \
  -- h "$AFTER_HEREDOC"

BEFORE_HEREDOC=$'pnpm --filter @crm/api dev\ncat > note.md <<\'EOF\'\nnothing here\nEOF'
assert_red "НЕ ослаблено: запуск ПЕРЕД heredoc" \
  --contains '"decision": "block"' \
  -- h "$BEFORE_HEREDOC"

# Quote-parity shapes, all of which DO launch in bash — the span scanner and the
# segmenter walk quotes differently, and an exemption must never survive that.
PARITY_1=$'echo "$(echo \\"x\\")" ; cat > n.md <<\'EOF\'\nnote\nEOF\npnpm --filter @crm/api dev'
assert_red "ЧЁТНОСТЬ КАВЫЧЕК: кавычка внутри подстановки, затем heredoc, затем запуск" \
  --contains '"decision": "block"' \
  -- h "$PARITY_1"

PARITY_2=$'echo "unclosed ; cat > n.md <<\'EOF\'\n$(pnpm --filter @crm/api dev)\nEOF'
assert_red "ЧЁТНОСТЬ КАВЫЧЕК: незакрытая кавычка перед открывашкой" \
  --contains '"decision": "block"' \
  -- h "$PARITY_2"

PARITY_3=$'cat > n.md <<\'EOF\'\nnote\nEOF\necho "$(pnpm --filter @crm/api dev)"'
assert_red "ЧЁТНОСТЬ КАВЫЧЕК: запуск в подстановке ПОСЛЕ закавыченного тела" \
  --contains '"decision": "block"' \
  -- h "$PARITY_3"

PARITY_4=$'cat n.md <<\'A\' <<B\nfirst\nA\n$(pnpm --filter @crm/api dev)\nB'
assert_red "ЧЁТНОСТЬ КАВЫЧЕК: два heredoc в одной строке, второй без кавычек" \
  --contains '"decision": "block"' \
  -- h "$PARITY_4"

PARITY_5=$'cat <<\'A\'\n`vite`\nA\ncat <<B\n$(pnpm --filter @crm/api dev)\nB'
assert_red "ЧЁТНОСТЬ КАВЫЧЕК: закавыченное тело, затем незакавыченное с запуском" \
  --contains '"decision": "block"' \
  -- h "$PARITY_5"

# ── the parser differential: two readings of one text, failing closed ─────────
# _heredoc_literal_spans is a SECOND reading of the same line, and a span that
# the segmenter does not also treat as a body would exempt live code. Both of
# the following were reproduced as fail-OPEN leaks (a launch hidden from the
# gate) during this change and are the reason the three devices exist: the
# comment rule is shared, a span needs its terminator, and every span is
# confirmed against the bodies the segmenter actually captured.
CMT_SUBST=$'# cat > note.md <<\'EOF\'\n$(pnpm --filter @crm/api dev)\nEOF'
assert_red "ДИФФЕРЕНЦИАЛ: открывашка heredoc спрятана в комментарии — \$() форма" \
  --contains '"decision": "block"' \
  -- h "$CMT_SUBST"

CMT_BACKTICK=$'# cat > note.md <<\'EOF\'\n`vite --port 3010`\nEOF'
assert_red "ДИФФЕРЕНЦИАЛ: открывашка heredoc спрятана в комментарии — обратные кавычки" \
  --contains '"decision": "block"' \
  -- h "$CMT_BACKTICK"

# CR-M-3: the two readings must agree about a TRAILING comment. The span scanner
# used to clear `pending` on one and the segmenter does not, so these two
# commands — identical but for ` # note` — disagreed: the commented one was
# refused, the plain one allowed. bash sides with the segmenter (a trailing
# comment does not cancel a heredoc the same line already opened), and a
# divergence like this is a false positive of exactly the kind this change
# removes. Asserted as a PAIR on purpose: the property is that they agree.
CMT_TRAILING=$'cat > n.md <<\'EOF\' # note\n`pnpm dev`\nEOF'
CMT_TRAILING_PLAIN=$'cat > n.md <<\'EOF\'\n`pnpm dev`\nEOF'
assert_green "CR-M-3: heredoc с хвостовым комментарием — тело всё ещё данные" \
  -- h "$CMT_TRAILING"
assert_green "CR-M-3: та же команда без комментария — тот же вердикт (пара)" \
  -- h "$CMT_TRAILING_PLAIN"

# ...и обратная сторона той же правки — ГРУБОЕ правило на открывашке.
# Хронология четырёх попыток (каждая правка закрывала одно и открывала другое):
#   1) сбрасывать `pending` всегда       -> ложное срабатывание выше (CR-M-3);
#   2) не сбрасывать никогда             -> fail-open на пяти формах
#      `cat <<'EOF' $(true #)`: `#` съедает `)`, в одном чтении `$(` остаётся
#      незакрытым, и спан освобождал тело, которое реально исполняется;
#   3) считать глубину подстановок       -> ещё три fail-open, потому что
#      счётчик — ТРЕТЬЕ независимое чтение того же текста: `$( (true) #)`
#      не считает вложенную скобку, `$(`/бэктик внутри двойных кавычек не
#      отслеживается вовсе, а `)` из case-шаблона (`$(case x in x) true #)`)
#      закрывает ещё открытую подстановку.
#   4) искать `(` или бэктик в строке открывашки -> всё ещё ДЕНИЛИСТ, а денилист
#      по синтаксису shell всегда что-то упускает: продолжение строки обратным
#      слэшем уносит `$(` на следующую физическую строку, а `${…}` и одинокий `$`
#      не содержат ни одного отслеживаемого символа;
#   5) ТЕКУЩЕЕ — тест ПЕРЕВЁРНУТ: защита сохраняется, только если остаток
#      ЛОГИЧЕСКОЙ строки открывашки состоит из разрешённого — пробелы,
#      комментарий, редиректы и пайпы. Всё прочее, известное или нет, защиту
#      снимает. Обойти конструкцией, о которой никто не подумал, нельзя: её нет
#      в списке, значит она падает закрыто ПО ОПРЕДЕЛЕНИЮ.
# Это тот же приём, что уже сделан в PKG_QUERY_SPEC, и контраст — главный урок:
# аллоулист сошёлся за один раунд, денилист занял пять.
# Ни один из этих случаев не должен снова стать зелёным через «оптимизацию»
# обратно к поиску опасных символов.
CMT_IN_SUBST=$'cat <<\'EOF\' $(true #)\n`vite`\nEOF\n)'
assert_red "CR-M-3 fail-open: \$(true #) съедает скобку — освобождения не даём" \
  --contains '"decision": "block"' \
  -- h "$CMT_IN_SUBST"

CMT_IN_SUBST2=$'cat <<\'EOF\' $(true #)\n`pnpm --filter @crm/api dev`\nEOF\n)'
assert_red "CR-M-3 fail-open: то же с pnpm dev в теле" \
  --contains '"decision": "block"' \
  -- h "$CMT_IN_SUBST2"

CMT_IN_BACKTICK=$'cat <<\'EOF\' `true #`\n`vite`\nEOF\n`'
assert_red "CR-M-3 fail-open: обратные кавычки вместо \$()" \
  --contains '"decision": "block"' \
  -- h "$CMT_IN_BACKTICK"

CMT_IN_SUBST_NESTED=$'cat <<\'EOF\' $(echo $(true #))\n`vite`\nEOF\n)'
assert_red "CR-M-3 fail-open: два уровня вложенности" \
  --contains '"decision": "block"' \
  -- h "$CMT_IN_SUBST_NESTED"

# Попытка 3 (подсчёт глубины) ломалась ровно на этих трёх. Грубое правило их не
# различает — и именно поэтому проходит.
CMT_NESTED_PAREN=$'cat <<\'EOF\' $( (true) #)\n`vite`\nEOF\n)'
assert_red "попытка-3 a: вложенная некавыченная скобка \$( (true) #)" \
  --contains '"decision": "block"' \
  -- h "$CMT_NESTED_PAREN"

CMT_CASE_PAREN=$'cat <<\'EOF\' $(case x in x) true #)\n`vite`\nEOF\n)'
assert_red "попытка-3 b: скобка case-шаблона \$(case x in x) true #)" \
  --contains '"decision": "block"' \
  -- h "$CMT_CASE_PAREN"

# Эта форма — СИНТАКСИЧЕСКАЯ ОШИБКА bash ("bad substitution: no closing ')'",
# проверено исполнением: не запускается ничего). Грубое правило отказывает и ей:
# это переплата, а не находка, и она дешевле разбора состояния кавычек.
CMT_IN_DQUOTE=$'cat <<\'EOF\' "$(true #)"\n`vite`\nEOF\n)'
assert_red "попытка-3 c: \$( внутри двойных кавычек (переплата, форма не исполняется)" \
  --contains '"decision": "block"' \
  -- h "$CMT_IN_DQUOTE"

# Попытка 4 (поиск опасных символов) ломалась на этих четырёх: ни один из них не
# содержит `(` или бэктика в строке открывашки — именно поэтому денилист и
# заменён аллоулистом.
CONT_SUBST=$'cat <<\'EOF\' \\\n$(true #)\n`vite`\nEOF\n)'
assert_red "попытка-4 a: продолжение строки уносит \$( на следующую физическую строку" \
  --contains '"decision": "block"' \
  -- h "$CONT_SUBST"

CONT_DOLLAR=$'cat <<\'EOF\' $\\\n(true #)\n`vite`\nEOF\n)'
assert_red "попытка-4 b: \$ перед продолжением, скобка на следующей строке" \
  --contains '"decision": "block"' \
  -- h "$CONT_DOLLAR"

BRACE_EXP=$'cat <<\'EOF\' ${x:-#}\n`vite`\nEOF'
assert_red "попытка-4 c: \${…} в строке открывашки" \
  --contains '"decision": "block"' \
  -- h "$BRACE_EXP"

BARE_DOLLAR=$'cat <<\'EOF\' $\n`vite`\nEOF'
assert_red "попытка-4 d: одинокий \$ в строке открывашки" \
  --contains '"decision": "block"' \
  -- h "$BARE_DOLLAR"

SEMI_LAUNCH=$'cat <<\'EOF\' ; pnpm --filter @crm/api dev\nnote\nEOF'
assert_red "аллоулист: \`;\` не в списке — запуск на строке открывашки не прячется" \
  --contains '"decision": "block"' \
  -- h "$SEMI_LAUNCH"

# Обратная сторона аллоулиста: то, что в нём ЕСТЬ, защиту не снимает — иначе
# правило переплачивало бы на каждой обычной записи файла.
for tail in "> out.txt" "> out.txt 2>&1" "| tee out.txt" "# note"; do
  OK_TAIL=$'cat <<\'EOF\' '"$tail"$'\n`vite`\nEOF'
  assert_green "аллоулист: разрешённый хвост защиту не снимает: $tail" \
    -- h "$OK_TAIL"
done

# ── попытка 6: край самого аллоулиста — наше «пробел» шире, чем у bash ────────
# Это уже не пропущенная конструкция, а расхождение определений. Границу слова
# перед `#` решал самодельный `isspace()`, а он принимает `\r`, `\v`, `\f`,
# которые bash пробелом НЕ считает: подделанная граница срезала хвост, и
# аллоулист пропускал то, что bash исполнит. Лечится так же, как CR-M-4 —
# не повторять правило, а позвать его: `_starts_word`, тот же предикат, что
# в основном цикле. Он же исправляет и обратную сторону: bash начинает слово
# после `|`, поэтому `|#` — настоящий комментарий, и `isspace()` его терял.
for ws in 'ws_r:\r' 'ws_v:\v' 'ws_f:\f'; do
  name="${ws%%:*}"; chr="${ws##*:}"
  FORGED=$(printf 'cat <<'"'"'EOF'"'"' $(true)%b#)\n`vite`\nEOF' "$chr")
  assert_red "попытка-6: подделанная граница комментария ($name) — защиту не даём" \
    --contains '"decision": "block"' \
    -- h "$FORGED"
done

BARE_CR=$(printf 'cat <<'"'"'EOF'"'"' \r$(true #)\n`vite`\nEOF')
assert_red "попытка-6: одинокий \\r в хвосте — не пробел для bash" \
  --contains '"decision": "block"' \
  -- h "$BARE_CR"

# Обратная сторона того же предиката: bash начинает слово после `|`, значит это
# комментарий, и хвост остаётся разрешённым.
PIPE_CMT=$'cat <<\'EOF\' |# note\n`vite`\nEOF'
assert_green "попытка-6 обратная сторона: |# — настоящий комментарий" \
  -- h "$PIPE_CMT"

TAB_CMT=$'cat <<\'EOF\'\t# note\n`vite`\nEOF'
assert_green "попытка-6: таб перед комментарием — пробел и для bash" \
  -- h "$TAB_CMT"

UNTERMINATED=$'cat > note.md <<\'EOF\'\n$(pnpm --filter @crm/api dev)'
assert_red "ДИФФЕРЕНЦИАЛ: heredoc без терминатора — неопределённость не даёт освобождения" \
  --contains '"decision": "block"' \
  -- h "$UNTERMINATED"

DELIM_PAREN=$'echo "$(cat <<\'EOF\'\nnote\nEOF)" && $(pnpm --filter @crm/api dev)'
assert_red "ДИФФЕРЕНЦИАЛ: терминатор в форме \`EOF)\`, затем запуск" \
  --contains '"decision": "block"' \
  -- h "$DELIM_PAREN"

# ── PR #485: the shape the whole gate exists for ──────────────────────────────
# An inherited DATABASE_URL and API_PORT overrode a worktree .env and an API
# listened on :3000 against the owner's LIVE database for about two minutes. The
# launcher carries no inline environment at all in that shape, which is exactly
# why "it has no DATABASE_URL on the line" can never be a reason to allow.
assert_red "PR #485: запуск без inline DATABASE_URL" \
  --contains '"decision": "block"' \
  -- h "pnpm --filter @crm/api dev"

assert_red "PR #485: запуск без inline порта" \
  --contains '"decision": "block"' \
  -- h "DATABASE_URL=postgresql://h:5432/crm_qa pnpm --filter @crm/api dev"

assert_red "PR #485: собранный API, окружение целиком унаследовано" \
  --contains '"decision": "block"' \
  -- h "node apps/api/dist/main.js"

guard_test_summary "test-pre-bash-devserver-ttl-gate.sh"
