/**
 * Deterministic vacancy role classifier: research `2026-11-16-it-role-taxonomy.md` §3.1 steps 1–9,
 * §3.2 hints and §3.3 non-role words. The patterns are a port of the research Appendix A scratch
 * classifier (what the dry run executed), so every trap of §3.4 is a keyword or a rule here.
 *
 * Port notes: Python 3 `\b` / `\w` / `\W` are Unicode-aware, JS ones are ASCII-only, so `rx`
 * rewrites them to Unicode letter/digit classes (Cyrillic titles depend on it). Every role keyword is
 * bounded on the left (`backend` matches "backends"), as in the run, but by a Unicode letter or
 * digit where the run used ASCII `(?<![a-z0-9])`; for a keyword that opens with `\b` the extra
 * bound changes nothing. Deviations from the run, each pinned by a fixture row: `автотест` (QA
 * automation), Cyrillic engineer + security domain → SECURITY_ENGINEER, `go to` is not Go, an
 * architect re-adds back-end as well as front-end, `cybersecurity analyst` (the analyst counterpart
 * of `cybersecurity engineer`), the spelled-out chief technology / technical officer as a job noun,
 * and the Cyrillic architect keywords (research §1.10 uk label «Архітектор ПЗ») with the Cyrillic
 * landscape / interior / building architect (and designer-architect, feminine forms) excluded. Keywords the appendix could never fire are
 * dropped without a change in result: those another keyword of the same role already covers
 * (`бекенд` ⊂ `бек[\s-]?енд`) and the Cyrillic CTO keywords, which no job noun admits ("директор" is
 * not one, so "Технічний директор" stays unclassified as in the run).
 */
import { sortRoles, type TechnicalRole } from '@crm/shared'

/**
 * A bump is a visibility-bearing deploy action, not a constant edit (SR-L-2): the reconciliation
 * sweep re-enqueues every OPEN/UNKNOWN opportunity at once and `deriveOpportunityRoles` re-answers
 * each from the rule, then from an AI cache filtered to this version — which a fresh bump leaves
 * empty. So every row the new rule does not classify becomes `role_status = 'PENDING'` with no
 * roles, and is hidden in every scope until the AI pass answers it, which needs
 * `JOB_ROLE_AI_ENABLED` (default off) and is paced by `JOB_ROLE_AI_DAILY_BUDGET`. Pair a bump with
 * either copying `job_role_classifications` rows forward under the new version, or an accepted
 * recovery window; watch `SELECT role_status, count(*) FROM job_opportunities GROUP BY 1`.
 * rc.2 (foreign developer nouns) was bumped without copy-forward: every rc.1 AI answer was irrelevant.
 * The role-scope gate (`role-scope-gate.ts`) reads these lists too, so a change to them bumps the version.
 */
export const ROLE_CLASSIFIER_VERSION = 'rc.2'

export type RoleClassification =
  { kind: 'ROLES'; roles: readonly TechnicalRole[] } | { kind: 'NON_IT' } | { kind: 'UNCLASSIFIED' }

const W = String.raw`[\p{L}\p{N}_]`
const WORD_BOUNDARY = String.raw`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`

/** Compiles a Python-flavoured pattern with Unicode `\b` / `\w` / `\W`. */
const rx = (pattern: RegExp): RegExp =>
  new RegExp(
    pattern.source
      .replace(/\\b/g, WORD_BOUNDARY)
      .replace(/\\w/g, W)
      .replace(/\\W/g, String.raw`[^\p{L}\p{N}_]`),
    'u',
  )

/**
 * A keyword bounded on the left only: `backend` matches "backends". The bound is Unicode, so
 * `мобільн` does not fire inside "автомобільний" (the run's `(?<![a-z0-9])` was ASCII-only).
 */
const keyword = (pattern: RegExp): RegExp => rx(new RegExp(String.raw`(?<!\w)` + pattern.source))

type SpecificRole = Exclude<TechnicalRole, 'SOFTWARE_ENGINEER'>

