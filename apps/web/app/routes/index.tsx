import { createFileRoute, redirect } from '@tanstack/react-router'

// Temporary redirect: / → /crm
// In PR2 this route will be removed entirely when apps/web is re-rooted at /crm.
// The marketing landing at cheekycheese.tech is served by apps/landing instead.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/crm' })
  },
  component: () => null,
})
