// Strings check (council R2-14 / N14): every visible string a frame shows must be in users.md §2.8, and the reverse
// for the strings §2.8 marks as shown in frames. This script does the first direction mechanically.
// Usage: HTML_OUT=<dir with the rendered .html files> node strings.mjs [--all]
// It reads every frame's HTML, takes the visible text nodes and `aria-label`s, drops what is fixture data
// (names, emails, phones, numbers, handles, dates), and prints each remaining string that the spec text does not
// contain, with the frames that show it. Exit code 1 when anything is missing.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const spec = readFileSync(join(here, '../../users.md'), 'utf8').replace(/\s+/g, ' ')
const dir = process.env.HTML_OUT
if (!dir) throw new Error('HTML_OUT is required: the directory render.mjs wrote the .html files to')

// fixture people, contacts and technologies: invented data, not product strings
const FIXTURE =
  /^(@|\+?\d|https?:|0x|UA\d|[\w.+-]+@[\w.-]+$|[A-Z][A-Za-z.#+ ]{1,18}$|[\d\s%.,:+/-]+$)|example\.(com|org)/
const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
// strings owned by the foundation shell and primitives (sidebar, rail, tab bar, keyboard) are not this screen's
const foundation = readdirSync(join(here, '../../../_foundation/assets/src'))
  .filter((n) => n.endsWith('.mjs'))
  .map((n) => readFileSync(join(here, '../../../_foundation/assets/src', n), 'utf8'))
  .join('\n')
// fixture people are read from the generators themselves: every `name: '…'` entry that looks like a full name
const PEOPLE = readdirSync(here)
  .filter((n) => n.startsWith('users') && n.endsWith('.mjs'))
  .flatMap((n) => [
    ...readFileSync(join(here, n), 'utf8').matchAll(
      /['`]([А-ЯІЇЄҐ][а-яіїєґ'’ʼ]+(?:-[А-ЯІЇЄҐ][а-яіїєґ'’ʼ]+)*(?: [А-ЯІЇЄҐ][а-яіїєґ'’ʼ]+(?:-[А-ЯІЇЄҐ][а-яіїєґ'’ʼ]+)*){1,2})['`]/g,
    ),
  ])
  .map((m) => m[1])
  .sort((a, b) => b.length - a.length)
const NAME = new RegExp(PEOPLE.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
const seen = new Map()
for (const f of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
  const html = readFileSync(join(dir, f), 'utf8')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<wbr>/g, '') // a break opportunity inside one string (an email), not a text boundary
  const texts = [
    ...html.replace(/<[^>]+>/g, '\n').split('\n'),
    ...[...html.matchAll(/(?:aria-label|title|placeholder)="([^"]+)"/g)].map((m) => m[1]),
  ]
  for (const raw of texts) {
    const t = decode(raw)
      .replace(/\s+/g, ' ')
      .replace(NAME, '{name}')
      // argument values of ICU patterns that §2.8 writes once, with placeholders
      .replace(/\d{2}\.\d{2}\.\d{4}/g, '{date}')
      .replace(/\d{2}\.\d{2}\.\d{2}\b/g, '{date}') // the 360 pane's short archived date, DD.MM.YY
      .replace(/^Крок \d з 3: .*/, 'Крок {n} з 3: {title}')
      .replace(/^Крок \d з 3/, 'Крок {n} з 3')
      .replace(/^Для ролі «[^»]+»/, 'Для ролі «{role}»')
      .replace(
        /^\{name\}, (Адміністратор|Сеньйор|Джуніор|HR|Бухгалтер|Дроп)(, .*)?$/,
        '{name}, {role}',
      )
      .replace(/^Сортування: (Ім’я|Роль|Додано), .*/, 'Сортування: {key}, {direction}')
      .replace(/^Технології: .*/, 'Технології: {list}')
      .replace(
        /(пошуку|ролі|із роллю) «[^»]*»/g,
        (_, k) => `${k} «${k === 'пошуку' ? '{q}' : '{role}'}»`,
      )
      .replace(/\(\d+ проєкти: [^)]*\)/, '({n} проєкти: {list})')
      .replace(
        /^У команді \d+ HR\/бухгалтери, на її проєктах — \d+ джуніори/,
        'У команді {h} HR/бухгалтери, на її проєктах — {j} джуніори',
      )
      .replace(/чекають виплати \(\d+\)/, 'чекають виплати ({n})')
      .replace(/^[А-ЯІЇЄҐ]{2}$/, '')
      .trim()
    if (foundation.includes(t)) continue
    if (t.length < 2 || !/[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(t) || FIXTURE.test(t)) continue
    if (!seen.has(t)) seen.set(t, new Set())
    seen.get(t).add(f.replace(/\.html$/, ''))
  }
}
const missing = [...seen].filter(([t]) => !spec.includes(t))
for (const [t, fr] of missing)
  console.log(
    `${JSON.stringify(t)}  <- ${[...fr].slice(0, 3).join(', ')}${fr.size > 3 ? ` +${fr.size - 3}` : ''}`,
  )
console.log(
  `checked ${seen.size} distinct strings from the frames; not in users.md: ${missing.length}`,
)
process.exit(missing.length ? 1 : 0)