const ROLE_PATTERNS: Record<SpecificRole, readonly RegExp[]> = {
  BACKEND_ENGINEER: [
    /back[\s-]?end/,
    /server[\s-]side/,
    /api (developer|engineer)/,
    /integration (developer|engineer)/,
    /бек[\s-]?енд/,
    /бэк[\s-]?енд/,
  ],
  FRONTEND_ENGINEER: [
    /front[\s-]?end/,
    /ui (developer|engineer)/,
    /web ui/,
    /html\W?css/,
    /markup/,
    /layout designer/,
    /верстальщик/,
    /верстальник/,
    /фронт[\s-]?енд/,
  ],
  FULLSTACK_ENGINEER: [/full[\s-]?stack/, /фулл?[\s-]?стек/],
  DESKTOP_ENGINEER: [/desktop/, /wpf/, /winforms/, /qt developer/],
  BUSINESS_APPLICATIONS_ENGINEER: [
    /salesforce/,
    /\bsap\b/,
    /abap/,
    /\berp\b/,
    /\bcrm developer/,
    /dynamics 365/,
    /ms dynamics/,
    /odoo/,
    /\b1c\b/,
    /1с\b/,
    /servicenow/,
    /netsuite/,
    /no[\s-]?code/,
    /low[\s-]?code/,
    /power platform/,
    /hubspot developer/,
  ],
  IOS_ENGINEER: [/\bios\b/, /swift(ui)?\b/, /macos/],
  ANDROID_ENGINEER: [/android/],
  CROSS_PLATFORM_MOBILE_ENGINEER: [
    /flutter/,
    /react native/,
    /xamarin/,
    /\bmaui\b/,
    /kotlin multiplatform/,
    /\bkmp\b/,
    /cross[\s-]?platform mobile/,
    /mobile (developer|engineer)/,
    /мобільн/,
    /мобильн/,
  ],
  DATA_ENGINEER: [
    /data engineer/,
    /big data/,
    /\betl\b/,
    /data platform engineer/,
    /analytics engineer/,
    /data warehouse/,
    /dwh/,
    /spark developer/,
    /інженер даних/,
    /инженер данных/,
  ],
  DATABASE_ENGINEER: [
    /\bdba\b/,
    /database (administrator|engineer|developer|architect)/,
    /sql developer/,
    /pl\/?sql/,
    /postgres(ql)? (dba|engineer)/,
    /адміністратор баз/,
    /администратор баз/,
  ],
  DATA_ANALYST: [
    /data analyst/,
    /\bbi (developer|analyst|engineer)/,
    /business intelligence/,
    /power bi/,
    /tableau/,
    /product analyst/,
    /web analyst/,
    /аналітик даних/,
    /аналитик данных/,
  ],
  DATA_SCIENTIST: [
    /data scien/,
    /statistician/,
    /quantitative (analyst|researcher)/,
    /research scientist/,
  ],
  ML_ENGINEER: [
    /machine learning/,
    /\bml\b/,
    /mlops/,
    /deep learning/,
    /computer vision/,
    /\bcv engineer/,
    /\bnlp\b/,
    /applied scientist/,
    /ml\/ai/,
    /ai\/ml/,
  ],
  AI_ENGINEER: [
    /\bai engineer/,
    /\bai developer/,
    /\bllm\b/,
    /genai/,
    /generative ai/,
    /prompt engineer/,
    /\brag\b/,
    /ai agent/,
    /agentic/,
    /ai (application|solutions) (engineer|developer)/,
    /artificial intelligence engineer/,
  ],
  DEVOPS_ENGINEER: [
    /devops/,
    /dev ops/,
    /cloudops/,
    /platform engineer/,
    /cloud engineer/,
    /infrastructure engineer/,
    /kubernetes/,
    /release engineer/,
    /build engineer/,
    /devsecops/,
    /девопс/,
  ],
  SITE_RELIABILITY_ENGINEER: [
    /\bsre\b/,
    /site reliability/,
    /reliability engineer/,
    /production engineer/,
    /observability engineer/,
  ],
  SYSTEM_ADMINISTRATOR: [
    /it systems engineer/,
    /it infrastructure engineer/,
    /windows engineer/,
    /linux engineer/,
    /sys\s?admin/,
    /system(s)? administrator/,
    /linux administrator/,
    /windows administrator/,
    /it administrator/,
    /системн\w* адміністратор/,
    /системн\w* администратор/,
    /сисадмін/,
    /сисадмин/,
  ],
  NETWORK_ENGINEER: [
    /network (engineer|administrator|architect)/,
    /\bnoc\b/,
    /telecom(munications)? engineer/,
    /мережев/,
    /сетев/,
  ],
  SUPPORT_ENGINEER: [
    /support engineer/,
    /application support/,
    /technical support/,
    /\bl[23] support/,
    /tech support/,
    /it support/,
    /help\s?desk/,
    /service desk/,
  ],
  QA_ENGINEER: [
    /\bqa\b/,
    /quality assurance/,
    /tester/,
    /test engineer/,
    /manual test/,
    /тестувальник/,
    /тестировщик/,
    /тестуван/,
    /тестирован/,
  ],
  QA_AUTOMATION_ENGINEER: [
    /qa automation/,
    /automation qa/,
    /aqa/,
    /test automation/,
    /automated test/,
    /automation (test|tester|engineer)/,
    /\bsdet\b/,
    /software development engineer in test/,
    /performance test/,
    /load test/,
    /автотест/,
  ],
  SECURITY_ENGINEER: [
    /security engineer/,
    /appsec/,
    /application security/,
    /devsecops/,
    /cloud security/,
    /product security/,
    /cybersecurity engineer/,
    /security architect/,
    /information security/,
    // an engineer noun + a security domain, in either order (research §1.6 uk label «Інженер з кібербезпеки»)
    /(?=.*інженер).*(кібербезпек|інформаційн\w* безпек)/,
    /(?=.*инженер).*(кибербезопасн|информационн\w* безопасн)/,
  ],
  SECURITY_ANALYST: [
    /security analyst/,
    /cybersecurity analyst/,
    /\bsoc\b/,
    /incident respon/,
    /threat (intel|hunt)/,
    /\bgrc\b/,
    /security operations/,
    /digital forensic/,
    /кібербезпек/,
    /кибербезопасн/,
    /інформаційн\w* безпек/,
    /информационн\w* безопасн/,
  ],
  PENETRATION_TESTER: [
    /penetration test/,
    /pen[\s-]?test/,
    /ethical hack/,
    /red team/,
    /offensive security/,
    /bug bounty/,
  ],
  EMBEDDED_ENGINEER: [
    /embedded/,
    /firmware/,
    /\brtos\b/,
    /\biot\b/,
    /robotics/,
    /microcontroller/,
    /\bmcu\b/,
    /вбудован/,
    /встроен/,
  ],
  HARDWARE_ENGINEER: [
    /hardware engineer/,
    /electronics engineer/,
    /\bpcb\b/,
    /fpga/,
    /\basic\b/,
    /chip design/,
    /\bvlsi\b/,
    /\brf engineer/,
    /verilog/,
    /vhdl/,
    /schematic/,
  ],
  GAME_DEVELOPER: [
    /game (developer|programmer|engineer)/,
    /gameplay/,
    /unity (developer|engineer)/,
    /unreal/,
    /\bue[45]\b/,
    /graphics (programmer|engineer)/,
    /rendering engineer/,
    /\bxr\b/,
    /\bar\/vr\b/,
    /\bvr developer/,
    /gamedev/,
    /геймдев/,
  ],
  BLOCKCHAIN_ENGINEER: [
    /blockchain/,
    /solidity/,
    /smart contract/,
    /web3/,
    /\bdefi\b/,
    /crypto (developer|engineer)/,
    /\bevm\b/,
    /rust (blockchain|solana)/,
    /solana/,
  ],
  // research §1.10 uk label «Архітектор ПЗ»
  SOFTWARE_ARCHITECT: [/architect/, /архітектор/, /архитектор/],
  ENGINEERING_MANAGER: [
    /engineering manager/,
    /head of (engineering|development|software|r&d)/,
    /director of engineering/,
    /engineering director/,
    /(?<!business )development manager/,
    /manager,? engineering/,
    /r&d manager/,
    /\bvp,? (of )?engineering/,
    /delivery head/,
  ],
  CTO: [
    /\bcto\b/,
    /head of technology/,
    /vp,? (of )?technology/,
    /chief technology officer/,
    /chief technical officer/,
  ],
  BUSINESS_ANALYST: [
    /business analyst/,
    /systems analyst/,
    /system analyst/,
    /\bba\b/,
    /бізнес[\s-]?аналітик/,
    /бизнес[\s-]?аналитик/,
    /системн\w* аналітик/,
    /системн\w* аналитик/,
  ],
  UI_UX_DESIGNER: [
    /ui\/?ux/,
    /ux\/?ui/,
    /product designer/,
    /ux designer/,
    /ui designer/,
    /interaction designer/,
    /ux research/,
    /дизайнер інтерфейс/,
    /дизайнер интерфейс/,
  ],
}

