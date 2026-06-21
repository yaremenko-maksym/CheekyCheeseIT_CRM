import { createFileRoute, redirect } from '@tanstack/react-router'

// Exact /admin → redirect to default tab (contracts).
// This ensures the sidebar nav item `to="/admin"` lands on a working tab
// instead of an empty Outlet.
export const Route = createFileRoute('/_authenticated/admin/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/contracts' })
  },
})
