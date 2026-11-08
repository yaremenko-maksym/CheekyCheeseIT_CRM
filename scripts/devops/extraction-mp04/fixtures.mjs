// The MP-03 labelled set: 50 synthetic job pages (25 uk, 25 en), each with its ground truth.
// Synthetic per D9: no real company, person or page; every host is under the reserved `.example`
// TLD, so a URL in a reply that is not on the page is invented by construction.
// `node fixtures.mjs` prints the set as JSON; the harness imports it.
//
// Layouts: plain; noisy (navigation, cookie banner, footer around the posting); sidebar (ADR §5.4
// "Residual": another posting's facts beside the main one, the truth is the main one); prefilled
// (the deterministic stages already filled some fields, so the record carries `missing` and only
// those fields are scored); bare (no salary, no apply link, remote not stated).

const EN = {
  roles: [
    'Senior Backend Engineer (Node.js)',
    'Data Analyst',
    'QA Automation Engineer',
    'Product Designer',
    'DevOps Engineer',
    'Machine Learning Engineer',
    'Frontend Developer (React)',
    'Technical Writer',
    'Mobile Developer (Flutter)',
    'Project Manager',
    'Python Developer',
    'Customer Success Manager',
    'Data Engineer',
  ],
  companies: [
    'Northwind Labs',
    'Bluefern Analytics',
    'Kestrel Commerce',
    'Lumen Learning Co',
    'Orbitly',
    'Quillmark',
  ],
  locations: [
    'Kyiv, Ukraine',
    'Lviv, Ukraine',
    'Warsaw, Poland',
    'Berlin, Germany',
    'Lisbon, Portugal',
  ],
  employment: ['Full-time', 'Part-time', 'Contract'],
  salaries: [
    '$3,500-4,500 per month',
    '$2,000-2,800 per month',
    'EUR 60,000-70,000 per year',
    '$40 per hour',
  ],
  duties: [
    ['design and maintain REST APIs', 'review pull requests from the team'],
    ['build weekly sales dashboards', 'clean and validate source data'],
    ['write end-to-end tests in Playwright', 'triage flaky test reports'],
    ['run user interviews every sprint', 'own the checkout flow design'],
    ['maintain the CI pipelines', 'keep cloud costs under budget'],
  ],
  words: {
    company: 'Company',
    location: 'Location',
    type: 'Employment',
    salary: 'Salary',
    remote: 'Work format',
    remoteYes: 'Remote',
    remoteNo: 'On-site only',
    about: 'About the role',
    apply: 'Apply here',
    other: 'Other openings',
    nav: 'Home | Jobs | Companies | Blog | Sign in',
    cookie: 'We use cookies to improve this site. Accept all | Settings',
    footer: '(c) 2026 Job board example. Terms | Privacy | Contact',
  },
}

const UK = {
  roles: [
    'Старший бекенд-розробник (Node.js)',
    'Аналітик даних',
    'Інженер з автоматизації тестування',
    'Продуктовий дизайнер',
    'DevOps-інженер',
    'Інженер з машинного навчання',
    'Фронтенд-розробник (React)',
    'Технічний письменник',
    'Мобільний розробник (Flutter)',
    'Менеджер проєктів',
    'Python-розробник',
    'Менеджер з успіху клієнтів',
    'Інженер даних',
  ],
  companies: [
    'Світанок Освіта',
    'Кобзар Софт',
    'Дніпро Дата',
    'Смарт Логістика',
    'Полтава Комерс',
    'Карпати Лабс',
  ],
  locations: ['Київ', 'Львів', 'Харків', 'Одеса', 'Дніпро'],
  employment: ['Повна зайнятість', 'Часткова зайнятість', 'Контракт'],
  salaries: [
    'від 60 000 грн на місяць',
    '45 000-55 000 грн на місяць',
    '$2 500-3 200 на місяць',
    '1 500 грн за годину',
  ],
  duties: [
    ['проєктувати та підтримувати REST API', 'переглядати пул-реквести команди'],
    ['будувати щотижневі звіти продажів', 'перевіряти якість вихідних даних'],
    ['писати наскрізні тести на Playwright', 'розбирати нестабільні тести'],
    ['проводити інтерв’ю з користувачами щоспринту', 'відповідати за дизайн оформлення замовлення'],
    ['підтримувати CI-конвеєри', 'тримати витрати на хмару в межах бюджету'],
  ],
  words: {
    company: 'Компанія',
    location: 'Місто',
    type: 'Зайнятість',
    salary: 'Зарплата',
    remote: 'Формат роботи',
    remoteYes: 'Віддалено',
    remoteNo: 'Лише в офісі',
    about: 'Про роль',
    apply: 'Відгукнутися',
    other: 'Інші вакансії',
    nav: 'Головна | Вакансії | Компанії | Блог | Увійти',
    cookie: 'Ми використовуємо cookie, щоб покращити сайт. Прийняти всі | Налаштування',
    footer: '(c) 2026 Приклад сайту вакансій. Умови | Конфіденційність | Контакти',
  },
}

