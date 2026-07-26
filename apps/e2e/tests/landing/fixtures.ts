/**
 * apps/e2e/tests/landing/fixtures.ts — task-landing-e2e-in-ci.md КОНТРАКТ
 * ("Фикстуры вакансий (минимум)").
 *
 * Single source of truth for the vacancy data every `landing/*.spec.ts` spec
 * needs. Two consumers share this ONE file so they can never drift apart:
 *
 *   1. `../../scripts/seed-landing.ts` (`pnpm --filter @crm/e2e seed:landing`)
 *      reads `LANDING_VACANCY_FIXTURES` and creates/reconciles exactly these
 *      rows via the real admin vacancies API — nothing else.
 *   2. The specs import the `*_SLUG` / `*_TITLE` constants below instead of
 *      hardcoding slug strings, so a rename here is a compile error at every
 *      call site, not a silent drift between what was seeded and what a spec
 *      asserts against.
 *
 * Exactly 3 fixtures — the contract's stated minimum, chosen so each one
 * isolates ONE branch of `VacanciesService.resolveLocalized()`'s per-locale
 * `isFallback` logic plus the CLOSED-status public-surface contract:
 *
 *   - FULLY_TRANSLATED: `translations` carries every non-`en` locale in
 *     `VACANCY_TRANSLATION_LOCALES` (uk/ru/es/pt) → every locale's hreflang
 *     alternate must be present (isFallback=false everywhere) — proves
 *     nothing is *incorrectly* excluded when a real translation exists.
 *   - UNTRANSLATED: `translations` omitted entirely → every non-`en` locale
 *     must be EXCLUDED from hreflang (isFallback=true everywhere) while the
 *     page itself still 200s with the `en` copy verbatim — proves the
 *     duplicate-content guard (plan §3/A10) without the route disappearing.
 *   - CLOSED: PUBLISHED → CLOSED transition → the public detail route must
 *     410 (not 404 — a formerly-live posting is GONE, not "never existed"),
 *     and the slug must be absent from `GET /api/public/vacancies`.
 *
 * A vacancy translated to SOME-but-not-all locales (the partial case) is
 * intentionally not a 4th fixture: `isFallback` is computed independently
 * per locale key (`row.translations?.[locale]`), so the ALL-present and
 * NONE-present extremes above already exercise both branches of that
 * per-locale boolean — a partial mix would exercise the same branches again
 * on more locales at once, not a materially different code path.
 */

export const FULLY_TRANSLATED_VACANCY_SLUG = 'senior-ml-engineer'
export const UNTRANSLATED_VACANCY_SLUG = 'lead-ecommerce-dev'
export const CLOSED_VACANCY_SLUG = 'retired-fullstack-lead'

/**
 * Literal EN title `UNTRANSLATED_VACANCY_SLUG` carries. i18n.spec.ts asserts
 * this EXACT string renders on a locale that has no translation for this
 * vacancy (plan §3 "непереведённая — оригинал", the `en` fallback copy) —
 * exported so that assertion never hardcodes the string independently of
 * what the seed script actually writes.
 */
export const UNTRANSLATED_VACANCY_TITLE = 'E-Commerce Team Lead'

/** One locale's `{ title, description }` translation pair (mirrors `@crm/shared` `vacancyTranslationSchema`). */
interface LandingVacancyTranslation {
  title: string
  description: string
}

/**
 * A single seed row's full content — mirrors `@crm/shared`'s
 * `createVacancySchema` input shape closely enough that
 * `scripts/seed-landing.ts` can pass this object straight to
 * `POST /api/vacancies` (+ `PATCH .../:id` for the status transition). Kept
 * as a plain interface (not imported from `@crm/shared`) so this fixtures
 * module has zero runtime dependencies — it is imported by Playwright specs
 * at test-collection time and must stay trivially side-effect-free.
 */
