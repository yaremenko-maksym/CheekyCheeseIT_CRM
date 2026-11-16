/**
 * Title → role cases for `classifyRoles`. Every research §3.4 example with its stated outcome, the 8
 * tuning traps and the 2 ATS-fixture bugs (research doc `2026-11-16-it-role-taxonomy.md`). The
 * title-only rows were cross-checked against the research Appendix A scratch classifier.
 */
import type { RoleClassification } from '../role-classifier'

type RoleTitleCase = { title: string; tags?: string[]; expected: RoleClassification }

const NON_IT: RoleClassification = { kind: 'NON_IT' }
const UNCLASSIFIED: RoleClassification = { kind: 'UNCLASSIFIED' }
const roles = (...r: Extract<RoleClassification, { kind: 'ROLES' }>['roles']) =>
  ({ kind: 'ROLES', roles: r }) as const

export const ROLE_TITLE_CASES: readonly RoleTitleCase[] = [
  // §3.4 synthetic examples
  { title: 'Senior Java Tech Lead', expected: roles('BACKEND_ENGINEER') },
  { title: 'Data Architect', expected: roles('DATA_ENGINEER', 'SOFTWARE_ARCHITECT') },
  { title: 'Програміст 1С', expected: roles('BUSINESS_APPLICATIONS_ENGINEER') },
  { title: 'SRE / DevOps', expected: roles('DEVOPS_ENGINEER', 'SITE_RELIABILITY_ENGINEER') },
  { title: 'Kotlin developer', expected: roles('SOFTWARE_ENGINEER') },
  { title: 'C++ developer', expected: roles('SOFTWARE_ENGINEER') },
  { title: 'Business Development Manager', expected: NON_IT },
  { title: 'Landscape Architect', expected: NON_IT },
  { title: 'Software Engineer, Marketing Platform', expected: roles('SOFTWARE_ENGINEER') },
  { title: 'Engineering Manager, Sales Tools', expected: roles('ENGINEERING_MANAGER') },
  { title: 'Backend Engineer - HR Tech', expected: roles('BACKEND_ENGINEER') },
  { title: 'DeFi Smart Contract Engineer', expected: roles('BLOCKCHAIN_ENGINEER') },
  { title: 'Definition Engineer', expected: UNCLASSIFIED },
  { title: 'Market Penetration Specialist', expected: UNCLASSIFIED },
  { title: 'CloudOps Engineer', expected: roles('DEVOPS_ENGINEER') },
  { title: 'Graphic designer', expected: UNCLASSIFIED },
  { title: 'Technical Writer', expected: UNCLASSIFIED },
  { title: 'Principal Engineer', expected: UNCLASSIFIED },
  // ATS-fixture bugs
  { title: 'Automated Test Engineer', expected: roles('QA_AUTOMATION_ENGINEER') },
  {
    title: 'Enterprise Architect - Consumer Banking & Marketing',
    expected: roles('SOFTWARE_ARCHITECT'),
  },
  // Trap 2: a role keyword inside a title with no job noun
  { title: 'Lending Manager (Front End)', expected: UNCLASSIFIED },
  { title: 'Joinery Estimator (Innergy ERP)', expected: UNCLASSIFIED },
  // Trap 7: `penetration` alone is not security; the pen-test role drops manual QA
  { title: 'Pen Tester', expected: roles('PENETRATION_TESTER') },
  // `sales` as a whole word does not match Salesforce
  { title: 'Salesforce Developer', expected: roles('BUSINESS_APPLICATIONS_ENGINEER') },
  { title: 'Sales Manager', expected: NON_IT },
  { title: 'Recruiter', expected: NON_IT },
  // Precedence (step 4) and multi-role (step 5)
  { title: 'Full-stack (React/Node) Developer', expected: roles('FULLSTACK_ENGINEER') },
  { title: 'Engineering Manager, Security Platform', expected: roles('ENGINEERING_MANAGER') },
  { title: 'Senior QA Automation Engineer', expected: roles('QA_AUTOMATION_ENGINEER') },
  { title: 'Machine Learning Engineer, LLM', expected: roles('AI_ENGINEER') },
  { title: 'QA/DevOps Engineer', expected: roles('DEVOPS_ENGINEER', 'QA_ENGINEER') },
  { title: 'iOS/Android developer', expected: roles('IOS_ENGINEER', 'ANDROID_ENGINEER') },
  {
    title: 'Senior Backend Cloud Engineer',
    expected: roles('BACKEND_ENGINEER', 'DEVOPS_ENGINEER'),
  },
  { title: 'Head of Engineering', expected: roles('ENGINEERING_MANAGER') },
  { title: 'Head of QA', expected: roles('QA_ENGINEER') },
  { title: 'CTO', expected: roles('CTO') },
  // §3.3: seniority and lead words are not roles
  { title: 'Lead Python Engineer (ML)', expected: roles('ML_ENGINEER') },
  { title: 'Team Lead', expected: UNCLASSIFIED },
  // §3.2 hints fire only with a job noun
  { title: 'Python Developer', expected: roles('BACKEND_ENGINEER') },
  { title: 'Go developer', expected: roles('BACKEND_ENGINEER') },
  { title: 'C# Developer', expected: roles('BACKEND_ENGINEER') },
  { title: '.NET Developer', expected: roles('BACKEND_ENGINEER') },
  { title: 'ASP.NET Engineer', expected: roles('BACKEND_ENGINEER') },
  { title: 'TypeScript Engineer', expected: roles('FRONTEND_ENGINEER') },
  { title: 'Shopify Developer', expected: roles('FULLSTACK_ENGINEER') },
  { title: 'Python', expected: UNCLASSIFIED },
  // Cyrillic (Unicode word boundaries)
  { title: 'Системний адміністратор', expected: roles('SYSTEM_ADMINISTRATOR') },
  { title: 'Розробник', expected: roles('SOFTWARE_ENGINEER') },
  { title: 'Бекенд-розробник', expected: roles('BACKEND_ENGINEER') },
  // Step 9: an `eq` board category fills an unclassified or generic title
  { title: 'Team Lead', tags: ['Android'], expected: roles('ANDROID_ENGINEER') },
  { title: 'Kotlin developer', tags: ['Kotlin'], expected: roles('SOFTWARE_ENGINEER') },
  { title: 'Software Engineer', tags: ['Front End'], expected: roles('FRONTEND_ENGINEER') },
  { title: 'Tech Lead', tags: [' devops '], expected: roles('DEVOPS_ENGINEER') },
  { title: 'Team Lead', tags: ['JavaScript'], expected: UNCLASSIFIED },
  {
    title: 'Developer',
    tags: ['software-development', 'Data Science'],
    expected: roles('DATA_SCIENTIST'),
  },
  { title: 'Account Manager', tags: ['DevOps'], expected: NON_IT },
]
