#!/usr/bin/env node
// Сверяет каталог project-local скиллов в rules/common/skills-invocation.md
// с тем, что реально лежит в .claude/skills/.
//
// Зачем. 2026-07-28: mandatory-триггер предписывал `superpowers:security-review`,
// которого нет в установленном паке. Триггер был невыполним ровно на тех PR
// (finance / auth), которые он и должен защищать, а сломанные ссылки успели
// расползтись по семи файлам. Отказ был молчаливым: `Skill` падал в рантайме
// живого диспатча, и это никем не считалось.
//
// Что проверяется (только project-local — см. «Область» ниже):
//   1. каждый каталог .claude/skills/<name>/ имеет SKILL.md;
//   2. frontmatter несёт `name`, и он совпадает с именем каталога;
//   3. frontmatter несёт непустой `when_to_use`;
//   4. каждый скилл с диска присутствует в каталоге skills-invocation.md;
//   5. каждая строка каталога соответствует существующему скиллу.
//
// Область. Ссылки вида `<pack>:<skill>` (`superpowers:brainstorming`) НЕ
// проверяются: у CI-раннера нет ~/.claude/plugins оператора, поэтому проверить
// их машинно невозможно. Для них остаётся процедурная сверка, описанная в
// skills-invocation.md §«Дрейф таблицы относительно установленных паков».
//
// Использование:
//   node scripts/architect/check-skill-registry.mjs           # отчёт, exit 1 при расхождении
//   node scripts/architect/check-skill-registry.mjs --list     # просто перечислить скиллы с диска

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS_DIR = '.claude/skills'
const REGISTRY = '.claude/rules/common/skills-invocation.md'
const SECTION = 'Project-local skills'

const listOnly = process.argv.includes('--list')
const problems = []

// --- что на диске ----------------------------------------------------------
if (!existsSync(SKILLS_DIR)) {
  console.error(`Нет каталога ${SKILLS_DIR}`)
  process.exit(1)
}

const onDisk = new Map()
for (const name of readdirSync(SKILLS_DIR).sort()) {
  const dir = join(SKILLS_DIR, name)
  if (!statSync(dir).isDirectory()) continue
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) {
    problems.push(`${name}: каталог есть, SKILL.md нет`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) {
    problems.push(`${name}: SKILL.md без YAML-frontmatter`)
    continue
  }
  const block = fm[1]
  const declared = block
    .match(/^name:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
  const whenToUse = block.match(/^when_to_use:\s*(.+)$/m)?.[1]?.trim()

  if (!declared) problems.push(`${name}: во frontmatter нет поля name`)
  else if (declared !== name) {
    problems.push(`${name}: frontmatter name = «${declared}», не совпадает с именем каталога`)
  }
  if (!whenToUse || whenToUse.replace(/^['"]|['"]$/g, '').length === 0) {
    problems.push(`${name}: нет when_to_use — skill-loader не сможет авто-инвоукать по триггеру`)
  }
  onDisk.set(name, { declared, whenToUse })
}

if (listOnly) {
  for (const name of onDisk.keys()) console.log(name)
  process.exit(0)
}

// --- что в каталоге правил -------------------------------------------------
if (!existsSync(REGISTRY)) {
  console.error(`Нет файла каталога ${REGISTRY}`)
  process.exit(1)
}

const registryText = readFileSync(REGISTRY, 'utf8')
const lines = registryText.split('\n')
const start = lines.findIndex((l) => l.startsWith('#') && l.includes(SECTION))
if (start === -1) {
  console.error(`В ${REGISTRY} не найден раздел «${SECTION}»`)
  process.exit(1)
}
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## ')) {
    end = i
    break
  }
}

const inRegistry = new Set()
for (const line of lines.slice(start, end)) {
  if (!line.trimStart().startsWith('|')) continue
  const first = line.split('|')[1]?.trim() ?? ''
  const m = first.match(/^`([a-z0-9-]+)`$/) // только безпрефиксные: <pack>:<skill> вне области
  if (m) inRegistry.add(m[1])
}

// --- сверка ----------------------------------------------------------------
for (const name of onDisk.keys()) {
  if (!inRegistry.has(name)) {
    problems.push(`${name}: есть на диске, но отсутствует в каталоге ${REGISTRY} (§${SECTION})`)
  }
}
for (const name of inRegistry) {
  if (!onDisk.has(name)) {
    problems.push(`${name}: указан в каталоге ${REGISTRY}, но на диске такого скилла нет`)
  }
}

// --- отчёт -----------------------------------------------------------------
console.log(`Скиллов на диске: ${onDisk.size} · строк в каталоге: ${inRegistry.size}`)

if (problems.length === 0) {
  console.log('Каталог и диск совпадают.')
  process.exit(0)
}

console.error(`\nРасхождений: ${problems.length}`)
for (const p of problems) console.error(`  ✗ ${p}`)
console.error(
  `\nПочинить: привести в соответствие ${REGISTRY} (раздел «${SECTION}») и содержимое ${SKILLS_DIR}/.`,
)
process.exit(1)