const ROLE_KEYWORDS = (Object.entries(ROLE_PATTERNS) as [SpecificRole, readonly RegExp[]][]).map(
  ([role, patterns]) => ({ role, patterns: patterns.map(keyword) }),
)

/**
 * rc.2: non-English developer nouns (de / fr / es / it / nl / pl). German / Dutch `entwickler` /
 * `ontwikkelaar` count only as a separate word or after an allowlisted software prefix
 * (`softwareentwickler`, `webentwickler`, `ki-entwickler`, `softwareontwikkelaar`); a compound with any
 * other prefix (`personal`, `immobilien`, `projekt`, `projectontwikkelaar`) is no developer noun. The
 * Romance nouns (`développeur`, `desarrollador`, `sviluppatore`) are vetoed only by a business /
 * real-estate qualifier immediately after the noun (`développeur foncier`, `desarrollador de negocios`),
 * so `développeur java - projets innovants` still matches. Guards live here, not in `EXCLUDE_*` (which
 * would make the title NON_IT).
 */
const FOREIGN_DEV_NOUN = String.raw`((?:(?<!\w)|(?<=software|applikations|anwendungs|web|app|ki|spiele|game|datenbank))(?<!(hardware|elektronik|projekt|produkt|personal|organisations|immobilien|stadt|geschäftsfeld)[\s-])entwickler|softwareentwicklung|(d[ée]veloppeu(r|se)|desarrollador|sviluppat(ore|rice))(?!(\.?e?se|\(se\))?\W+((de|del|di)\W+|d['’])?(immobili|inmobili|foncier|nouveaux|projets?\b|progett|proyectos?\b|commercial|comercial|affaires|negocio|business|territo|vendite|ventas))|(?:(?<!\w)|(?<=software|applicatie|web|app))ontwikkelaar|programist(a|ka))`
/** Appends the foreign developer nouns to an alternation-group noun pattern. */
const withForeignNouns = (pattern: RegExp): RegExp =>
  rx(new RegExp(String.raw`${pattern.source}|${FOREIGN_DEV_NOUN}`))

