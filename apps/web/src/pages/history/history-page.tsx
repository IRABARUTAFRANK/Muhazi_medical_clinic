import { useMemo, useState, type CSSProperties } from 'react'
import {
  Activity,
  BedDouble,
  CalendarRange,
  FileText,
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
import { initials, type Tint } from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  HISTORY_GROUPS,
  useActivityHistory,
  type HistoryGroup,
  type HistoryItem,
} from '@/lib/api/history'
import { useEmployees } from '@/lib/api/staff'
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

type Period = 'today' | 'week' | 'month' | 'custom'
const dayStart = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Activity history (manager): who did what and when on every dashboard, from the audit log that
 * the database keeps for every change, sign-in and staff or settings change. Filter by period,
 * person and kind of work; newest first, more on demand.
 */
export function HistoryPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const { data: employees = [] } = useEmployees()
  // "Now" is taken when the page opens; the list covers everything up to the end of today.
  const [nowMs] = useState(() => Date.now())
  const [period, setPeriod] = useState<Period>('today')
  const [from, setFrom] = useState(() => iso(new Date(nowMs - 7 * 86_400_000)))
  const [to, setTo] = useState(() => iso(new Date(nowMs)))
  const [actor, setActor] = useState('')
  const [group, setGroup] = useState<HistoryGroup | ''>('')

  const range = useMemo(() => {
    const endOfToday = new Date(nowMs)
    endOfToday.setHours(23, 59, 59, 999)
    if (period === 'today') return { from: dayStart(new Date(nowMs)), to: endOfToday }
    if (period === 'week')
      return { from: dayStart(new Date(nowMs - 6 * 86_400_000)), to: endOfToday }
    if (period === 'month')
      return { from: dayStart(new Date(nowMs - 29 * 86_400_000)), to: endOfToday }
    const end = new Date(to)
    end.setHours(23, 59, 59, 999)
    return { from: dayStart(new Date(from)), to: end }
  }, [nowMs, period, from, to])

  const q = useActivityHistory({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    actor: actor || null,
    group: group || null,
  })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const total = q.data?.pages[0]?.total ?? 0

  const verb = (h: HistoryItem) =>
    t(`history.verbs.${h.action}`, { defaultValue: h.action }) +
    ' · ' +
    t(`history.entities.${h.entity}`, { defaultValue: h.entity })

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="history">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={History}
          tint="violet"
          title={t('history.title')}
          lead={t('history.lead')}
          user={user}
          meta={
            <BannerChip icon={CalendarRange}>{t('history.count', { count: total })}</BannerChip>
          }
        />

        {/* Filters */}
        <section className="bg-card shadow-card anim-enter flex flex-col gap-3 rounded-[16px] px-5 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex gap-1 rounded-xl bg-white/70 p-1" role="tablist">
              {(['today', 'week', 'month', 'custom'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={period === p}
                  onClick={() => setPeriod(p)}
                  className={cn(
                    'min-h-10 rounded-lg px-3.5 text-[14px] font-semibold',
                    period === p ? 'bg-navy text-white' : 'text-ink-2 hover:bg-hover',
                  )}
                >
                  {t(`history.periods.${p}`)}
                </button>
              ))}
            </div>
            {period === 'custom' && (
              <>
                <Field
                  label={t('history.from')}
                  type="date"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                  wrapperClassName="w-44"
                />
                <Field
                  label={t('history.to')}
                  type="date"
                  value={to}
                  min={from}
                  max={iso(new Date(nowMs))}
                  onChange={(e) => setTo(e.target.value)}
                  wrapperClassName="w-44"
                />
              </>
            )}
            <Select
              label={t('history.person')}
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              wrapperClassName="w-64"
            >
              <option value="">{t('history.everyone')}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName} · {t(`staff.roles.${e.role}`)}
                </option>
              ))}
            </Select>
          </div>
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
                    'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                    on
                      ? 'border-primary bg-primary text-white'
                      : 'border-border bg-card text-ink-2 hover:bg-hover',
                  )}
                >
                  <Look size={14} aria-hidden="true" />
                  {t(g ? `history.groups.${g}` : 'history.groups.all')}
                </button>
              )
            })}
          </div>
        </section>

        <Panel
          i={1}
          icon={History}
          tint="violet"
          title={t('history.list')}
          right={t('history.shown', { count: items.length, total })}
        >
          {q.error && (
            <p className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[14px] font-semibold">
              {q.error.message}
            </p>
          )}
          {!q.isLoading && items.length === 0 && <Empty icon={History}>{t('history.empty')}</Empty>}
          <div className="flex flex-col">
            {items.map((h, i) => {
              const look = GROUP_LOOK[h.group] ?? GROUP_LOOK.other
              const at = new Date(h.at)
              return (
                <div
                  key={h.id}
                  className="border-grid anim-enter flex items-start gap-3 border-b py-2.5 last:border-b-0"
                  style={{ '--i': Math.min(i, 12) } as CSSProperties}
                >
                  <span className="text-ink-3 w-[92px] flex-none pt-1.5 text-[13px] tabular-nums">
                    {formatTime(at)}
                    <span className="block text-[12px]">{formatDate(at)}</span>
                  </span>
                  <IconChip icon={look.icon} tint={look.tint} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold">
                      {verb(h)}
                      {h.patient ? ` · ${h.patient}` : ''}
                    </span>
                    {(h.detail || h.reason) && (
                      <span className="text-ink-2 block truncate text-[13px]">
                        {[h.detail, h.reason].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-none items-center gap-2 text-[13px]">
                    <span className="bg-primary-tint text-primary inline-flex size-7 items-center justify-center rounded-full text-[11px] font-extrabold">
                      {initials(h.actor ?? '?')}
                    </span>
                    <span className="pc:block hidden">
                      <span className="block font-semibold">{h.actor ?? t('history.system')}</span>
                      <span className="text-ink-3 block text-[12px]">
                        {h.actorRole ? t(`staff.roles.${h.actorRole}`) : ''}
                        {h.actorStaffId ? ` · ${h.actorStaffId}` : ''}
                      </span>
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
          {q.hasNextPage && (
            <Button
              className="self-start"
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {t('history.more')}
            </Button>
          )}
        </Panel>
      </main>
    </StaffShell>
  )
}
