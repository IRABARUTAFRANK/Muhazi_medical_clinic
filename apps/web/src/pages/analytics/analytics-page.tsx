import { useId, useRef, type ComponentType } from 'react'
import { ChartColumn, Printer, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, type StaffUser } from '@mmc/shared'
import { card } from '@/components/dash/kit-style'
import { ActionRow, ActionRowEnd, PageBanner } from '@/components/dash/page-banner'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { ReportButtons } from '@/components/dash/report-buttons'
import { Button } from '@/components/ui/button'
import { controlClass } from '@/components/ui/field'
import { StaffShell } from '@/components/staff/staff-shell'
import { canOpenView, useAnalyticsAccess, type AnalyticsView } from '@/lib/api/analytics'
import { useClinicInfo } from '@/lib/api/public'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { SERIES_CSS } from './charts'
import { ExportContext, LoadError, ViewSkeleton, type ReportBuilder } from './kit'
import { PatientsDocuments } from './patients-documents'
import type { AnalyticsSearch, UpdateSearch } from './search'
import { DEPARTMENT_VIEWS, groupName, structureFor, VIEW_ICONS, viewName } from './structure'
import { useUrlPeriod } from './url-period'
import type { ViewProps } from './view-props'
import { CashDeskView } from './views/cash-desk-view'
import { DeskWorkView } from './views/desk-work-view'
import { LabView } from './views/lab-view'
import { OutsideView } from './views/outside-view'
import { PharmacyView } from './views/pharmacy-view'
import { ReceiptsView } from './views/receipts-view'
import { RevenueView } from './views/revenue-view'
import { StaffView } from './views/staff-view'
import { StockView } from './views/stock-view'
import { TriageView } from './views/triage-view'
import { TreatmentsView, VisitsView } from './views/visits-view'
import { WaitingView } from './views/waiting-view'
import { WalkInView } from './views/walk-in-view'

/** The "Patients' documents" view: the same panel as the page under Patients. */
function DocumentsView({ user, access, period, search, update, dept }: ViewProps) {
  return (
    <PatientsDocuments
      user={user}
      access={access}
      period={period}
      search={search}
      update={update}
      dept={dept}
    />
  )
}

/** The component of each view; a component shared by several reads `view`. */
const VIEWS: Record<AnalyticsView, ComponentType<ViewProps>> = {
  revenue: RevenueView,
  staff: StaffView,
  visits: VisitsView,
  treatments: TreatmentsView,
  lab: LabView,
  pharmacy: PharmacyView,
  triage: TriageView,
  stock: StockView,
  waiting: WaitingView,
  receipts: ReceiptsView,
  documents: DocumentsView,
  collections: CashDeskView,
  methods: CashDeskView,
  openBills: CashDeskView,
  refunds: CashDeskView,
  handovers: PharmacyView,
  walkIn: WalkInView,
  expiry: StockView,
  outside: OutsideView,
  tests: LabView,
  turnaround: LabView,
  verification: LabView,
  byTest: LabView,
  myPatients: DeskWorkView,
  vitals: DeskWorkView,
  waitingNow: DeskWorkView,
  diagnoses: DeskWorkView,
  prescriptions: DeskWorkView,
  orders: DeskWorkView,
  tasks: DeskWorkView,
  registrations: DeskWorkView,
  bookings: DeskWorkView,
  arrivals: DeskWorkView,
}

/**
 * Analytics: the detailed views behind the dashboard cards, one at a time (never one long page).
 * Each dashboard has its own structure (0102): the views of that dashboard, in its order, and
 * its first card's view by default. The manager sees the whole clinic, or one department, with
 * money; the head or assistant of a department sees that department and no money; the cash
 * desk, the pharmacy, the laboratory, the doctor, the nurse and reception see their own desk's
 * figures and their own work. The server decides (analytics_access): a view not listed there
 * is not offered. Everything is in the address (view, period, department, the detail open), so
 * a dashboard card links straight to it and Back closes a detail.
 */
