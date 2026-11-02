import type { CSSProperties } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BedDouble,
  Banknote,
  CalendarClock,
  CircleCheck,
  ClipboardList,
  FlaskConical,
  HandCoins,
  ListTodo,
  type LucideIcon,
  Minus,
  Pill,
  Scissors,
  ShoppingCart,
  Stethoscope,
  Syringe,
  Tablets,
  Undo2,
  UserPlus,
  UserRoundCheck,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf, type StaffUser } from '@mmc/shared'
import { DashLink } from '@/components/dash/dash-link'
import { StaffLink } from '@/components/staff/staff-link'
import { buttonVariants } from '@/components/ui/button'
import { Empty, Hint, IconChip, Panel } from '@/components/dash/kit'
import { card, tileClass, type Tint } from '@/components/dash/kit-style'
import type { MyQueueItem, MySummary } from '@/lib/api/my'
import { onePerPool, openItems } from '@/lib/api/visits'
import { cn } from '@/lib/utils'
import { MyQueuePanel } from './role-panels'
import { kindLink, kindWord, type LinkFn } from './my-work'

/*
 * The personal panels of every staff home (0120): "Waiting for me" (the patients sent to me by
 * name first, then my desks' queue) and "My work" (what I did in the period, by kind, each with
 * its Details). The clinic's figures never appear here: they are the manager's.
 */

/* ---------------------------------------------------------------- waiting for me */

export function WaitingForMePanel({
  summary,
  rowAction,
  i = 1,
  title,
  done,
}: {
  summary: MySummary | undefined
  rowAction: 'open' | 'call'
  i?: number
  /** The panel's title (default "Waiting for me"). */
  title?: string
  /** The "Done" count of the header (default: the patients I saw in the period). */
  done?: number
}) {
  const { t } = useTranslation()
  const all = summary ? onePerPool(openItems(summary.waiting)) : []
  // today's patients in the list and the counts; those still here from an earlier day apart
  // (0122: "From earlier days (n)")
  const rows = all.filter((r) => !r.earlier)
  const earlier = all.filter((r) => r.earlier)
  const c = summary?.counts ?? { sentToMe: 0, atMyDesks: 0, inProgress: 0, earlier: 0 }
  return (
    <MyQueuePanel
      footer={earlier.length > 0 ? <EarlierPatients rows={earlier} /> : undefined}
      i={i}
      title={title ?? t('my.waitingForMe')}
      rows={rows}
      counts={{
        waiting: c.sentToMe + c.atMyDesks,
        inProgress: c.inProgress,
        done: done ?? summary?.work.patientsSeen ?? 0,
      }}
      rowAction={rowAction}
      note={
        summary?.needsUpdate ? (
          <Hint>{t('my.needsUpdate')}</Hint>
        ) : summary && rows.length > 0 ? (
          <p className="text-ink-2 m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span className="text-primary inline-flex items-center gap-1 font-semibold">
              <UserRoundCheck size={13} aria-hidden="true" />
              {t('my.sentToMe', { count: c.sentToMe })}
            </span>
            <span className="inline-flex items-center gap-1">
              <Users size={13} aria-hidden="true" />
              {t('my.atMyDesks', { count: c.atMyDesks })}
            </span>
          </p>
        ) : undefined
      }
    />
  )
}

/**
 * "From earlier days (n)": the patients who joined my queue on an earlier day and are still
 * open. Not in today's counts, never dropped: each opens its visit (to finish or close it).
 */