export interface LandingVacancyFixture {
  slug: string
  title: string
  domain: 'AI' | 'EDTECH' | 'ECOMMERCE' | 'OTHER'
  seniority: 'SENIOR' | 'LEAD'
  employmentType: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT'
  location: string
  descriptionMd: string
  /** Omitted (not even an empty object) for the UNTRANSLATED fixture — matches `translations: null` on the row. */
  translations?: Record<'uk' | 'ru' | 'es' | 'pt', LandingVacancyTranslation>
  /** Status the seed script must land this row on (via the DRAFT→PUBLISHED→CLOSED transition chain). */
  targetStatus: 'PUBLISHED' | 'CLOSED'
}

export const LANDING_VACANCY_FIXTURES: LandingVacancyFixture[] = [
  {
    slug: FULLY_TRANSLATED_VACANCY_SLUG,
    title: 'Senior ML Engineer',
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: 'Remote',
    descriptionMd:
      '## About the role\n\nWe are looking for a Senior ML Engineer to join a fully remote ' +
      'AI product team. You will design, train, and ship production machine-learning models ' +
      'end-to-end, from data pipeline to serving infrastructure.\n\n### What you will do\n\n- ' +
      'Own the ML pipeline from data collection to model deployment\n- Collaborate with product ' +
      'and backend teams on integrating model outputs\n- Continuously evaluate and improve model ' +
      'quality in production',
    translations: {
      uk: {
        title: 'Senior ML Engineer (UK)',
        description:
          'Шукаємо Senior ML Engineer у повністю віддалену AI-команду. Ви будете проєктувати, ' +
          'навчати та впроваджувати production ML-моделі від пайплайну даних до сервінгу.',
      },
      ru: {
        title: 'Senior ML Engineer (RU)',
        description:
          'Ищем Senior ML Engineer в полностью удалённую AI-команду. Вы будете проектировать, ' +
          'обучать и внедрять production ML-модели от пайплайна данных до сервинга.',
      },
      es: {
        title: 'Senior ML Engineer (ES)',
        description:
          'Buscamos un Senior ML Engineer para un equipo de IA totalmente remoto. Diseñarás, ' +
          'entrenarás y desplegarás modelos de ML en producción de principio a fin.',
      },
      pt: {
        title: 'Senior ML Engineer (PT)',
        description:
          'Procuramos um Senior ML Engineer para uma equipa de IA totalmente remota. Vai ' +
          'desenhar, treinar e implementar modelos de ML em produção de ponta a ponta.',
      },
    },
    targetStatus: 'PUBLISHED',
  },
  {
    slug: UNTRANSLATED_VACANCY_SLUG,
    title: UNTRANSLATED_VACANCY_TITLE,
    domain: 'ECOMMERCE',
    seniority: 'LEAD',
    employmentType: 'FULL_TIME',
    location: 'Remote',
    descriptionMd:
      '## About the role\n\nWe are looking for an E-Commerce Team Lead to run a small, fully ' +
      'remote engineering team building storefront and checkout experiences for a fast-growing ' +
      'e-commerce client.\n\n### What you will do\n\n- Lead a team of 3-5 engineers end-to-end\n' +
      '- Own architecture decisions for the storefront and checkout flow\n- Work directly with ' +
      'the client on roadmap and delivery',
    // Deliberately no `translations` — this is the "translated nowhere"
    // fixture (see module doc).
    targetStatus: 'PUBLISHED',
  },
  {
    slug: CLOSED_VACANCY_SLUG,
    title: 'Fullstack Lead (Archived Posting)',
    domain: 'EDTECH',
    seniority: 'LEAD',
    employmentType: 'CONTRACT',
    location: 'Remote',
    descriptionMd:
      '## About the role\n\nThis posting is intentionally seeded in the CLOSED state — it must ' +
      'never appear in the public listing and must 410 on direct access (a closed posting is ' +
      'GONE, not "never existed"). No real content beyond satisfying the schema minimums matters ' +
      'here.',
    targetStatus: 'CLOSED',
  },
]
