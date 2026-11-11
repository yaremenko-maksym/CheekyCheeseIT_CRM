// Role navigation model for the v2 shell, derived from apps/web/app/lib/route-access.ts and the
// NAV_ITEMS order in apps/web/app/components/crm/nav-sidebar.tsx (labels = the existing uk catalog strings).
export const DEST = {
  '/': { label: 'Дашборд', icon: 'layout-dashboard' },
  '/project': { label: 'Мій проєкт', icon: 'house' },
  '/legend': { label: 'Легенда', icon: 'book-open' },
  '/pending': { label: 'Чекають рішення', icon: 'clock' },
  '/users': { label: 'Користувачі', icon: 'users' },
  '/admin': { label: 'Адмін', icon: 'settings' },
  '/team': { label: 'Команда', icon: 'users-round' },
  '/projects': { label: 'Проєкти', icon: 'briefcase' },
  '/finance': { label: 'Фінанси', icon: 'dollar-sign' },
  '/stats': { label: 'Статистика', icon: 'chart-column' },
  '/interviews': { label: 'Співбесіди', icon: 'square-kanban' },
  '/documents': { label: 'Документи', icon: 'file-text' },
  '/vacancies': { label: 'Вакансії', icon: 'user-plus' },
  '/job-queue': { label: 'Черга зовнішніх вакансій', icon: 'inbox' },
  '/profile': { label: 'Профіль', icon: 'circle-user' },
}

// Sidebar / More-sheet groups (new group headings — copy-reviewer gate in Wave 0 implementation).
export const GROUPS = [
  { title: 'Огляд', items: ['/', '/project', '/legend', '/pending'] },
  { title: 'Гроші', items: ['/finance', '/stats'] },
  { title: 'Люди', items: ['/users', '/team'] },
  { title: 'Робота', items: ['/projects', '/interviews', '/documents'] },
  { title: 'Найм', items: ['/vacancies', '/job-queue'] },
  { title: 'Система', items: ['/admin'] },
]

// Allowed nav destinations per role (route-access ∩ NAV_ITEMS; `/` hidden for JUNIOR by DASHBOARD_NAV_ROLES).
const ALLOWED = {
  ADMIN: [
    '/',
    '/pending',
    '/users',
    '/admin',
    '/team',
    '/projects',
    '/finance',
    '/stats',
    '/interviews',
    '/documents',
    '/vacancies',
    '/job-queue',
    '/profile',
  ],
  SENIOR: [
    '/',
    '/pending',
    '/team',
    '/projects',
    '/finance',
    '/interviews',
    '/documents',
    '/profile',
  ],
  SENIOR_TEAMLESS: ['/', '/pending', '/team', '/finance', '/documents', '/profile'],
  JUNIOR: ['/project', '/legend', '/pending', '/finance', '/documents', '/profile'],
  HR: [
    '/',
    '/pending',
    '/team',
    '/projects',
    '/finance',
    '/interviews',
    '/documents',
    '/vacancies',
    '/job-queue',
    '/profile',
  ],
  ACCOUNTANT: [
    '/',
    '/pending',
    '/team',
    '/projects',
    '/finance',
    '/stats',
    '/documents',
    '/profile',
  ],
  DROP: ['/', '/pending', '/team', '/finance', '/documents', '/profile'],
}

// Tab bars exactly per the Task 0.8 brief table (4 destinations + «Ще»). Teamless SENIOR loses
// /projects → «Документи» takes slot 4 (A1 decision, recorded in shell-v2.md).
export const TABS = {
  ADMIN: ['/finance', '/users', '/stats', '/'],
  SENIOR: ['/', '/finance', '/team', '/projects'],
  SENIOR_TEAMLESS: ['/', '/finance', '/team', '/documents'],
  JUNIOR: ['/project', '/finance', '/legend', '/documents'],
  HR: ['/', '/interviews', '/vacancies', '/team'],
  ACCOUNTANT: ['/finance', '/stats', '/', '/projects'],
  DROP: ['/', '/finance', '/documents', '/team'],
}

// Quick-add actions per role (existing create actions + their existing labels; verified 2026-11-11:
// finance canCreate = ADMIN|SENIOR|DROP|ACCOUNTANT, interviews canCreate = ADMIN|HR|SENIOR,
// /users = ADMIN, /vacancies = ADMIN|HR). One action → «+» opens it directly; none → no «+».
export const QUICK_ADD = {
  ADMIN: ['txn', 'user', 'interview', 'vacancy'],
  SENIOR: ['txn', 'interview'],
  SENIOR_TEAMLESS: ['txn'],
  JUNIOR: [],
  HR: ['interview', 'vacancy'],
  ACCOUNTANT: ['txn'],
  DROP: ['txn'],
}
export const ACTIONS = {
  txn: { label: 'Нова транзакція', sub: 'Сума, тип і фото чека', icon: 'receipt' },
  user: { label: 'Додати користувача', sub: 'Ім’я, email і роль', icon: 'user-plus' },
  interview: { label: 'Нова співбесіда', sub: 'Кандидат і етап', icon: 'square-kanban' },
  vacancy: { label: 'Створити вакансію', sub: 'Чернетка вакансії', icon: 'briefcase' },
}

export const ROLE_LABEL = {
  ADMIN: 'Адміністратор',
  SENIOR: 'Senior',
  SENIOR_TEAMLESS: 'Senior · без команди',
  JUNIOR: 'Junior',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
  DROP: 'Drop',
}

export function moreItems(role) {
  const tabs = new Set(TABS[role])
  return ALLOWED[role].filter((d) => !tabs.has(d) && d !== '/profile')
}
export const allowed = (role) => ALLOWED[role]
