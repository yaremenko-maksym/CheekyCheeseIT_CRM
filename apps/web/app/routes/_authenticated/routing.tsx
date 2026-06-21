import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * /routing → редирект на /.
 *
 * Хаб дропа переехал на корень / (консолидация: DROP получает
 * роль-зависимый дашборд по единому URL). Старый роут /routing
 * оставлен как постоянный редирект чтобы старые ссылки, букмарки
 * и E2E-спеки резолвились без 404.
 *
 * Файл оставлен в route-tree чтобы coverage-инвариант route-access.spec
 * мог проверить наличие ROUTE_ACCESS-записи для /routing.
 */
export const Route = createFileRoute('/_authenticated/routing')({
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true })
  },
})