export const GENERIC_KEYWORDS: readonly RegExp[] = [
  /software (engineer|developer)/,
  /\bswe\b/,
  /product engineer/,
  /programmer/,
  /developer/,
  /\bdev\b/,
  /engineer/,
  /розробник/,
  /разработчик/,
  /програміст/,
  /программист/,
]
  .map(keyword)
  .concat(rx(new RegExp(FOREIGN_DEV_NOUN)))
const GENERIC_NOUN = withForeignNouns(
  /(software|developer|programmer|розробник|разработчик|програміст|программист|\bswe\b)/,
)

const EXCLUDE_PHRASE = rx(
  /\b(aso|sales engineer|solutions engineer|presales|pre-sales|business development|sales (manager|representative|executive|lead|specialist)|account (executive|manager)|recruiter|recruiting|talent acquisition|hr (manager|business partner|generalist)|marketing (manager|specialist|lead)|seo (specialist|manager)|copywriter|customer (success|support|service)|accountant|finance manager|product manager|project manager|delivery manager|product owner|scrum master|lawyer|landscape architect|ландшафтн\w* (архітектор|архитектор)\w*|(архітектор|архитектор)\w*\W(інтер\Sєр|интерьер|будів|здани)\w*|(архітектор|архитектор)\w*\W(проєктувальн|проектировщ|дизайнер)\w*(?=\W*$)|interior architect|building architect)\b/,
)
const EXCLUDE_BARE = rx(/\b(sales|marketing|recruit\w*|hr|legal|seo|finance)\b/)
const ENG_NOUN = withForeignNouns(
  /(developer|engineer|programmer|architect|devops|\bqa\b|tester|scientist|analyst|administrator|\bsre\b|\bdba\b|розробник|разработчик|програміст|программист|інженер|инженер)/,
)
const JOB_NOUN = withForeignNouns(
  /(developer|engineer|programmer|architect|designer|analyst|administrator|admin\b|tester|\bqa\b|aqa|sdet|scientist|\bdba\b|\bsre\b|devops|pentester|hacker|\bcto\b|chief technology officer|chief technical officer|head of|director|vp\b|development manager|r&d manager|lead\b|specialist|expert|consultant|researcher|\bdev\b|розробник|разработчик|програміст|программист|тестувальник|тестировщик|адміністратор|администратор|аналітик|аналитик|архітектор|архитектор|дизайнер|інженер|инженер|сисадм|верстальщик|верстальник)/,
)
/** A Cyrillic engineer title with no analyst noun (either script): the security engineer, not the analyst. */
const CYRILLIC_ENGINEER = rx(/^(?!.*(аналіт|аналит|analyst)).*(інженер|инженер)/)
const AI_FOCUS = rx(/\b(llm|genai|generative|agent|rag|prompt)/)
const HINT_NOUN = withForeignNouns(
  /(developer|engineer|programmer|розробник|разработчик|програміст|программист|dev\b|lead\b)/,
)