function EarlierPatients({ rows }: { rows: MyQueueItem[] }) {
  const { t } = useTranslation()
  return (
    <details className="border-yellow-dot/40 bg-yellow-bg/50 rounded-md border px-3 py-2">
      <summary className="text-yellow flex cursor-pointer items-center gap-1.5 text-[14px] font-semibold">
        <CalendarClock size={14} aria-hidden="true" />
        {t('daily.earlierTitle', { count: rows.length })}
      </summary>
      <p className="text-ink-2 m-0 mt-1 text-[13px]">{t('daily.earlierHint')}</p>
      <div className="mt-1 flex flex-col">
        {rows.map((q) => (
          <div
            key={q.queueId ?? q.ticket}
            className="border-grid flex min-h-9 flex-wrap items-center gap-2 border-b py-1 text-[14px] last:border-b-0"
          >
            <span className="text-ink-2 font-semibold tabular-nums">{q.ticket}</span>
            <span className="min-w-[120px] flex-1 truncate font-medium">{q.name}</span>
            <span className="text-ink-3 text-[13px]">
              {t('daily.since', { date: q.queuedAt ? formatDate(new Date(q.queuedAt)) : '' })}
            </span>
            {q.encounterId && (
              <StaffLink
                to="/app/visit"
                search={{ encounter: q.encounterId }}
                className={buttonVariants({ size: 'sm' })}
              >
                {t('common.open')}
              </StaffLink>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

/* ---------------------------------------------------------------- my work */

const KIND_ICON: Record<string, LucideIcon> = {
  registered: UserPlus,
  visitsStarted: Users,
  vitals: Activity,
  patientsSeen: Stethoscope,
  diagnoses: ClipboardList,
  prescriptions: Pill,
  orders: FlaskConical,
  results: CircleCheck,
  procedures: Scissors,
  medicinesGiven: Tablets,
  handovers: ShoppingCart,
  charges: ClipboardList,
  admissions: BedDouble,
  tasksDone: ListTodo,
  vaccinations: Syringe,
  hivTests: FlaskConical,
  familyPlanning: ClipboardList,
  payments: HandCoins,
  refunds: Undo2,
  voided: Banknote,
}
const KIND_TINT: Record<string, Tint> = {
  registered: 'teal',
  visitsStarted: 'mint',
  vitals: 'mint',
  patientsSeen: 'teal',
  diagnoses: 'violet',
  prescriptions: 'amber',
  orders: 'navy',
  results: 'mint',
  procedures: 'coral',
  medicinesGiven: 'mint',
  handovers: 'amber',
  charges: 'violet',
  admissions: 'navy',
  tasksDone: 'teal',
  payments: 'mint',
  refunds: 'coral',
  voided: 'amber',
}

export function MyWorkPanel({
  summary,
  periodWord,
  kinds,
  link,
  user,
  i = 3,
}: {
  summary: MySummary | undefined
  /** "today", "this week"…: what the counts cover. */
  periodWord: string
  /** The kinds listed first, in this order (WORK_OF); any other kind with a count follows. */
  kinds: readonly string[]
  link: LinkFn
  user: StaffUser
  i?: number
}) {
  const { t } = useTranslation()
  const work = summary?.work ?? {}
  const prev = summary?.workPrev ?? {}
  const money = summary?.money
  const extra = Object.keys(work).filter((k) => !kinds.includes(k) && (work[k] ?? 0) > 0)
  const list = [...kinds, ...extra].filter((k) => k !== 'visitsStarted' || kinds.includes(k))
  return (
    <Panel
      i={i}
      icon={ListTodo}
      tint="mint"
      title={t('my.work', { period: periodWord })}
      right={t('desk.mine.note')}
      to={link('staff', { person: user.id })}
      toLabel={t('analytics.views.staff', { defaultValue: 'Who did what' })}
    >
      {summary?.needsUpdate ? (
        <Hint>{t('my.needsUpdate')}</Hint>
      ) : list.length === 0 ? (
        <Empty>{t('my.nothingYet', { period: periodWord })}</Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
          {list.map((k, n) => {
            const now = work[k] ?? 0
            const before = prev[k] ?? 0
            // money kinds carry their amount under the count
            const amount =
              k === 'payments' && money
                ? formatRwf(money.payments.amount)
                : k === 'refunds' && money
                  ? formatRwf(money.refunds.amount)
                  : k === 'handovers' && money
                    ? formatRwf(money.sales.total)
                    : undefined
            return (
              <MiniTile
                key={k}
                i={n}
                icon={KIND_ICON[k] ?? ClipboardList}
                tint={KIND_TINT[k] ?? 'teal'}
                label={kindWord(k, t)}
                value={now}
                sub={amount}
                diff={now - before}
                to={kindLink(k, link, user)}
              />
            )
          })}
        </div>
      )}
      <Hint>{t('my.workHint')}</Hint>
    </Panel>
  )
}

/** A small tile in the kit's tints (the same look as the KPI tiles, smaller): the count, the
 *  change against the period before, and Details when the person may open the view. */
export function MiniTile({
  i,
  icon,
  tint,
  label,
  value,
  sub,
  diff,
  to,
}: {
  i: number
  icon: LucideIcon
  tint: Tint
  label: string
  value: number
  /** A line under the number (an amount). */
  sub?: string
  /** The change against the period before (0: same). */
  diff?: number
  to?: string
}) {
  const { t } = useTranslation()
  const Arrow = diff == null || diff === 0 ? Minus : diff > 0 ? ArrowUp : ArrowDown
  const body = (
    <>
      <span className="flex items-center gap-2 text-[13px] font-medium">
        <IconChip icon={icon} tint={tint} size="sm" />
        <span className="text-ink-2 min-w-0 [overflow-wrap:normal]">{label}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-[28px] leading-8 font-semibold tabular-nums">
          {formatNumber(value)}
        </span>
        {sub && <small className="text-ink-2 text-[13px] font-normal">{sub}</small>}
      </span>
      {diff != null && (
        <span className="text-ink-3 inline-flex items-center gap-1 text-[12px]">
          <Arrow size={12} aria-hidden="true" />
          {diff === 0
            ? t('desk.sameAsBefore')
            : t('desk.vsBefore', { change: `${diff > 0 ? '+' : '−'}${Math.abs(diff)}` })}
        </span>
      )}
      {to && (
        <span className="text-primary text-[12px] font-medium">{t('dashboard.links.details')}</span>
      )}
    </>
  )
  const className = cn(card, 'anim-enter gap-1 px-3 py-2.5', tileClass[tint])
  const style = { '--i': i } as CSSProperties
  return to ? (
    <DashLink
      href={to}
      className={cn(className, 'lift text-inherit no-underline')}
      style={style}
      aria-label={t('dashboard.links.detailsOf', { what: label })}
    >
      {body}
    </DashLink>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  )
}