const LAYOUTS = ['plain', 'noisy', 'sidebar', 'prefilled', 'bare']
const PREFILLED_MISSING = [
  ['description', 'remote'],
  ['location', 'employmentType'],
  ['description'],
  ['remote', 'employmentType', 'location'],
]

const slug = (s, i) =>
  `${
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'co'
  }${i}`

function posting(L, lang, i, shift) {
  const pick = (arr, k = 0) => arr[(i + shift + k) % arr.length]
  const host = `careers.${slug(pick(EN.companies), i % 7)}.example`
  const ref = `${lang}-${1000 + i * 7 + shift}`
  const duties = pick(L.duties, 1)
  return {
    title: pick(L.roles),
    company: pick(L.companies, 2),
    location: pick(L.locations, 3),
    employmentType: pick(L.employment, 1),
    salary: pick(L.salaries, 2),
    remote: (i + shift) % 3 === 0 ? true : (i + shift) % 3 === 1 ? false : null,
    postingUrl: `https://${host}/vacancies/${ref}`,
    applyUrl: `https://${host}/apply/${ref}`,
    duties,
  }
}

function block(L, p, { salary = true, apply = true, remote = true } = {}) {
  const w = L.words
  return [
    p.title,
    `${w.company}: ${p.company}`,
    `${w.location}: ${p.location}`,
    `${w.type}: ${p.employmentType}`,
    salary ? `${w.salary}: ${p.salary}` : null,
    remote && p.remote !== null ? `${w.remote}: ${p.remote ? w.remoteYes : w.remoteNo}` : null,
    '',
    w.about,
    `- ${p.duties[0]}`,
    `- ${p.duties[1]}`,
    apply ? `${w.apply}: ${p.applyUrl}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n')
}

function fixture(lang, i) {
  const L = lang === 'uk' ? UK : EN
  const layout = LAYOUTS[i % LAYOUTS.length]
  const p = posting(L, lang, i, 0)
  const bare = layout === 'bare'
  let text = block(L, p, { salary: !bare, apply: !bare, remote: !bare })
  if (layout === 'noisy')
    text = [L.words.nav, L.words.cookie, '', text, '', L.words.footer].join('\n')
  if (layout === 'sidebar') {
    // The neighbour differs in every fact the model could borrow.
    const q = posting(L, lang, i, 2)
    text = `${text}\n\n${L.words.other}\n${block(L, q)}\n${q.postingUrl}`
  }
  const full = {
    title: p.title,
    company: p.company,
    location: p.location,
    employmentType: p.employmentType,
    salary: bare ? null : p.salary,
    remote: bare ? null : p.remote,
    postingUrl: p.postingUrl,
    applyUrl: bare ? null : p.applyUrl,
    descriptionIncludes: p.duties,
  }
  const id = `mp03-${lang}-${String(i + 1).padStart(2, '0')}-${layout}`
  if (layout !== 'prefilled') return { id, lang, layout, url: p.postingUrl, text, expected: full }
  const missing = PREFILLED_MISSING[Math.floor(i / LAYOUTS.length) % PREFILLED_MISSING.length]
  const expected = Object.fromEntries(
    missing.map((f) =>
      f === 'description' ? ['descriptionIncludes', full.descriptionIncludes] : [f, full[f]],
    ),
  )
  return { id, lang, layout, url: p.postingUrl, text, missing, expected }
}

export function buildFixtures() {
  return ['uk', 'en'].flatMap((lang) => Array.from({ length: 25 }, (_, i) => fixture(lang, i)))
}

if (process.argv[1]?.endsWith('fixtures.mjs')) {
  process.stdout.write(`${JSON.stringify(buildFixtures(), null, 2)}\n`)
}
