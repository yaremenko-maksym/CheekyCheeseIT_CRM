/**
 * Schema-vs-DDL coverage (backlog 434): which tables, columns and named indexes the Drizzle schema
 * declares that no production DDL file creates.
 *
 * Production never runs `drizzle-kit`; its schema is the `drizzle/manual/*.sql` list. A schema
 * object no such file creates exists in CI (`db:push`) but not in production, and any query that
 * selects the whole row then fails there with 42703 / 42P01 — the drift of backlog 434.
 *
 * Deliberately NOT a SQL parser: it recognises the three forms the manual files use to create
 * these objects (`CREATE TABLE … (…)`, `ALTER TABLE … ADD COLUMN …`, `CREATE [UNIQUE] INDEX … ON …`)
 * and nothing else. A form it does not recognise reads as "not created", so it fails loud (an
 * allow-list entry or a recognised form fixes it), never silent.
 */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'

const NOT_A_COLUMN = new Set([
  'constraint',
  'primary',
  'unique',
  'foreign',
  'check',
  'exclude',
  'like',
])

function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"/g, '')
    .toLowerCase()
    .replace(/\bpublic\./g, '')
}

/** The body of the parenthesised list that opens at `open`, split on its top-level commas. */
function topLevelItems(sql: string, open: number): string[] {
  const items: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      i = sql.indexOf("'", i + 1)
      if (i === -1) break
    } else if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) {
      items.push(sql.slice(start, i))
      break
    } else if (ch === ',' && depth === 1) {
      items.push(sql.slice(start, i))
      start = i + 1
    }
  }
  return items
}

/** Keys of every object the given DDL texts create: `t`, `t.column`, `t#index`. */
export function ddlCreatedObjects(sqlTexts: readonly string[]): Set<string> {
  const created = new Set<string>()
  for (const sql of sqlTexts.map(normalise)) {
    for (const { 0: whole, 1: table = '', index } of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\s*\(/g,
    )) {
      created.add(table)
      for (const item of topLevelItems(sql, index + whole.length - 1)) {
        const col = /^\s*(\w+)/.exec(item)?.[1]
        if (col && !NOT_A_COLUMN.has(col)) created.add(`${table}.${col}`)
      }
    }
    for (const { 1: table, 2: actions = '' } of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(\w+)([^;]*)/g,
    )) {
      for (const { 1: col } of actions.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/g)) {
        created.add(`${table}.${col}`)
      }
    }
    for (const { 1: name, 2: table } of sql.matchAll(
      /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:only\s+)?(\w+)/g,
    )) {
      created.add(`${table}#${name}`)
    }
  }
  return created
}

/** Keys of every table, column and named index the given Drizzle tables declare. */
export function declaredSchemaObjects(tables: readonly PgTable[]): string[] {
  return tables.flatMap((t) => {
    const c = getTableConfig(t)
    return [
      c.name,
      ...c.columns.map((col) => `${c.name}.${col.name}`),
      ...c.indexes.flatMap((ix) => (ix.config.name ? [`${c.name}#${ix.config.name}`] : [])),
    ]
  })
}

/** Declared keys that no DDL text creates and the allow-list does not name, sorted. */
export function uncreatedSchemaObjects(
  tables: readonly PgTable[],
  sqlTexts: readonly string[],
  allowed: ReadonlySet<string>,
): string[] {
  const created = ddlCreatedObjects(sqlTexts)
  return declaredSchemaObjects(tables)
    .filter((k) => !created.has(k) && !allowed.has(k))
    .sort()
}
