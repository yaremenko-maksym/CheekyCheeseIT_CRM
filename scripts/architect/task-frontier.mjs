#!/usr/bin/env node
// Computes the task frontier: which task files can be dispatched right now.
//
// Frontier = a task with `## Status: ready` whose EVERY blocker from `## Blockers:`
// has `## Status: done`. This replaces an "by eye" assessment: dispatching a task
// that is not in this script's output is a violation (rules/common/orchestration-routing.md).
//
// The fields are read from the task file header (.claude/tasks/templates/task.md.tpl):
//   ## Status: ready | in-progress | blocked | draft | done
//   ## Blockers: none | task-a, task-b
//
// Both the English heading tokens (Status / Blockers) and the legacy Russian ones
// (Статус / Блокеры) are accepted: the template was translated to English 2026-10-05,
// but live task files in main still use the Russian headings, so both must parse.
//
// Files without a recognized `## Status:` / `## Статус:` are legacy (created before
// 2026-08-22). They are not an error and do not participate in the computation; their
// count is printed so the migration stays visible.
//
// Usage:
//   node scripts/architect/task-frontier.mjs            # human-readable
//   node scripts/architect/task-frontier.mjs --json     # for scripts
//   node scripts/architect/task-frontier.mjs --tasks-dir <path>
//
// Exit 1 — only on structural defects of the graph (a dangling blocker, a cycle,
// a self-block). An empty frontier with live tasks is a fact, not an error.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dirFlag = args.indexOf('--tasks-dir')
const TASKS_DIR = dirFlag !== -1 ? args[dirFlag + 1] : '.claude/tasks'

// `draft` already appeared in the repository before this script ("awaiting owner decisions")
// and means exactly A2/A3 from rules/common/autonomy-levels.md: the task is not dispatched
// until the owner has answered. The vocabulary is aligned to the repository, not the reverse.
const STATUSES = new Set(['ready', 'in-progress', 'blocked', 'draft', 'done'])

/** Reads one `## <Field>:` from the file header. Accepts any of the given names. */
function field(text, names) {
  const alt = (Array.isArray(names) ? names : [names]).join('|')
  const m = text.match(new RegExp(`^##\\s*(?:${alt})\\s*:\\s*(.*)$`, 'mi'))
  return m ? m[1].trim() : null
}

function parseBlockers(raw) {
  if (!raw) return []
  const cleaned = raw
    .replace(/\(.*?\)/g, '') // parenthetical explanations are not addresses
    .trim()
  if (!cleaned || /^none$/i.test(cleaned) || /^нет$/i.test(cleaned)) return []
  return cleaned
    .split(',')
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter(Boolean)
}

if (!existsSync(TASKS_DIR)) {
  console.error(`Tasks directory not found: ${TASKS_DIR}`)
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
  const rawStatus = field(text, ['Status', 'Статус'])
  if (!rawStatus) {
    legacy.push(id)
    continue
  }
  const status = rawStatus.toLowerCase().split(/[\s|]/)[0]
  tasks.set(id, {
    id,
    status,
    statusValid: STATUSES.has(status),
    blockers: parseBlockers(field(text, ['Blockers', 'Блокеры'])),
    hasBlockedFile: existsSync(join(TASKS_DIR, `${id}.blocked.md`)),
  })
}

// --- structural defects of the graph -------------------------------------
const errors = []

for (const t of tasks.values()) {
  if (!t.statusValid) {
    errors.push(`${t.id}: unknown status "${t.status}" (expected ${[...STATUSES].join(' | ')})`)
  }
  for (const b of t.blockers) {
    if (b === t.id) errors.push(`${t.id}: blocks itself`)
    else if (!tasks.has(b)) {
      const hint = legacy.includes(b) ? ' (file exists, but without "## Status:" — legacy)' : ''
      errors.push(`${t.id}: blocker "${b}" not found among tasks with a status${hint}`)
    }
  }
}

// cycle search via depth-first traversal
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
      errors.push(`blocker cycle: ${members.concat(b).join(' -> ')}`)
    } else if (colour.get(b) === WHITE) visit(b)
  }
  stack.pop()
  colour.set(id, BLACK)
}
for (const id of tasks.keys()) if (colour.get(id) === WHITE) visit(id)

// --- frontier --------------------------------------------------------------
const isDone = (id) => tasks.get(id)?.status === 'done'

const frontier = []
const blocked = []
const undecidable = [] // the graph around this task is broken — it cannot be treated as ready

for (const t of tasks.values()) {
  if (t.status !== 'ready') continue

  // A dangling blocker is NOT ignored: a task with a typo in an id would otherwise look
  // unblocked and silently drive into dispatch. This is exactly the class of silent
  // failure the script is written for.
  const dangling = t.blockers.filter((b) => !tasks.has(b))
  const inCycle = cyclic.has(t.id)
  if (dangling.length || inCycle) {
    undecidable.push({
      ...t,
      why: [
        dangling.length ? `dangling blockers: ${dangling.join(', ')}` : null,
        inCycle ? 'participates in a blocker cycle' : null,
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
  console.log(`Frontier (dispatchable now) — ${frontier.length}:`)
  if (frontier.length === 0) console.log('  (empty)')
  for (const t of frontier) {
    console.log(`  ${t.id}${t.hasBlockedFile ? '  ⚠ has .blocked.md' : ''}`)
  }

  console.log(`\nWaiting on blockers — ${blocked.length}:`)
  if (blocked.length === 0) console.log('  (empty)')
  for (const t of blocked) console.log(`  ${t.id}  ← ${t.open.join(', ')}`)

  if (undecidable.length) {
    console.log(`\nNot computable (do NOT enter the frontier) — ${undecidable.length}:`)
    for (const t of undecidable) console.log(`  ${t.id}  ← ${t.why}`)
  }

  const summary = Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ')
  console.log(`\nStatuses: ${summary || 'no tasks with a "Status" field'}`)
  if (legacy.length) {
    console.log(`Legacy without "## Status:" — ${legacy.length} (not in the computation)`)
  }
  if (errors.length) {
    console.log(`\nGraph defects — ${errors.length}:`)
    for (const e of errors) console.log(`  ✗ ${e}`)
  }
}

process.exit(errors.length ? 1 : 0)
