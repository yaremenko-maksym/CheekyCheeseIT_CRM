import type { SessionUser } from '@crm/shared'

/**
 * route-access — single source of truth для role-based видимости CRM-роутов.
 *
 * Используется и боковой навигацией (NAV_ITEMS строит свои `roles` отсюда),
 * и declarative route-guard'ом в CrmLayout (`isRouteAllowed`). Карта одна —
 * не дублируется между компонентом меню и guard'ом (task §4).
 *
 * Защита по роли здесь — defense-in-depth ПОВЕРХ backend RBAC: фронт-guard
 * редиректит, чтобы JUNIOR по прямому URL не открывал чужие страницы; backend
 * по-прежнему обязан возвращать 403/404 на data-вызовах (НЕ ослаблять).
 */

export type Role = SessionUser['role']

const ALL_ROLES: readonly Role[] = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

/**
 * Роли, видящие nav-пункт «Дашборд» (ведёт на корень `/`).
 *
 * Это НЕ запись route-access: сам `/` — fail-open (доступен всем, см. ROUTE_ACCESS),
 * а вот пункт меню скрыт для JUNIOR (у них свой хаб «Мой проект»). Набор повторяет
 * роли удалённого роута `/dashboard`. Источник истины для NAV_ITEMS «Дашборд».
 */
export const DASHBOARD_NAV_ROLES: readonly Role[] = ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'DROP']

/**
 * Карта: префикс CRM-роута → роли, которым доступен этот раздел.
 *
 * Порядок важен: `resolveRouteAccess` берёт САМЫЙ ДЛИННЫЙ совпавший префикс
 * (longest-prefix match), чтобы под-роут мог сузить/переопределить родителя
 * при необходимости. Под-роуты (`/projects/$id`, `/team/$id`)
 * наследуют доступ родителя через prefix-match — отдельно перечислять не нужно.
 *
 * Источник истины ролей синхронизирован с боковой навигацией: NAV_ITEMS
 * импортирует `navRolesFor()` отсюда (см. nav-sidebar.tsx).
 */
const ROUTE_ACCESS: ReadonlyArray<{ prefix: string; roles: readonly Role[] }> = [
  // JUNIOR hub + легенда — только JUNIOR.
  { prefix: '/project', roles: ['JUNIOR'] },
  { prefix: '/legend', roles: ['JUNIOR'] },

  // DROP hub redirect (старый URL — редирект на /) — только DROP.
  { prefix: '/routing', roles: ['DROP'] },

  // Дашборд консолидирован на корень `/` (index.tsx): он рендерит роль-зависимый
  // контент (DROP → платёжный хаб, ACCOUNTANT → финхаб, HR → рекрутинг-хаб, ADMIN/
  // SENIOR → дженерик). `/` НЕ заводится записью в карте намеренно: корень — это
  // fail-open служебный путь (как /login), доступен ВСЕМ аутентифицированным
  // ролям включая DROP (AC5). JUNIOR на `/` редиректится index.tsx → /project.
  // Видимость nav-пункта «Дашборд» задаётся отдельной константой DASHBOARD_NAV_ROLES
  // (роли != route-access: nav скрыт для JUNIOR, но сам / для JUNIOR не 403).
  // Отдельного роута `/dashboard` больше нет — запись удалена.

  // Пользователи — только ADMIN.
  { prefix: '/users', roles: ['ADMIN'] },
  // Статистика — ADMIN (всё) + ACCOUNTANT (только экономическая часть; секции
  // балансов сотрудников и плейсхолдеры HR/Команда/Проекты гейтятся ADMIN-only
  // внутри stats.tsx — route-access лишь открывает раздел бухгалтеру).
  { prefix: '/stats', roles: ['ADMIN', 'ACCOUNTANT'] },

  // Команда — ADMIN/SENIOR/HR/ACCOUNTANT/DROP (DROP видит свою команду).
  { prefix: '/team', roles: ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'DROP'] },

  // Проекты (список + деталь $projectId) — без JUNIOR/DROP.
  { prefix: '/projects', roles: ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT'] },

  // Собеседования — ADMIN/SENIOR/HR.
  { prefix: '/interviews', roles: ['ADMIN', 'SENIOR', 'HR'] },

  // Финансы — все роли. (Счёт компании теперь карточка на этой странице для
  // ADMIN/ACCOUNTANT, отдельного роута нет — Phase 8 v2.)
  { prefix: '/finance', roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] },

  // Документы — все роли включая DROP (DROP видит свою страницу документов, не профиль-таб).
  { prefix: '/documents', roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] },

  // Вакансии (task-crm-vacancies-ui) — публичный канал найма новых SENIOR'ов,
  // управляют ADMIN/HR (backend RolesGuard уже гейтит /api/vacancies так же).
  { prefix: '/vacancies', roles: ['ADMIN', 'HR'] },

  // Профиль (свой + чужой $userId) — все роли (RBAC видимости решается на backend).
  { prefix: '/profile', roles: ALL_ROLES },

  // /payments: removed — no route file exists under routes/_authenticated/payments/**
  // (dead entry; was used for payment initiation which was merged into /finance).
  // Keeping it would silently allow any future /payments/* route for all roles.

  // Админ-шаблоны (контракты / ToS) — только ADMIN.
  { prefix: '/admin', roles: ['ADMIN'] },

  // Онбординг — доступен всем аутентифицированным (гейт по статусу отдельно).
  { prefix: '/onboarding', roles: ALL_ROLES },
]

