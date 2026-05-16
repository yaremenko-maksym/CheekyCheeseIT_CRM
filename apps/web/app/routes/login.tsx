import { createFileRoute, redirect } from '@tanstack/react-router'

// Permanent redirect: /login → /crm/login
export const Route = createFileRoute('/login')({
  beforeLoad: () => {
    throw redirect({ to: '/crm/login' })
  },
})