/**
 * §3.2 tech hints, first match wins. Deviation from Appendix A: there `\bc#\b` and `\b\.net` never
 * match (`#` and `.` are not word characters), so C# / .NET fell through to SOFTWARE_ENGINEER; the
 * §3.2 table names them backend, so they get their own bounds here.
 */
export const TECH_HINTS: readonly { pattern: RegExp; role: TechnicalRole | null }[] = [
  {
    pattern: rx(
      /\b(java|golang|go(?![\s\p{Pd}]+to\b)|python|php|ruby|rails|scala|elixir|rust|node\.?js|nestjs|django|laravel|spring)\b/u,
    ),
    role: 'BACKEND_ENGINEER',
  },
  { pattern: rx(/(?<!\w)c#|\.net(?!\w)/), role: 'BACKEND_ENGINEER' },
  { pattern: rx(/\b(magento|shopify|wordpress|drupal|bitrix)\b/), role: 'FULLSTACK_ENGINEER' },
  {
    pattern: rx(/\b(react|angular|vue|svelte|next\.?js|javascript|typescript|js)\b/),
    role: 'FRONTEND_ENGINEER',
  },
  // Ambiguous (backend / embedded / game / desktop): no role, the generic fallback decides.
  { pattern: rx(/(c\+\+|\bkotlin\b)/), role: null },
]

const ARCHITECT_DOMAINS: readonly { pattern: RegExp; role: TechnicalRole }[] = [
  { pattern: rx(/\bdata\b/), role: 'DATA_ENGINEER' },
  { pattern: rx(/(cloud|infrastructure|devops|platform)/), role: 'DEVOPS_ENGINEER' },
  { pattern: rx(/security/), role: 'SECURITY_ENGINEER' },
  { pattern: rx(/network/), role: 'NETWORK_ENGINEER' },
  { pattern: rx(/\b(ml|ai|machine learning)\b/), role: 'ML_ENGINEER' },
  { pattern: rx(/\b(salesforce|sap|erp|crm)\b/), role: 'BUSINESS_APPLICATIONS_ENGINEER' },
  // re-add FRONTEND / BACKEND after fullstack precedence dropped them; the run re-added only
  // front-end, and §3.4 states no outcome for a "Frontend/Backend Architect"
  { pattern: rx(/(front[\s-]?end)/), role: 'FRONTEND_ENGINEER' },
  { pattern: rx(/(back[\s-]?end)/), role: 'BACKEND_ENGINEER' },
  { pattern: rx(/mobile/), role: 'CROSS_PLATFORM_MOBILE_ENGINEER' },
]

/**
 * Step 9: board categories that are `eq` to one role (research §1 DOU / Djinni / WWR / Remotive
 * cells), matched trimmed and case-insensitively. Left out on purpose: values that are `eq` on one
 * board but a `hint` or a broader parent on another (`JavaScript`, `QA`, `Security`, `Support`,
 * `Design`), and technology tags that name no role (`SQL`, `Kotlin`, `C++`).
 */
// a Map, not an object: a tag like `constructor` must not read an `Object.prototype` member
export const EQ_BOARD_CATEGORIES: ReadonlyMap<string, TechnicalRole> = new Map(
  (
    [
      ['SOFTWARE_ENGINEER', ['software-development']],
      ['BACKEND_ENGINEER', ['remote-back-end-programming-jobs']],
      ['FRONTEND_ENGINEER', ['Front End', 'remote-front-end-programming-jobs']],
      ['FULLSTACK_ENGINEER', ['Fullstack', 'remote-full-stack-programming-jobs']],
      ['DESKTOP_ENGINEER', ['Dotnet Desktop', 'WPF', 'WinForms']],
      [
        'BUSINESS_APPLICATIONS_ENGINEER',
        ['ERP/CRM', 'ERP', 'Salesforce', 'SAP', 'No-code', 'No Code', 'MS Dynamics', 'Odoo'],
      ],
      ['IOS_ENGINEER', ['iOS', 'iOS/macOS']],
      ['ANDROID_ENGINEER', ['Android']],
      [
        'CROSS_PLATFORM_MOBILE_ENGINEER',
        ['Flutter', 'React Native', 'Dotnet Mobile', 'MAUI', 'Xamarin'],
      ],
      ['DATA_ENGINEER', ['Data Engineer', 'Big Data']],
      ['DATABASE_ENGINEER', ['DBA']],
      ['DATA_ANALYST', ['Data Analyst', 'Web Analyst']],
      ['DATA_SCIENTIST', ['Data Science']],
      ['ML_ENGINEER', ['AI/ML', 'Machine Learning', 'ML AI']],
      ['DEVOPS_ENGINEER', ['DevOps']],
      ['SITE_RELIABILITY_ENGINEER', ['SRE']],
      ['SYSTEM_ADMINISTRATOR', ['SysAdmin']],
      ['QA_AUTOMATION_ENGINEER', ['QA Automation']],
      ['SECURITY_ENGINEER', ['Information Security']],
      ['SECURITY_ANALYST', ['Security Analyst']],
      ['PENETRATION_TESTER', ['Penetration Tester']],
      ['EMBEDDED_ENGINEER', ['Embedded', 'Firmware Engineer', 'Robotics Engineer']],
      [
        'HARDWARE_ENGINEER',
        [
          'Hardware',
          'ASIC / Chip Design',
          'FPGA Engineer',
          'Hardware Engineer',
          'RF Engineer',
          'Electronics / PCB Design',
        ],
      ],
      [
        'GAME_DEVELOPER',
        [
          'Unity',
          'Unreal Engine',
          'Game Developer',
          'Unity Developer',
          'Unreal Developer',
          '.NET Gamedev',
        ],
      ],
      ['BLOCKCHAIN_ENGINEER', ['Blockchain']],
      ['SOFTWARE_ARCHITECT', ['Architect']],
      ['ENGINEERING_MANAGER', ['Engineering Manager']],
      ['CTO', ['CTO']],
      ['BUSINESS_ANALYST', ['Business Analyst']],
      ['UI_UX_DESIGNER', ['Product Design', 'UI UX', 'UX Research']],
    ] as const
  ).flatMap(([role, categories]) => categories.map((c) => [c.toLowerCase(), role] as const)),
)

/** Step 1: an excluded role phrase, or a bare domain word with no engineering noun. */
function isExcluded(t: string): boolean {
  return EXCLUDE_PHRASE.test(t) || (EXCLUDE_BARE.test(t) && !ENG_NOUN.test(t))
}

/** Step 3: every specific role whose keyword matches. */
function collectRoles(t: string): TechnicalRole[] {
  return ROLE_KEYWORDS.filter(({ patterns }) => patterns.some((p) => p.test(t))).map((k) => k.role)
}

/** Step 4: drop the less specific role. */
function applyPrecedence(t: string, hits: TechnicalRole[]): TechnicalRole[] {
  const has = (r: TechnicalRole) => hits.includes(r)
  const drop = new Set<TechnicalRole>()
  if (has('QA_AUTOMATION_ENGINEER') || has('PENETRATION_TESTER')) drop.add('QA_ENGINEER')
  if (has('FULLSTACK_ENGINEER')) {
    drop.add('FRONTEND_ENGINEER')
    drop.add('BACKEND_ENGINEER')
  }
  if (has('AI_ENGINEER') && AI_FOCUS.test(t)) drop.add('ML_ENGINEER')
  if (has('SECURITY_ENGINEER') && CYRILLIC_ENGINEER.test(t)) drop.add('SECURITY_ANALYST')
  return hits.filter((r) => !drop.has(r))
}

/** Step 6: an architect also gets the domain role its title names. */
function addArchitectDomains(t: string, hits: TechnicalRole[]): TechnicalRole[] {
  if (!hits.includes('SOFTWARE_ARCHITECT')) return hits
  const domains = ARCHITECT_DOMAINS.filter(({ pattern }) => pattern.test(t)).map((d) => d.role)
  return [...new Set([...hits, ...domains])]
}

/** Step 4 (last bullet): an engineering-manager or CTO vacancy keeps only the leadership role. */
function keepLeadership(hits: TechnicalRole[]): TechnicalRole[] {
  const leadership = hits.filter((r) => r === 'ENGINEERING_MANAGER' || r === 'CTO')
  return leadership.length > 0 ? leadership : hits
}

/** Steps 7–8: a tech hint, then the generic software fallback; only when no role matched. */
function fallbackRole(t: string): TechnicalRole | null {
  if (HINT_NOUN.test(t)) {
    const hint = TECH_HINTS.find(({ pattern }) => pattern.test(t))
    if (hint?.role) return hint.role
  }
  return GENERIC_KEYWORDS.some((p) => p.test(t)) && GENERIC_NOUN.test(t)
    ? 'SOFTWARE_ENGINEER'
    : null
}

/** Steps 2–8 on the lower-cased title. */
function rolesFromTitle(t: string): TechnicalRole[] {
  if (!JOB_NOUN.test(t)) return []
  const hits = keepLeadership(addArchitectDomains(t, applyPrecedence(t, collectRoles(t))))
  if (hits.length > 0) return hits
  const fallback = fallbackRole(t)
  return fallback ? [fallback] : []
}

/** Step 9: roles from `eq` board categories; SOFTWARE_ENGINEER only when nothing else is named. */
function rolesFromBoard(tags: readonly string[]): TechnicalRole[] {
  const found = new Set(
    tags.flatMap((tag) => EQ_BOARD_CATEGORIES.get(tag.trim().toLowerCase()) ?? []),
  )
  if (found.size > 1) found.delete('SOFTWARE_ENGINEER')
  return [...found]
}

/** `tags` = the opportunity's `stack_keywords` (provider categories and departments land there). */
export function classifyRoles(input: {
  title: string
  tags: readonly string[]
}): RoleClassification {
  const t = input.title.toLowerCase()
  if (isExcluded(t)) return { kind: 'NON_IT' }
  const fromTitle = rolesFromTitle(t)
  // SOFTWARE_ENGINEER never comes with another role, so "generic" = empty or exactly [SOFTWARE_ENGINEER]
  const generic = fromTitle.every((role) => role === 'SOFTWARE_ENGINEER')
  const fromBoard = generic ? rolesFromBoard(input.tags) : []
  const roles = fromBoard.length > 0 ? fromBoard : fromTitle
  return roles.length > 0 ? { kind: 'ROLES', roles: sortRoles(roles) } : { kind: 'UNCLASSIFIED' }
}
