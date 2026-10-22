import { useState, type CSSProperties } from 'react'
import { Building2, ClipboardList, FlaskConical, ListTodo, UserCheck, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime, type StaffUser } from '@mmc/shared'
import { Empty, Kpi, ListRows, Panel, SectionTitle } from '@/components/dash/kit'
import { StationTile } from '@/components/dash/station-tile'
import { Badge } from '@/components/ui/badge'
import { Seg } from '@/components/ui/seg'
import {
  useDepartmentSummary,
  type CustomRange,
  type DashboardRange,
  type DepartmentSummary,
} from '@/lib/api/dashboard'
import { useLeadDepartments } from '@/lib/api/staff'
import { cn } from '@/lib/utils'

const lastSeen = (iso: string | null) =>
  iso ? `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}` : '—'

/**
 * The head of department's own dashboard: the department's people and what each did in the
 * period, its desks' queue now, the patients it handled and the work still open. No money.
 * Shown above the clinic figures for heads and assistant heads (one department at a time).
 */
export function DepartmentSection({
  user,
  range,
  custom,
  periodWord,
}: {
  user: StaffUser
  range: DashboardRange
  custom: CustomRange
  periodWord: string
}) {
  const { t } = useTranslation()
  const leads = useLeadDepartments(user)
  const [picked, setPicked] = useState<string | null>(null)
  const current = leads.find((d) => d.id === picked) ?? leads[0] ?? null
  const { data, error } = useDepartmentSummary(current?.id ?? null, range, custom)
  if (!current) return null
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionTitle icon={Building2}>
          {t('dept.title', { name: data?.department.name ?? current.name })}
        </SectionTitle>
        {leads.length > 1 && (
          <Seg<string>
            label={t('dept.pick')}
            value={current.id}
            onChange={setPicked}
            options={leads.map((d) => ({ value: d.id, label: d.name }))}
          />
        )}
      </div>
      {error && (
        <p className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
          {error.message}
        </p>
      )}
      {data && <DepartmentBody d={data} periodWord={periodWord} />}
    </section>
  )
}

function DepartmentBody({ d, periodWord }: { d: DepartmentSummary; periodWord: string }) {
  const { t } = useTranslation()
  const x = d.tiles
  const diff = Number(x.patients) - Number(x.patientsPrev)
  const queue = d.queue.filter((s) => Number(s.waiting) + Number(s.busy) > 0)
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))] sm:gap-4">
        <Kpi
          i={0}
          icon={UserCheck}
          tint="teal"
          label={t('dept.tiles.patients')}
          value={Number(x.patients)}
          unit={periodWord}
          delta={
            diff === 0
              ? undefined
              : {
                  text: t('dept.vsPrev', { change: `${diff > 0 ? '+' : '−'}${Math.abs(diff)}` }),
                  good: null,
                  up: diff > 0,
                }
          }
        />
        <Kpi
          i={1}
          icon={Users}
          tint="amber"
          label={t('dept.tiles.waiting')}
          value={Number(x.waitingNow)}
          unit={t('dashboard.units.now')}
        />
        <Kpi
          i={2}
          icon={FlaskConical}
          tint="violet"
          label={t('dept.tiles.orders')}
          value={Number(x.ordersOpen)}
          unit={t('dashboard.units.now')}
          delta={
            Number(x.ordersNotDone) > 0
              ? {
                  text: t('dept.notDone', { count: Number(x.ordersNotDone) }),
                  good: false,
                  up: null,
                }
              : undefined
          }
        />
        <Kpi
          i={3}
          icon={ListTodo}
          tint="coral"
          label={t('dept.tiles.tasks')}
          value={Number(x.tasksOpen)}
          unit={t('dashboard.units.now')}
        />
        <Kpi
          i={4}
          icon={UserCheck}
          tint="mint"
          label={t('dept.tiles.signedIn')}
          value={Number(x.signedInToday)}
          unit={t('dept.ofMembers', { count: Number(x.members) })}
        />
      </div>

      <div className="pc:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
        <Panel
          i={1}
          icon={Users}
          tint="teal"
          title={t('dept.people', { period: periodWord })}
          right={t('dept.peopleNote')}
          className="overflow-x-auto"
        >
          {d.members.length === 0 ? (
            <Empty>{t('dept.noPeople')}</Empty>
          ) : (
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="text-ink-3 text-left text-[12px] tracking-[.04em] uppercase">
                  <th className="border-border border-b py-1.5 pr-2 font-semibold">
                    {t('dashboard.cols.employee')}
                  </th>
                  <th className="border-border border-b py-1.5 pr-2 text-right font-semibold">
                    {t('dept.cols.work')}
                  </th>
                  <th className="border-border border-b py-1.5 pr-2 text-right font-semibold">
                    {t('dept.cols.now')}
                  </th>
                  <th className="border-border hidden border-b py-1.5 text-right font-semibold sm:table-cell">
                    {t('dept.cols.lastSeen')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.members.map((m, i) => {
                  // what this person did, in their own work's words
                  const work = (
                    [
                      ['patients', m.patients],
                      ['registrations', m.registrations],
                      ['vitals', m.vitals],
                      ['results', m.results],
                      ['dispensed', m.dispensed],
                      ['payments', m.payments],
                      ['tasksDone', m.tasksDone],
                    ] as const
                  )
                    .filter(([, n]) => Number(n) > 0)
                    .map(([k, n]) => t(`dept.work.${k}`, { count: Number(n) }))
                  return (
                    <tr
                      key={m.id}
                      className={cn(
                        'border-grid anim-enter border-b last:border-b-0',
                        !m.active && 'opacity-60',
                      )}
                      style={{ '--i': i } as CSSProperties}
                    >
                      <td className="py-2 pr-2">
                        <span className="block font-semibold">
                          {m.name}{' '}
                          {m.position !== 'member' && (
                            <Badge tone={m.position === 'head' ? 'blue' : 'grey'} dot={false}>
                              {t(`staff.positions.${m.position}`)}
                            </Badge>
                          )}
                        </span>
                        <span className="text-ink-3 block text-[12px]">
                          {t(`staff.roles.${m.role}`)}
                          {m.station ? ` · ${m.station}` : ''}
                        </span>
                      </td>
                      <td className="text-ink-2 py-2 pr-2 text-right text-[13px]">
                        {work.length ? work.join(' · ') : '—'}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {Number(m.busyNow) > 0 ? t('dept.busy', { count: Number(m.busyNow) }) : '—'}
                      </td>
                      <td className="text-ink-3 hidden py-2 text-right text-[12px] tabular-nums sm:table-cell">
                        {lastSeen(m.lastSignIn)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel i={2} icon={ClipboardList} tint="amber" title={t('dept.queue')}>
            {queue.length === 0 ? (
              <Empty>{t('dashboard.noQueue')}</Empty>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                {queue.map((s, i) => (
                  <StationTile
                    key={s.station}
                    i={i}
                    station={s.station}
                    waiting={Number(s.waiting)}
                    busy={Number(s.busy)}
                    minutes={s.minutes == null ? null : Number(s.minutes)}
                    longest={s.longest == null ? null : Number(s.longest)}
                  />
                ))}
              </div>
            )}
          </Panel>
          <Panel
            i={3}
            icon={FlaskConical}
            tint="violet"
            title={t('dept.services', { period: periodWord })}
          >
            {d.services.length === 0 ? (
              <Empty>{t('dept.noServices')}</Empty>
            ) : (
              <ListRows
                rows={d.services.map((s) => ({
                  key: s.name,
                  label: s.name,
                  value: String(s.count),
                }))}
              />
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}
