import { createFileRoute, redirect } from '@tanstack/react-router'
import type { HomeMode } from '@mmc/shared'
import { HomePage } from '@/pages/home/home-page'
import { useSession } from '@/store/session'

const MODES: readonly HomeMode[] = ['normal', 'offline', 'empty']
const isMode = (v: unknown): v is HomeMode =>
  typeof v === 'string' && (MODES as readonly string[]).includes(v)

export const Route = createFileRoute('/app/')({
  /** `?mode=offline|empty` shows the design's offline and quiet-morning variants. */
  validateSearch: (search: Record<string, unknown>): { mode?: HomeMode } => ({
    mode: isMode(search.mode) && search.mode !== 'normal' ? search.mode : undefined,
  }),
  beforeLoad: () => {
    // The dashboard is the manager's home page (doc §12.3).
    if (useSession.getState().user?.role === 'manager') throw redirect({ to: '/app/dashboard' })
  },
  component: HomeRoute,
})

function HomeRoute() {
  const user = useSession((s) => s.user)
  const { mode } = Route.useSearch()
  if (!user) return null
  return <HomePage key={user.id} user={user} mode={mode ?? 'normal'} />
}
