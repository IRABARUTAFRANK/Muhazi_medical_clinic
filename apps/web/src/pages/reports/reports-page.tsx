import { Printer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { card } from '@/components/dash/kit-style'
import { PageBanner } from '@/components/dash/page-banner'
import { StaffShell } from '@/components/staff/staff-shell'
import { navForUser } from '@/lib/nav'
import { reportsFor } from '@/lib/reports/catalog'
import { useReportContext } from '@/lib/reports/context'
import { cn } from '@/lib/utils'
import { ReportList } from './report-list'
import { ReportRunner } from './report-runner'

/**
 * The report centre (/app/reports): on the left the reports the person may run, grouped
 * (Patients, Finance, Pharmacy, Stock, Clinical, Laboratory, Reception, Employees) with a search;
 * on the right the chosen report (?r=…): its filters, its columns and layout, the key figures and
 * the table as it prints, with Print / PDF and Excel. Every role sees only its own reports.
 */
export function ReportsPage({
  user,
  reportId,
  onPick,
}: {
  user: StaffUser
  reportId: string | null
  onPick: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const ctx = useReportContext()
  const reports = ctx ? reportsFor(ctx) : []
  const def = reports.find((r) => r.id === reportId) ?? null
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="reports">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Printer}
          tint="navy"
          title={t('reports.ui.title')}
          lead={t('reports.ui.lead')}
        />
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
          <ReportList reports={reports} current={def?.id ?? null} onPick={onPick} />
          {ctx && def ? (
            <ReportRunner key={def.id} def={def} ctx={ctx} />
          ) : (
            <section className={cn(card, 'items-start gap-2 py-8')}>
              <h2 className="text-ink m-0 text-[18px] font-semibold">
                {reports.length ? t('reports.ui.pickTitle') : t('reports.ui.noneTitle')}
              </h2>
              <p className="text-ink-2 m-0 max-w-[620px] text-[14px] leading-snug">
                {reports.length
                  ? t('reports.ui.pickLead', { count: reports.length })
                  : t('reports.ui.noneLead')}
              </p>
            </section>
          )}
        </div>
      </main>
    </StaffShell>
  )
}
