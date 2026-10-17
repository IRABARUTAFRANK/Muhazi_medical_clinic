import { createFileRoute, redirect } from '@tanstack/react-router'
import { VisitPage } from '@/pages/visit/visit-page'
import { useSession } from '@/store/session'

const UUID = /^[0-9a-f-]{20,}$|^e-[a-z0-9-]+$/i

/** One visit: patient, vitals, who pays, treatments with discounts, send on. */
export const Route = createFileRoute('/app/visit')({
  validateSearch: (search: Record<string, unknown>): { encounter: string } => ({
    encounter: typeof search.encounter === 'string' ? search.encounter : '',
  }),
  beforeLoad: ({ search }) => {
    if (!UUID.test(search.encounter)) throw redirect({ to: '/app' })
  },
  component: VisitRoute,
})

function VisitRoute() {
  const user = useSession((s) => s.user)
  const { encounter } = Route.useSearch()
  if (!user) return null
  return <VisitPage key={encounter} user={user} encounterId={encounter} />
}
