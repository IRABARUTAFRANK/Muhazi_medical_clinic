import { Outlet, createRootRoute } from '@tanstack/react-router'
import { ConfirmProvider } from '@/components/ui/confirm-dialog'

export const Route = createRootRoute({
  // every screen can ask "Are you sure?" before an action (useConfirm)
  component: () => (
    <ConfirmProvider>
      <Outlet />
    </ConfirmProvider>
  ),
})
