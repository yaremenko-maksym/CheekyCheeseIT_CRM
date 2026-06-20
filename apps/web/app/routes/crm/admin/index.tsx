import { createFileRoute, redirect } from '@tanstack/react-router'

// Exact /crm/admin → redirect to default tab (contracts).
// This ensures the sidebar nav item `to="/crm/admin"` lands on a working tab
// instead of an empty Outlet.
export const Route = createFileRoute('/crm/admin/')({
  beforeLoad: () => {
    throw redirect({ to: '/crm/admin/contracts' })
  },
})
