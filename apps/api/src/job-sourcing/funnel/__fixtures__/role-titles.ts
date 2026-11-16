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
  // Spelling variants: one row per keyword alternative
  { title: 'Back End Developer', expected: roles('BACKEND_ENGINEER') },
  { title: 'Server Side Developer', expected: roles('BACKEND_ENGINEER') },
  { title: 'Бек енд розробник', expected: roles('BACKEND_ENGINEER') },
  { title: 'Бэкенд разработчик', expected: roles('BACKEND_ENGINEER') },
  { title: 'Бэк енд разработчик', expected: roles('BACKEND_ENGINEER') },
  { title: 'Nodejs Developer', expected: roles('BACKEND_ENGINEER') },
  { title: 'Senior C# Developer', expected: roles('BACKEND_ENGINEER') },
  { title: 'Front End Developer', expected: roles('FRONTEND_ENGINEER') },
  { title: 'Frontend Developer', expected: roles('FRONTEND_ENGINEER') },
  { title: 'Фронтенд-розробник', expected: roles('FRONTEND_ENGINEER') },
  { title: 'Фронт енд розробник', expected: roles('FRONTEND_ENGINEER') },
  { title: 'HTML/CSS Developer', expected: roles('FRONTEND_ENGINEER') },
  { title: 'HTMLCSS Developer', expected: roles('FRONTEND_ENGINEER') },
  { title: 'Nextjs Developer', expected: roles('FRONTEND_ENGINEER') },
  { title: 'Full Stack Developer', expected: roles('FULLSTACK_ENGINEER') },
  { title: 'Fullstack Developer', expected: roles('FULLSTACK_ENGINEER') },
  { title: 'Фулстек розробник', expected: roles('FULLSTACK_ENGINEER') },
  { title: 'Фулл стек разработчик', expected: roles('FULLSTACK_ENGINEER') },
  { title: 'Desktop Developer', expected: roles('DESKTOP_ENGINEER') },
  { title: 'No Code Developer', expected: roles('BUSINESS_APPLICATIONS_ENGINEER') },
  { title: 'Nocode Developer', expected: roles('BUSINESS_APPLICATIONS_ENGINEER') },
  { title: 'Low Code Developer', expected: roles('BUSINESS_APPLICATIONS_ENGINEER') },
  { title: 'Lowcode Developer', expected: roles('BUSINESS_APPLICATIONS_ENGINEER') },
  { title: 'Swift Developer', expected: roles('IOS_ENGINEER') },
  {
    title: 'Cross Platform Mobile Apps Engineer',
    expected: roles('CROSS_PLATFORM_MOBILE_ENGINEER'),
  },
  {
    title: 'Crossplatform Mobile Apps Engineer',
    expected: roles('CROSS_PLATFORM_MOBILE_ENGINEER'),
  },
  { title: 'Data Engineer', expected: roles('DATA_ENGINEER') },
  { title: 'PLSQL Developer', expected: roles('DATABASE_ENGINEER') },
  { title: 'Postgres Engineer', expected: roles('DATABASE_ENGINEER') },
  { title: 'Data Analyst', expected: roles('DATA_ANALYST') },
  { title: 'Data Scientist', expected: roles('DATA_SCIENTIST') },
  { title: 'SysAdmin', expected: roles('SYSTEM_ADMINISTRATOR') },
  { title: 'Sys Admin', expected: roles('SYSTEM_ADMINISTRATOR') },
  { title: 'System Administrator', expected: roles('SYSTEM_ADMINISTRATOR') },
  { title: 'Системный администратор', expected: roles('SYSTEM_ADMINISTRATOR') },
  { title: 'Telecom Engineer', expected: roles('NETWORK_ENGINEER') },
  { title: 'Helpdesk Engineer', expected: roles('SUPPORT_ENGINEER') },
  { title: 'Help Desk Engineer', expected: roles('SUPPORT_ENGINEER') },
  { title: 'L2 Support Specialist', expected: roles('SUPPORT_ENGINEER') },
  { title: 'Cybersecurity Engineer', expected: roles('SECURITY_ENGINEER') },
  { title: 'Інженер з інформаційної безпеки', expected: roles('SECURITY_ANALYST') },
  { title: 'Инженер по информационной безопасности', expected: roles('SECURITY_ANALYST') },
  { title: 'Pentester', expected: roles('PENETRATION_TESTER') },
  { title: 'Embedded Engineer', expected: roles('EMBEDDED_ENGINEER') },
  { title: 'FPGA Engineer', expected: roles('HARDWARE_ENGINEER') },
  { title: 'UE5 Developer', expected: roles('GAME_DEVELOPER') },
  { title: 'Software Development Manager', expected: roles('ENGINEERING_MANAGER') },
  { title: 'Manager Engineering', expected: roles('ENGINEERING_MANAGER') },
  { title: 'VP Engineering', expected: roles('ENGINEERING_MANAGER') },
  { title: 'VP Technology', expected: roles('CTO') },
  { title: 'Технічний директор', expected: roles('CTO') },
  { title: 'Бізнес аналітик', expected: roles('BUSINESS_ANALYST') },
  { title: 'Бізнесаналітик', expected: roles('BUSINESS_ANALYST') },
  { title: 'Бизнес аналитик', expected: roles('BUSINESS_ANALYST') },
  { title: 'Бизнесаналитик', expected: roles('BUSINESS_ANALYST') },
  { title: 'Системний аналітик', expected: roles('BUSINESS_ANALYST') },
  { title: 'Системный аналитик', expected: roles('BUSINESS_ANALYST') },
  { title: 'UIUX Designer', expected: roles('UI_UX_DESIGNER') },
  { title: 'UXUI Designer', expected: roles('UI_UX_DESIGNER') },
  { title: 'Recruitment Coordinator', expected: NON_IT },
  // Architect domains (§3.1 step 5)
  { title: 'Cloud Solutions Architect', expected: roles('DEVOPS_ENGINEER', 'SOFTWARE_ARCHITECT') },
  {
    title: 'Security Solutions Architect',
    expected: roles('SECURITY_ENGINEER', 'SOFTWARE_ARCHITECT'),
  },
  {
    title: 'Network Solutions Architect',
    expected: roles('NETWORK_ENGINEER', 'SOFTWARE_ARCHITECT'),
  },
  { title: 'AI Solutions Architect', expected: roles('ML_ENGINEER', 'SOFTWARE_ARCHITECT') },
  {
    title: 'CRM Solutions Architect',
    expected: roles('BUSINESS_APPLICATIONS_ENGINEER', 'SOFTWARE_ARCHITECT'),
  },
  {
    title: 'Mobile Solutions Architect',
    expected: roles('CROSS_PLATFORM_MOBILE_ENGINEER', 'SOFTWARE_ARCHITECT'),
  },
  // Precedence and fallback branches
  { title: 'Full-stack (Frontend/Backend) Engineer', expected: roles('FULLSTACK_ENGINEER') },
  { title: 'ML Engineer, Agent Systems', expected: roles('ML_ENGINEER') },
  { title: 'AI Engineer, Machine Learning', expected: roles('ML_ENGINEER', 'AI_ENGINEER') },
  { title: 'Engineering Manager, Backend', expected: roles('ENGINEERING_MANAGER') },
  { title: 'CTO / Backend Developer', expected: roles('CTO') },
  { title: 'Python Specialist', expected: UNCLASSIFIED },
  { title: 'Webdeveloper', expected: UNCLASSIFIED },
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
  { title: 'Team Lead', tags: ['software-development'], expected: roles('SOFTWARE_ENGINEER') },
]
