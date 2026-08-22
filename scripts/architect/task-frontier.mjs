#!/usr/bin/env node
// Вычисляет фронтир задач: какие task-файлы можно диспатчить прямо сейчас.
//
// Фронтир = задача со `## Статус: ready`, у которой КАЖДЫЙ блокер из `## Блокеры:`
// имеет `## Статус: done`. Это заменяет оценку «на глаз»: диспатч задачи, которой
// нет в выводе этого скрипта, — нарушение (rules/common/orchestration-routing.md).
//
// Поля читаются из шапки task-файла (.claude/tasks/templates/task.md.tpl):
//   ## Статус: ready | in-progress | blocked | draft | done
//   ## Блокеры: none | task-a, task-b
//
// Файлы без `## Статус:` — legacy (заведены до 2026-08-22). Они не ошибка и не
// участвуют в расчёте; их число печатается, чтобы миграция была видна.
//
// Использование:
//   node scripts/architect/task-frontier.mjs            # человекочитаемо
//   node scripts/architect/task-frontier.mjs --json     # для скриптов
//   node scripts/architect/task-frontier.mjs --tasks-dir <путь>
//
// Exit 1 — только на структурных дефектах графа (висячий блокер, цикл,
// самоблокировка). Пустой фронтир при живых задачах — это факт, не ошибка.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dirFlag = args.indexOf('--tasks-dir')
const TASKS_DIR = dirFlag !== -1 ? args[dirFlag + 1] : '.claude/tasks'

// `draft` уже встречался в репозитории до этого скрипта («ждёт решений владельца»)
// и означает ровно A2/A3 из rules/common/autonomy-levels.md: задача не диспатчится,
// пока владелец не ответил. Словарь выровнен по репозиторию, а не наоборот.
const STATUSES = new Set(['ready', 'in-progress', 'blocked', 'draft', 'done'])

/** Читает одно `## <Поле>:` из шапки файла. */
function field(text, name) {
  const m = text.match(new RegExp(`^##\\s*${name}\\s*:\\s*(.*)$`, 'mi'))
  return m ? m[1].trim() : null
}

function parseBlockers(raw) {
  if (!raw) return []
  const cleaned = raw
    .replace(/\(.*?\)/g, '') // пояснения в скобках не адреса
    .trim()
  if (!cleaned || /^none$/i.test(cleaned) || /^нет$/i.test(cleaned)) return []
  return cleaned
    .split(',')
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter(Boolean)
}

if (!existsSync(TASKS_DIR)) {
  console.error(`Каталог задач не найден: ${TASKS_DIR}`)
  process.exit(1)
}

const files = readdirSync(TASKS_DIR)
  .filter((f) => f.startsWith('task-') && f.endsWith('.md'))
  .filter((f) => !f.endsWith('.progress.md') && !f.endsWith('.blocked.md'))

const tasks = new Map()
const legacy = []

for (const f of files) {
  const id = basename(f, '.md')
  const text = readFileSync(join(TASKS_DIR, f), 'utf8')
  const rawStatus = field(text, 'Статус')
  if (!rawStatus) {
    legacy.push(id)
    continue
  }
  const status = rawStatus.toLowerCase().split(/[\s|]/)[0]
  tasks.set(id, {
    id,
    status,
    statusValid: STATUSES.has(status),
    blockers: parseBlockers(field(text, 'Блокеры')),
    hasBlockedFile: existsSync(join(TASKS_DIR, `${id}.blocked.md`)),
  })
}

// --- структурные дефекты графа -------------------------------------------
const errors = []

for (const t of tasks.values()) {
  if (!t.statusValid) {
    errors.push(
      `${t.id}: неизвестный статус «${t.status}» (ожидается ${[...STATUSES].join(' | ')})`,
    )
  }
  for (const b of t.blockers) {
    if (b === t.id) errors.push(`${t.id}: блокирует сам себя`)
    else if (!tasks.has(b)) {
      const hint = legacy.includes(b) ? ' (файл есть, но без «## Статус:» — legacy)' : ''
      errors.push(`${t.id}: блокер «${b}» не найден среди задач со статусом${hint}`)
    }
  }
}

