import { useMemo, useState, type CSSProperties } from 'react'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { usePeriod } from '@/lib/period'
import {
  Activity,
  ArrowRightLeft,
  BedDouble,
  CalendarRange,
  ChevronDown,
  CircleAlert,
  FileText,
  Filter,
  FolderOpen,
  History,
  LogIn,
  Receipt,
  Settings,
  Stethoscope,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, IconChip, Panel } from '@/components/dash/kit'
import {
  initials,
  tableCell,
  tableFirstCell,
  tableHead,
  tableRow,
  type Tint,
} from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button, tableLink } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import { StaffLink } from '@/components/staff/staff-link'
import { HISTORY_GROUPS, useActivityHistory, type HistoryGroup } from '@/lib/api/history'
import { useEmployees } from '@/lib/api/staff'
import { explain } from '@/lib/history-explain'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

const GROUP_LOOK: Record<HistoryGroup, { icon: LucideIcon; tint: Tint }> = {
  signin: { icon: LogIn, tint: 'navy' },
  patients: { icon: UserPlus, tint: 'teal' },
  vitals: { icon: Activity, tint: 'coral' },
  queue: { icon: Users, tint: 'amber' },
  clinical: { icon: Stethoscope, tint: 'violet' },
  billing: { icon: Receipt, tint: 'mint' },
  beds: { icon: BedDouble, tint: 'navy' },
  admin: { icon: Settings, tint: 'violet' },
  other: { icon: FileText, tint: 'teal' },
}

const dayStart = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/**
 * Activity history (manager): who did what and when on every dashboard, from the audit log that
 * the database keeps for every change, sign-in and staff or settings change. Filter by period,
 * person and kind of work; newest first, more on demand.
 */