/**
 * Дом роли — куда редиректим, если роль попала на запрещённый роут.
 * JUNIOR → хаб «Мой проект»; все остальные роли (вкл. DROP/ACCOUNTANT/HR) → корень
 * `/`, который рендерит роль-зависимый дашборд (консолидация роутинга).
 */
export function resolveRoleHome(role: Role): string {
  switch (role) {
    case 'JUNIOR':
      return '/project'
    default:
      return '/'
  }
}

/**
 * Найти роли, которым доступен путь, по longest-prefix match.
 * Возвращает `null`, если путь не покрыт картой (тогда guard его не трогает —
 * fail-open для незакартированных служебных путей; новые разделы добавлять сюда).
 *
 * Экспортируется для coverage-инварианта (route-access.spec.ts): тест проверяет,
 * что каждый файл-роут под routes/_authenticated/** имеет запись в ROUTE_ACCESS, иначе
 * забытая запись = тихий fail-open (LOW-7). `null` в тесте = красный, а не зелёный.
 */
export function resolveRouteAccess(pathname: string): readonly Role[] | null {
  let best: { prefix: string; roles: readonly Role[] } | null = null
  for (const entry of ROUTE_ACCESS) {
    const matches = pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`)
    if (matches && (best === null || entry.prefix.length > best.prefix.length)) {
      best = entry
    }
  }
  return best?.roles ?? null
}

/**
 * Service-level paths that live OUTSIDE the `/_authenticated/` layout and are
 * intentionally fail-open. The root `/` is the role-dispatch dashboard (all
 * authenticated roles land here; per-role content rendered in component) and is
 * not a ROUTE_ACCESS entry by design — see the comment block above.
 * `/login` and `/` are the only unauthenticated/service-level paths the guard
 * ever sees; everything else that lacks a ROUTE_ACCESS entry is a missing mapping
 * and should be treated as denied (fail-closed).
 */
const OPEN_SERVICE_PATHS = new Set(['/', '/login'])

/**
 * Разрешён ли роль доступ к данному CRM-пути.
 *
 * Security: fail-closed for unmapped paths.
 * - Explicitly exempted service paths (/ root index, /login) → `true` (fail-open).
 * - Path in the map → role membership check.
 * - Path NOT in the map and NOT a service path → `false` (fail-closed).
 *   Any new CRM section that forgets an entry in ROUTE_ACCESS is denied by
 *   default, not silently opened. Add the entry to ROUTE_ACCESS to fix.
 */
export function isRouteAllowed(pathname: string, role: Role): boolean {
  const allowed = resolveRouteAccess(pathname)
  if (allowed === null) return OPEN_SERVICE_PATHS.has(pathname)
  return allowed.includes(role)
}

/**
 * Роли для конкретного nav-роута — источник для NAV_ITEMS.roles.
 * Бросает, если роут не найден в карте (защита от рассинхрона: новый nav-пункт
 * без записи в ROUTE_ACCESS обвалит сборку через тест, а не молча покажет пункт).
 */
export function navRolesFor(navTo: string): readonly Role[] {
  const entry = ROUTE_ACCESS.find((e) => e.prefix === navTo)
  if (!entry) {
    throw new Error(`route-access: no access entry for nav route "${navTo}"`)
  }
  return entry.roles
}
