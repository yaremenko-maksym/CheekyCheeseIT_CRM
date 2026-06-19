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
 * Роли, видящие nav-пункт «Дашборд» (ведёт на корень `/crm`).
 *
 * Это НЕ запись route-access: сам `/crm` — fail-open (доступен всем, см. ROUTE_ACCESS),
 * а вот пункт меню скрыт для JUNIOR (у них свой хаб «Мой проект»). Набор повторяет
 * роли удалённого роута `/crm/dashboard`. Источник истины для NAV_ITEMS «Дашборд».
 */
export const DASHBOARD_NAV_ROLES: readonly Role[] = ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'DROP']

/**
 * Карта: префикс CRM-роута → роли, которым доступен этот раздел.
 *
 * Порядок важен: `resolveRouteAccess` берёт САМЫЙ ДЛИННЫЙ совпавший префикс
 * (longest-prefix match), чтобы под-роут мог сузить/переопределить родителя
 * при необходимости. Под-роуты (`/crm/projects/$id`, `/crm/team/$id`)
 * наследуют доступ родителя через prefix-match — отдельно перечислять не нужно.
 *
 * Источник истины ролей синхронизирован с боковой навигацией: NAV_ITEMS
 * импортирует `navRolesFor()` отсюда (см. nav-sidebar.tsx).
 */
const ROUTE_ACCESS: ReadonlyArray<{ prefix: string; roles: readonly Role[] }> = [
  // JUNIOR hub + легенда — только JUNIOR.
  { prefix: '/crm/project', roles: ['JUNIOR'] },
  { prefix: '/crm/legend', roles: ['JUNIOR'] },

  // DROP hub redirect (старый URL — редирект на /crm) — только DROP.
  { prefix: '/crm/routing', roles: ['DROP'] },

  // Дашборд консолидирован на корень `/crm` (index.tsx): он рендерит роль-зависимый
  // контент (DROP → платёжный хаб, ACCOUNTANT → финхаб, HR → рекрутинг-хаб, ADMIN/
  // SENIOR → дженерик). `/crm` НЕ заводится записью в карте намеренно: корень — это
  // fail-open служебный путь (как /crm/login), доступен ВСЕМ аутентифицированным
  // ролям включая DROP (AC5). JUNIOR на `/crm` редиректится index.tsx → /crm/project.
  // Видимость nav-пункта «Дашборд» задаётся отдельной константой DASHBOARD_NAV_ROLES
  // (роли != route-access: nav скрыт для JUNIOR, но сам /crm для JUNIOR не 403).
  // Отдельного роута `/crm/dashboard` больше нет — запись удалена.

  // Пользователи — только ADMIN.
  { prefix: '/crm/users', roles: ['ADMIN'] },
  // Статистика — ADMIN (всё) + ACCOUNTANT (только экономическая часть; секции
  // балансов сотрудников и плейсхолдеры HR/Команда/Проекты гейтятся ADMIN-only
  // внутри stats.tsx — route-access лишь открывает раздел бухгалтеру).
  { prefix: '/crm/stats', roles: ['ADMIN', 'ACCOUNTANT'] },

  // Команда — ADMIN/SENIOR/HR/ACCOUNTANT/DROP (DROP видит свою команду).
  { prefix: '/crm/team', roles: ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT', 'DROP'] },

  // Проекты (список + деталь $projectId) — без JUNIOR/DROP.
  { prefix: '/crm/projects', roles: ['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT'] },

  // Собеседования — ADMIN/SENIOR/HR.
  { prefix: '/crm/interviews', roles: ['ADMIN', 'SENIOR', 'HR'] },

  // Счёт компании (USDT, Phase 8) — ADMIN/ACCOUNTANT (баланс) + SENIOR/DROP
  // (депозиты). НЕ JUNIOR/HR. Longest-prefix match сужает родительский /crm/finance
  // для этого под-роута. Должен идти как отдельная запись (более длинный префикс).
  {
    prefix: '/crm/finance/company-account',
    roles: ['ADMIN', 'SENIOR', 'ACCOUNTANT', 'DROP'],
  },

  // Финансы — все роли.
  { prefix: '/crm/finance', roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] },

  // Документы — все роли включая DROP (DROP видит свою страницу документов, не профиль-таб).
  { prefix: '/crm/documents', roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] },

  // Профиль (свой + чужой $userId) — все роли (RBAC видимости решается на backend).
  { prefix: '/crm/profile', roles: ALL_ROLES },

  // Платежи (инициация выплаты) — те же, кто видит финансы.
  { prefix: '/crm/payments', roles: ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] },

  // Админ-шаблоны (контракты / ToS) — только ADMIN.
  { prefix: '/crm/admin', roles: ['ADMIN'] },

  // Онбординг — доступен всем аутентифицированным (гейт по статусу отдельно).
  { prefix: '/crm/onboarding', roles: ALL_ROLES },
]

/**
 * Дом роли — куда редиректим, если роль попала на запрещённый роут.
 * JUNIOR → хаб «Мой проект»; все остальные роли (вкл. DROP/ACCOUNTANT/HR) → корень
 * `/crm`, который рендерит роль-зависимый дашборд (консолидация роутинга).
 */
export function resolveRoleHome(role: Role): string {
  switch (role) {
    case 'JUNIOR':
      return '/crm/project'
    default:
      return '/crm'
  }
}

/**
 * Найти роли, которым доступен путь, по longest-prefix match.
 * Возвращает `null`, если путь не покрыт картой (тогда guard его не трогает —
 * fail-open для незакартированных служебных путей; новые разделы добавлять сюда).
 *
 * Экспортируется для coverage-инварианта (route-access.spec.ts): тест проверяет,
 * что каждый файл-роут под routes/crm/** имеет запись в ROUTE_ACCESS, иначе
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
 * Разрешён ли роль доступ к данному CRM-пути.
 * - Путь вне карты → `true` (fail-open для служебных, напр. /crm/login, /crm root index).
 * - Путь в карте → проверка членства роли.
 */
export function isRouteAllowed(pathname: string, role: Role): boolean {
  const allowed = resolveRouteAccess(pathname)
  if (allowed === null) return true
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
