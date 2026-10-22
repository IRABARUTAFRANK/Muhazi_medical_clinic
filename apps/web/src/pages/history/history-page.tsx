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
  // The manager sees everyone's work and can pick a person; everyone else sees their own.
  const isManager = user.role === 'manager'
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

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="history">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={History}
          tint="violet"
          title={t('history.title')}
          lead={t(isManager ? 'history.lead' : 'history.leadOwn')}
          meta={
            <BannerChip icon={CalendarRange}>{t('history.count', { count: total })}</BannerChip>
          }
        />

        {/* Filters */}
        <section className="bg-card shadow-card anim-enter flex flex-col gap-3 rounded-[16px] px-5 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-wrap gap-1 rounded-xl bg-white/70 p-1" role="tablist">
              {(['today', 'week', 'month', 'custom'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={period === p}
                  onClick={() => setPeriod(p)}
                  className={cn(
                    'min-h-10 rounded-lg px-3.5 text-[14px] font-semibold whitespace-nowrap',
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
            {isManager && (
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
            )}
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
              const x = explain(h, t)
              return (
                <article
                  key={h.id}
                  className="border-grid anim-enter flex items-start gap-3 border-b py-3 last:border-b-0"
                  style={{ '--i': Math.min(i, 12) } as CSSProperties}
                >
                  <span className="text-ink-3 w-[64px] flex-none pt-1.5 text-[13px] tabular-nums sm:w-[92px]">
                    <b className="text-ink block text-[14px]">{formatTime(at)}</b>
                    <span className="block text-[12px]">{formatDate(at)}</span>
                  </span>
                  <IconChip icon={look.icon} tint={look.tint} />
                  <div className="min-w-0 flex-1">
                    <p className="text-ink m-0 text-[15px] leading-snug font-semibold">
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
                      <div className="bg-surface border-border mt-1.5 rounded-lg border px-3 py-2">
                        <span className="text-ink-3 block text-[11px] font-bold tracking-[.06em] uppercase">
                          {t('history.whatChanged')}
                        </span>
                        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
                          {x.changes.map((c) => (
                            <li key={c.label} className="flex flex-wrap items-baseline gap-x-1.5">
                              <span className="text-ink-2 font-semibold">{c.label}:</span>
                              <span className="text-red line-through decoration-1">{c.from}</span>
                              <span className="text-ink-3" aria-label={t('history.becomes')}>
                                →
                              </span>
                              <span className="text-green font-semibold">{c.to}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <span className="text-ink-3 mt-1 block text-[12px]">
                      {t('history.doneBy', {
                        name: h.actor ?? t('history.system'),
                        role: h.actorRole ? t(`staff.roles.${h.actorRole}`) : '',
                      })}
                      {h.actorStaffId ? ` · ${h.actorStaffId}` : ''}
                    </span>
                    {(h.encounterId || h.patientId) && (
                      <span className="mt-1 flex flex-wrap gap-3 text-[13px]">
                        {h.encounterId && (
                          <StaffLink
                            to="/app/visit"
                            search={{ encounter: h.encounterId }}
                            className="text-primary font-semibold underline-offset-2 hover:underline"
                          >
                            {t('history.openVisit')}
                          </StaffLink>
                        )}
                        {h.patientId && (
                          <StaffLink
                            to="/app/patient"
                            search={{ id: h.patientId }}
                            className="text-primary font-semibold underline-offset-2 hover:underline"
                          >
                            {t('patients.openFile')}
                          </StaffLink>
                        )}
                      </span>
                    )}
                  </div>
                  <span
                    className="bg-primary-tint text-primary pc:inline-flex hidden size-8 flex-none items-center justify-center rounded-full text-[11px] font-extrabold"
                    title={h.actor ?? ''}
                  >
                    {initials(h.actor ?? '?')}
                  </span>
                </article>
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