export function HistoryPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  // The manager sees everyone's work and can pick a person; everyone else sees their own.
  const isManager = user.role === 'manager'
  const { data: employees = [] } = useEmployees()
  const period = usePeriod('today')
  const [actor, setActor] = useState('')
  const [group, setGroup] = useState<HistoryGroup | ''>('')

  // the chosen days, from the start of the first to the end of the last
  const range = useMemo(() => {
    const end = dayStart(new Date(`${period.to}T00:00:00`))
    end.setHours(23, 59, 59, 999)
    return { from: dayStart(new Date(`${period.from}T00:00:00`)), to: end }
  }, [period.from, period.to])

  const q = useActivityHistory({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    actor: actor || null,
    group: group || null,
  })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const total = q.data?.pages[0]?.total ?? 0

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="history">
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={History}
          tint="violet"
          title={t('history.title')}
          lead={t(isManager ? 'history.lead' : 'history.leadOwn')}
          meta={
            <BannerChip icon={CalendarRange}>{t('history.count', { count: total })}</BannerChip>
          }
        />

        {/* Filters: the period, the person (manager) and the kind of work, in one card */}
        <Card style={{ '--i': 0 } as CSSProperties}>
          <CardHeader icon={Filter}>
            <span className="min-w-0 flex-1">{t('doctorLists.period')}</span>
          </CardHeader>
          <CardBody className="gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <PeriodSeg period={period} />
              {isManager && (
                <Select
                  label={t('history.person')}
                  value={actor}
                  onChange={(e) => setActor(e.target.value)}
                  wrapperClassName="w-full max-w-64"
                >
                  <option value="">{t('history.everyone')}</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.fullName} · {t(`staff.roles.${e.role}`)}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <PeriodCustom period={period} />
            <div className="flex flex-wrap gap-2">
              {(['', ...HISTORY_GROUPS] as const).map((g) => {
                const on = group === g
                const Look = g ? GROUP_LOOK[g].icon : History
                return (
                  <button
                    key={g || 'all'}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setGroup(g)}
                    className={cn(
                      'focus-visible:ring-primary/20 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors duration-120 outline-none focus-visible:ring-2',
                      on
                        ? 'border-primary/30 bg-primary-tint text-primary'
                        : 'border-border bg-card text-ink-2 hover:bg-hover',
                    )}
                  >
                    <Look size={14} aria-hidden="true" />
                    {t(g ? `history.groups.${g}` : 'history.groups.all')}
                  </button>
                )
              })}
            </div>
          </CardBody>
        </Card>

        <Panel
          i={1}
          icon={History}
          tint="violet"
          title={t('history.list')}
          right={t('history.shown', { count: items.length, total })}
        >
          {q.error && (
            <p
              role="alert"
              className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium"
            >
              <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
              {q.error.message}
            </p>
          )}
          {!q.isLoading && items.length === 0 && <Empty icon={History}>{t('history.empty')}</Empty>}
          {items.length > 0 && (
            // the table: when, the kind of work, what happened (with its details), who did it
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr className="border-grid border-b">
                    <th className={tableHead}>{t('report.cols.when')}</th>
                    <th className={tableHead}>{t('history.fields.type')}</th>
                    <th className={cn(tableHead, 'w-full')}>{t('history.list')}</th>
                    <th className={tableHead}>{t('report.cols.by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((h, i) => {
                    const look = GROUP_LOOK[h.group] ?? GROUP_LOOK.other
                    const at = new Date(h.at)
                    const x = explain(h, t)
                    return (
                      <tr
                        key={h.id}
                        className={cn(tableRow, 'anim-enter align-top')}
                        style={{ '--i': Math.min(i, 12) } as CSSProperties}
                      >
                        <td className={cn(tableFirstCell, 'whitespace-nowrap tabular-nums')}>
                          <span className="block">{formatTime(at)}</span>
                          <span className="text-ink-3 block text-[12px] font-normal">
                            {formatDate(at)}
                          </span>
                        </td>
                        <td className={tableCell}>
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <IconChip icon={look.icon} tint={look.tint} size="sm" />
                            <span className="text-ink-2 hidden text-[13px] lg:inline">
                              {t(`history.groups.${h.group}`, { defaultValue: '' })}
                            </span>
                          </span>
                        </td>
                        <td className={cn(tableCell, 'min-w-0')}>
                          <p className="text-ink m-0 text-[14px] leading-snug font-medium">
                            {x.sentence}
                          </p>
                          {x.lines.length > 0 && (
                            <ul className="text-ink-2 m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-[13px]">
                              {x.lines.map((l) => (
                                <li key={l} className="flex gap-1.5">
                                  <span className="text-ink-3" aria-hidden="true">
                                    •
                                  </span>
                                  <span className="min-w-0 break-words">{l}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {x.changes.length > 0 && (
                            <div className="bg-card border-border border-l-primary mt-1.5 rounded-md border border-l-2 px-3 py-2">
                              <span className="text-ink-2 mb-0.5 flex items-center gap-1 text-[12px] font-medium">
                                <ArrowRightLeft size={12} aria-hidden="true" />
                                {t('history.whatChanged')}
                              </span>
                              <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
                                {x.changes.map((c) => (
                                  <li
                                    key={c.label}
                                    className="flex flex-wrap items-baseline gap-x-1.5"
                                  >
                                    <span className="text-ink-2 font-semibold">{c.label}:</span>
                                    <span className="text-red line-through decoration-1">
                                      {c.from}
                                    </span>
                                    <span className="text-ink-3" aria-label={t('history.becomes')}>
                                      →
                                    </span>
                                    <span className="text-green font-semibold">{c.to}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {(h.encounterId || h.patientId) && (
                            <span className="mt-1 -ml-2 flex flex-wrap gap-1">
                              {h.encounterId && (
                                <StaffLink
                                  to="/app/visit"
                                  search={{ encounter: h.encounterId }}
                                  className={tableLink}
                                >
                                  <FileText size={14} aria-hidden="true" />
                                  {t('history.openVisit')}
                                </StaffLink>
                              )}
                              {h.patientId && (
                                // the file opens in the side panel; the link underneath keeps
                                // middle-click and ctrl-click on the whole page
                                <OpenFileLink patientId={h.patientId} className={tableLink}>
                                  <FolderOpen size={14} aria-hidden="true" />
                                  {t('patients.openFile')}
                                </OpenFileLink>
                              )}
                            </span>
                          )}
                        </td>
                        <td className={cn(tableCell, 'whitespace-nowrap')}>
                          <span className="flex items-center gap-2">
                            <span
                              className="bg-primary-tint text-primary inline-flex size-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold"
                              aria-hidden="true"
                            >
                              {initials(h.actor ?? '?')}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[13px] font-medium">
                                {h.actor ?? t('history.system')}
                              </span>
                              <span className="text-ink-3 block text-[12px]">
                                {h.actorRole ? t(`staff.roles.${h.actorRole}`) : ''}
                                {h.actorStaffId
                                  ? `${h.actorRole ? ' · ' : ''}${h.actorStaffId}`
                                  : ''}
                              </span>
                            </span>
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {q.hasNextPage && (
            <Button
              className="self-start"
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {!q.isFetchingNextPage && <ChevronDown size={16} aria-hidden="true" />}
              {t('history.more')}
            </Button>
          )}
        </Panel>
      </main>
    </StaffShell>
  )
}