export function AnalyticsPage({
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
  const { data: info } = useClinicInfo()
  const exportRef = useRef<ReportBuilder | null>(null)
  const sectionId = useId()
  const deptId = useId()

  const structure = access ? structureFor(access) : { groups: [], first: undefined }
  const view =
    search.view && access && canOpenView(access, search.view) ? search.view : structure.first
  // the department: the manager, the one picked (or the whole clinic); a head, theirs
  const departments = access?.departments ?? []
  const dept = access
    ? access.manager
      ? (departments.find((d) => d.id === search.dept)?.id ?? null)
      : (departments.find((d) => d.id === search.dept)?.id ?? departments[0]?.id ?? null)
    : null
  // a department filters the people, visits, treatments, waiting and documents views
  const deptMatters = !!view && DEPARTMENT_VIEWS.includes(view)
  const showDept =
    deptMatters && (access?.manager ? departments.length > 0 : departments.length > 1)

  const open = (v: AnalyticsView) =>
    update({
      view: v,
      by: undefined,
      person: undefined,
      day: undefined,
      kind: undefined,
      group: undefined,
    })

  const View = view ? VIEWS[view] : null
  const clinic = info?.profile ?? CLINIC_PROFILE
  const groups = structure.groups

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="analytics">
      <style>{SERIES_CSS}</style>
      <main className="mmc-analytics pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* HEADER: the page band (teal), then the action row: period, Excel / PDF, Print */}
        <header className="flex flex-col gap-3">
          <PageBanner
            icon={ChartColumn}
            tint="teal"
            title={t('analytics.title')}
            lead={`${view ? `${viewName(view, t)} · ` : ''}${period.label}`}
          />
          <ActionRow>
            <PeriodSeg period={period} className="max-w-full flex-wrap" />
            {View && <ReportButtons build={() => exportRef.current?.() ?? null} />}
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
        ) : !View || !view ? (
          <p
            role="status"
            className={cn(card, 'text-ink-2 m-0 flex-row items-center gap-2 px-4 py-3 text-[14px]')}
          >
            <ShieldOff size={16} aria-hidden="true" className="text-ink-3 flex-none" />
            {t('analytics.notAllowed')}
          </p>
        ) : (
          <div className="pc:grid-cols-[220px_minmax(0,1fr)] grid grid-cols-1 gap-4">
            {/* SECTIONS: a list on the side (wide screens), a choice on a phone */}
            <nav aria-label={t('analytics.sections')} className="pc:block hidden">
              <div className={cn(card, 'sticky top-0 p-2')}>
                {groups.map((g) => (
                  <div key={g.key} className="flex flex-col gap-0.5">
                    <span className="text-ink-3 px-2 pb-0.5 text-[12px] font-medium">
                      {groupName(g.key, t)}
                    </span>
                    {g.views.map((v) => {
                      const Icon = VIEW_ICONS[v]
                      const on = v === view
                      return (
                        <button
                          key={v}
                          type="button"
                          aria-current={on ? 'page' : undefined}
                          onClick={() => !on && open(v)}
                          className={cn(
                            'focus-visible:ring-primary/20 flex min-h-8 items-center gap-2.5 rounded-md px-2 text-left text-[14px] font-medium transition-colors duration-120 outline-none focus-visible:ring-2',
                            on ? 'bg-primary-tint text-primary' : 'text-ink-2 hover:bg-hover',
                          )}
                        >
                          <Icon size={16} aria-hidden="true" className="flex-none" />
                          <span className="min-w-0 flex-1">{viewName(v, t)}</span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </nav>

            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="pc:hidden flex min-w-0 flex-[1_1_200px] flex-col gap-1">
                  <label htmlFor={sectionId} className="text-ink-2 text-[13px] font-medium">
                    {t('analytics.section')}
                  </label>
                  <select
                    id={sectionId}
                    value={view}
                    onChange={(e) => open(e.target.value as AnalyticsView)}
                    className={cn(controlClass, 'w-full max-w-full')}
                  >
                    {groups.map((g) => (
                      <optgroup key={g.key} label={groupName(g.key, t)}>
                        {g.views.map((v) => (
                          <option key={v} value={v}>
                            {viewName(v, t)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                {showDept && (
                  <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1 sm:max-w-[320px]">
                    <label htmlFor={deptId} className="text-ink-2 text-[13px] font-medium">
                      {t('analytics.department')}
                    </label>
                    <select
                      id={deptId}
                      value={dept ?? ''}
                      onChange={(e) =>
                        update(
                          { dept: e.target.value || undefined, person: undefined },
                          { replace: true },
                        )
                      }
                      className={cn(controlClass, 'w-full max-w-full')}
                    >
                      {access.manager && <option value="">{t('analytics.allDepartments')}</option>}
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <ExportContext.Provider value={exportRef}>
                <View
                  key={`${view}-${dept ?? 'all'}`}
                  user={user}
                  access={access}
                  view={view}
                  period={period}
                  search={search}
                  update={update}
                  dept={dept}
                  clinic={clinic}
                />
              </ExportContext.Provider>
            </div>
          </div>
        )}
      </main>
    </StaffShell>
  )
}
