import { createRootRoute, Outlet } from '@tanstack/react-router'
import '../styles/globals.css'

export const Route = createRootRoute({
  component: RootDocument,
})

function RootDocument() {
  return <Outlet />
}
