import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * /crm/routing → редирект на /crm/dashboard.
 *
 * Хаб дропа переехал на /crm/dashboard (консолидация: DROP получает
 * роль-зависимый дашборд по единому URL). Старый роут /crm/routing
 * оставлен как постоянный редирект чтобы старые ссылки, букмарки
 * и E2E-спеки резолвились без 404.
 *
 * Файл оставлен в route-tree чтобы coverage-инвариант route-access.spec
 * мог проверить наличие ROUTE_ACCESS-записи для /crm/routing.
 */
export const Route = createFileRoute('/crm/routing')({
  beforeLoad: () => {
    throw redirect({ to: '/crm/dashboard', replace: true })
  },
})
