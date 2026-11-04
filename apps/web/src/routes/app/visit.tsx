import { createFileRoute, redirect } from '@tanstack/react-router'
import { VisitPage } from '@/pages/visit/visit-page'
import { useSession } from '@/store/session'

const stepParam = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : undefined
}

const UUID = /^[0-9a-f-]{20,}$|^e-[a-z0-9-]+$/i

/** One visit: patient, vitals, who pays, treatments with discounts, send on. */
export const Route = createFileRoute('/app/visit')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { encounter: string; report?: boolean; step?: number } => ({
    encounter: typeof search.encounter === 'string' ? search.encounter : '',
    // "Report" from the patient file opens the medical report panel
    report:
      search.report === true || search.report === 'true' || search.report === 1 ? true : undefined,
    // 0130: the step of the doctor's record shown (1–6), kept on a reload
    step: stepParam(search.step),
  }),
  beforeLoad: ({ search }) => {
    if (!UUID.test(search.encounter)) throw redirect({ to: '/app' })
  },
  component: VisitRoute,
})

function VisitRoute() {
  const user = useSession((s) => s.user)
  const { encounter, report } = Route.useSearch()
  if (!user) return null
  return <VisitPage key={encounter} user={user} encounterId={encounter} openReport={!!report} />
}