// поиск циклов обходом в глубину
const WHITE = 0,
  GREY = 1,
  BLACK = 2
const colour = new Map([...tasks.keys()].map((k) => [k, WHITE]))
const cyclic = new Set()
const stack = []
function visit(id) {
  colour.set(id, GREY)
  stack.push(id)
  for (const b of tasks.get(id)?.blockers ?? []) {
    if (!tasks.has(b)) continue
    if (colour.get(b) === GREY) {
      const members = stack.slice(stack.indexOf(b))
      for (const m of members) cyclic.add(m)
      errors.push(`цикл блокировок: ${members.concat(b).join(' -> ')}`)
    } else if (colour.get(b) === WHITE) visit(b)
  }
  stack.pop()
  colour.set(id, BLACK)
}
for (const id of tasks.keys()) if (colour.get(id) === WHITE) visit(id)

// --- фронтир ---------------------------------------------------------------
const isDone = (id) => tasks.get(id)?.status === 'done'

const frontier = []
const blocked = []
const undecidable = [] // граф про эту задачу сломан — считать её готовой нельзя

for (const t of tasks.values()) {
  if (t.status !== 'ready') continue

  // Висячий блокер НЕ игнорируется: задача с опечаткой в id иначе выглядела бы
  // разблокированной, и молчаливо уезжала бы в диспатч. Это ровно тот класс
  // тихого отказа, ради которого скрипт написан.
  const dangling = t.blockers.filter((b) => !tasks.has(b))
  const inCycle = cyclic.has(t.id)
  if (dangling.length || inCycle) {
    undecidable.push({
      ...t,
      why: [
        dangling.length ? `висячие блокеры: ${dangling.join(', ')}` : null,
        inCycle ? 'участвует в цикле блокировок' : null,
      ]
        .filter(Boolean)
        .join('; '),
    })
    continue
  }

  const open = t.blockers.filter((b) => !isDone(b))
  if (open.length === 0) frontier.push(t)
  else blocked.push({ ...t, open })
}

frontier.sort((a, b) => a.id.localeCompare(b.id))
blocked.sort((a, b) => a.id.localeCompare(b.id))
undecidable.sort((a, b) => a.id.localeCompare(b.id))

const counts = {}
for (const t of tasks.values()) counts[t.status] = (counts[t.status] ?? 0) + 1

if (asJson) {
  console.log(
    JSON.stringify(
      {
        frontier: frontier.map((t) => t.id),
        blocked: blocked.map((t) => ({ id: t.id, waitingOn: t.open })),
        undecidable: undecidable.map((t) => ({ id: t.id, why: t.why })),
        counts,
        legacyCount: legacy.length,
        errors,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`Фронтир (можно диспатчить сейчас) — ${frontier.length}:`)
  if (frontier.length === 0) console.log('  (пусто)')
  for (const t of frontier) {
    console.log(`  ${t.id}${t.hasBlockedFile ? '  ⚠ есть .blocked.md' : ''}`)
  }

  console.log(`\nЖдут блокеров — ${blocked.length}:`)
  if (blocked.length === 0) console.log('  (пусто)')
  for (const t of blocked) console.log(`  ${t.id}  ← ${t.open.join(', ')}`)

  if (undecidable.length) {
    console.log(`\nНе поддаются расчёту (во фронтир НЕ идут) — ${undecidable.length}:`)
    for (const t of undecidable) console.log(`  ${t.id}  ← ${t.why}`)
  }

  const summary = Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ')
  console.log(`\nСтатусы: ${summary || 'нет задач с полем «Статус»'}`)
  if (legacy.length) {
    console.log(`Legacy без «## Статус:» — ${legacy.length} (в расчёте не участвуют)`)
  }
  if (errors.length) {
    console.log(`\nДефекты графа — ${errors.length}:`)
    for (const e of errors) console.log(`  ✗ ${e}`)
  }
}

process.exit(errors.length ? 1 : 0)
