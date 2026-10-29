import { useRef } from 'react'
import { FileText, Printer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { card } from '@/components/dash/kit-style'
import { ActionRow, ActionRowEnd, PageBanner } from '@/components/dash/page-banner'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { ReportButtons } from '@/components/dash/report-buttons'
import { Button } from '@/components/ui/button'
import { StaffShell } from '@/components/staff/staff-shell'
import { useAnalyticsAccess } from '@/lib/api/analytics'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { ExportContext, LoadError, ViewSkeleton, type ReportBuilder } from './kit'
import { PatientsDocuments } from './patients-documents'
import type { AnalyticsSearch, UpdateSearch } from './search'
import { useUrlPeriod } from './url-period'
import { tx } from './words'

/**
 * Patients' documents (0102), as its own page under Patients: the period control, Excel / PDF
 * of the list, then the filters, the visits found and the print actions. The same panel is the
 * "Patients' documents" view of the Analytics page.
 */
export function PatientsDocumentsPage({
  user,
  search,
  update,
}: {
  user: StaffUser
  search: AnalyticsSearch
  update: UpdateSearch
}) {
  const { t } = useTranslation()
  const accessQ = useAnalyticsAccess()
  const access = accessQ.data
  const period = useUrlPeriod(search, update)
  const exportRef = useRef<ReportBuilder | null>(null)
  const departments = access?.departments ?? []
  const dept = access
    ? access.manager
      ? (departments.find((d) => d.id === search.dept)?.id ?? null)
      : (departments.find((d) => d.id === search.dept)?.id ?? departments[0]?.id ?? null)
    : null
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="documents">
      <main className="mmc-analytics pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <header className="flex flex-col gap-3">
          <PageBanner
            icon={FileText}
            tint="navy"
            title={tx(t, 'documents.title', 'Patients’ documents')}
            lead={`${tx(t, 'documents.lead', 'The documents of every patient treated in a period, printed together.')} · ${period.label}`}
          />
          <ActionRow>
            <PeriodSeg period={period} className="max-w-full flex-wrap" />
            <ReportButtons build={() => exportRef.current?.() ?? null} />
            <Button variant="tint-grey" onClick={() => window.print()}>
              <Printer size={16} aria-hidden="true" />
              {t('dashboard.print')}
            </Button>
            <ActionRowEnd />
          </ActionRow>
          <PeriodCustom period={period} className={cn(card, 'flex-row gap-3 px-4 py-3')} />
        </header>
        {accessQ.error ? (
          <LoadError error={accessQ.error} />
        ) : !access ? (
          <ViewSkeleton />
        ) : (
          <ExportContext.Provider value={exportRef}>
            <PatientsDocuments
              user={user}
              access={access}
              period={period}
              search={search}
              update={update}
              dept={dept}
            />
          </ExportContext.Provider>
        )}
      </main>
    </StaffShell>
  )
}
