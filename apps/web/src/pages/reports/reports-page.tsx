import { FilePen, Printer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { card } from '@/components/dash/kit-style'
import { PageBanner } from '@/components/dash/page-banner'
import { StaffShell } from '@/components/staff/staff-shell'
import { navForUser } from '@/lib/nav'
import { reportsFor } from '@/lib/reports/catalog'
import { useReportContext } from '@/lib/reports/context'
import { sheetsFor } from '@/lib/reports/sheets'
import { cn } from '@/lib/utils'
import { ReportList } from './report-list'
import { ReportRunner } from './report-runner'
import { ReportSheet } from './report-sheet'

/**
 * The report centre (/app/reports): on the left the reports the person may run, grouped
 * (Patients, Finance, Pharmacy, Stock, Clinical, Laboratory, Reception, Employees) with a search;
 * on the right the chosen report (?r=…): its filters, its columns and layout, the key figures and
 * the table as it prints, with Print / PDF and Excel. Every role sees only its own reports.
 * 0197: the list opens with the sheets printed empty, to write by hand (the blank prescription,
 * for the doctors and the manager): no patient to choose, one button prints it.
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
  const sheets = ctx ? sheetsFor(ctx) : []
  const sheet = sheets.find((s) => s.id === reportId) ?? null
  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="reports">
      <main className="pc:p-6 relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Printer}
          tint="navy"
          title={t('reports.ui.title')}
          lead={t('reports.ui.lead')}
        />
        <div className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
          <ReportList
            reports={reports}
            sheets={sheets}
            current={def?.id ?? sheet?.id ?? null}
            onPick={onPick}
          />
          {ctx && def ? (
            <ReportRunner key={def.id} def={def} ctx={ctx} />
          ) : ctx && sheet ? (
            <ReportSheet key={sheet.id} sheet={sheet} ctx={ctx} />
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
              {/* 0197: the sheets to write by hand, one press away on every screen size */}
              {sheets.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-ink-2 text-[14px] font-semibold">
                    {t('reports.sheets.group')}
                  </span>
                  {sheets.map((s) => (
                    <Button key={s.id} variant="tint-grey" onClick={() => onPick(s.id)}>
                      <FilePen size={16} aria-hidden="true" />
                      {t(s.title)}
                    </Button>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </StaffShell>
  )
}
