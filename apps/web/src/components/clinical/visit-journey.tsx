import {
  Activity,
  CheckCircle2,
  FlaskConical,
  Footprints,
  Lock,
  Pill,
  Receipt,
  Stethoscope,
  UserRoundCheck,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { formatDate, formatRwf, formatTime } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { EmptyNote } from '@/components/clinical/empty-note'
import { journeyMedicineState, useVisitJourney, type Journey } from '@/lib/api/journey'
import { card } from '@/components/dash/kit-style'
import { cn } from '@/lib/utils'
import './visit-motion.css'
import { vitalName } from '@/lib/api/vitals'

const at = (iso: string | null) => (iso ? formatTime(new Date(iso)) : '')
const day = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

type Medicine = Journey['medicines'][number]
/**
 * Where a medicine of the visit stands, in words: given here (from which room store, by whom),
 * collected, not given (why, by whom), brought back, cancelled, or still to collect.
 */
function medicineState(m: Medicine, t: TFunction): string {
  // the room store it came from, when the database gives it
  const store = (m as Medicine & { givenFrom?: string | null; store?: string | null }).givenFrom
  switch (journeyMedicineState(m)) {
    case 'room':
      return store
        ? t('journey.givenInRoomFrom', { store, name: m.givenBy ?? '' })
        : t('journey.givenInRoom', { name: m.givenBy ?? '' })
    case 'given':
      return t('journey.dispensed')
    case 'outside':
      return t('journey.outside')
    case 'notGiven':
      return m.notGivenBy
        ? t('journey.notGivenBy', { reason: m.notGivenReason ?? '', name: m.notGivenBy })
        : t('journey.notGiven', { reason: m.notGivenReason ?? '' })
    case 'returned':
      return t('journey.returned', {
        reason: (m.notGivenReason ?? '').replace(/^returned:\s*/i, ''),
      })
    case 'cancelled':
      return m.cancelledBy
        ? t('journey.cancelledBy', { reason: m.cancelReason ?? '', name: m.cancelledBy })
        : t('journey.cancelled', { reason: m.cancelReason ?? '' })
    default:
      return t('journey.toCollect')
  }
}

/**
 * Everything that happened in a visit, in order: each desk (with who took the patient and
 * when), the vitals, the diagnoses, the medicines, the tests, what was charged and what was paid.
 * Used in the patient file and at the top of a visit.
 */
export function VisitJourney({
  encounterId,
  compact = false,
}: {
  encounterId: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const { data: j, isLoading, error } = useVisitJourney(encounterId)
  if (error)
    return (
      <p className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px]">
        {error.message}
      </p>
    )
  if (!j || isLoading) return <p className="text-ink-3 m-0 text-[13px]">…</p>
  const station = (s: string) => t(`register.stations.${s}`, { defaultValue: s })
  const total = Number(j.bill?.total ?? 0)
  const balance = Number(j.bill?.balance ?? 0)

  return (
    <div className={cn('flex flex-col gap-4', compact && 'gap-3')}>
      {/* The path through the clinic: a line down the dots draws in; the open desk pulses */}
      <ol className="relative m-0 flex list-none flex-col gap-0 p-0">
        <span
          aria-hidden="true"
          className="bg-border anim-progress-y absolute top-4 bottom-4 left-[13px] w-0.5"
        />
        <li className="flex items-start gap-3 py-1.5">
          <Dot icon={Footprints} tint="teal" />
          <span className="text-[14px]">
            <b>{t('journey.arrived', { time: day(j.arrivedAt) })}</b>
            {j.triage && (
              <Badge tone={j.triage as 'red' | 'yellow' | 'green'} className="ml-2">
                {t(`home.triage.${j.triage}`)}
              </Badge>
            )}
            {j.triageReason && (
              <span className="text-ink-2 block text-[13px]">“{j.triageReason}”</span>
            )}
          </span>
        </li>
        {j.steps.map((s, i) => {
          const done = !!s.finishedAt
          return (
            <li key={i} className="flex items-start gap-3 py-1.5">
              <Dot
                icon={done ? CheckCircle2 : Stethoscope}
                tint={done ? 'mint' : 'amber'}
                pulse={!done && j.status === 'open'}
              />
              <span className="min-w-0 text-[14px]">
                <b>{station(s.station)}</b>
                <span className="text-ink-2">
                  {' · '}
                  {t('journey.queuedAt', { time: at(s.queuedAt) })}
                  {s.takenBy &&
                    ` · ${t('journey.takenBy', { name: s.takenBy, time: at(s.startedAt ?? s.queuedAt) })}`}
                  {s.assignedTo && !s.takenBy && ` · ${t('journey.for', { name: s.assignedTo })}`}
                  {done
                    ? ` · ${t('journey.finishedAt', { time: at(s.finishedAt) })}`
                    : ` · ${t('journey.stillHere')}`}
                </span>
                {s.referredBy && (
                  <span className="text-violet block text-[13px]">
                    {t('journey.referredBy', { name: s.referredBy })}
                    {s.note ? ` — “${s.note}”` : ''}
                  </span>
                )}
              </span>
            </li>
          )
        })}
        {/* 0088: handed over between colleagues: who to whom, the note, the answer */}
        {(j.handovers ?? []).map((h) => (
          <li key={h.id} className="flex items-start gap-3 py-1.5">
            <Dot icon={UserRoundCheck} tint="violet" />
            <span className="min-w-0 text-[14px]">
              <b>{t('journey.handover', { from: h.from, to: h.to })}</b>
              <span className="text-ink-2">
                {' · '}
                {at(h.at)}
                {' · '}
                {t(`journey.handoverStatus.${h.status}`, {
                  name: h.answeredBy ?? '',
                  time: at(h.answeredAt),
                })}
              </span>
              {h.note && <span className="text-violet block text-[13px]">“{h.note}”</span>}
              {h.status === 'declined' && h.reason && (
                <span className="text-red block text-[13px]">
                  {t('journey.handoverReason', { reason: h.reason })}
                </span>
              )}
            </span>
          </li>
        ))}
        {j.status === 'closed' && (
          <li className="flex items-start gap-3 py-1.5">
            <Dot icon={CheckCircle2} tint="mint" />
            <span className="text-[14px]">
              <b>{t('journey.closed', { time: j.closedAt ? day(j.closedAt) : '' })}</b>
              {j.closedBy && <span className="text-ink-2"> · {j.closedBy}</span>}
            </span>
          </li>
        )}
      </ol>

      {/* 0088: the clinical part of a visit this person may not see comes empty */}
      {j.private && (
        <p className="bg-violet-bg text-violet border-violet/30 m-0 flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-semibold">
          <Lock size={14} aria-hidden="true" />
          {t('recordPrivacy.journeyPrivate')}
        </p>
      )}
      <div className={cn('grid grid-cols-1 gap-3', !compact && 'md:grid-cols-2')}>
        {!j.private && (
          <>
            <Block
              icon={Activity}
              tint="coral"
              title={t('journey.vitals')}
              empty={j.vitals.length === 0}
              emptyText={t('vitalsForm.none')}
            >
              {j.vitals.map((v, i) => (
                <Line
                  key={i}
                  main={`${vitalName(v, t)}: ${v.value ?? ''}${v.unit ? ` ${v.unit}` : ''}`}
                  meta={[at(v.at), v.by].filter(Boolean).join(' · ')}
                />
              ))}
            </Block>
            <Block
              icon={Stethoscope}
              tint="violet"
              title={t('journey.diagnoses')}
              empty={j.diagnoses.length === 0}
              emptyText={t('file.noDiagnosis')}
            >
              {j.diagnoses.map((d, i) => (
                <Line
                  key={i}
                  main={`${d.text}${d.icd10 ? ` (${d.icd10})` : ''}`}
                  meta={[
                    t(`clinical.type.${d.type}`, { defaultValue: d.type }),
                    d.provisional ? t('history.line.provisional') : null,
                    at(d.at),
                    d.by,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </Block>
            <Block
              icon={Pill}
              tint="mint"
              title={t('journey.medicines')}
              empty={j.medicines.length === 0}
              emptyText={t('journey.noMedicines')}
            >
              {j.medicines.map((m, i) => (
                <Line
                  key={i}
                  main={`${m.item} × ${m.quantity}${m.dose ? ` · ${m.dose}` : ''}${m.frequency ? ` · ${m.frequency}` : ''}${m.days ? ` · ${t('history.days', { count: m.days })}` : ''}`}
                  meta={[medicineState(m, t), at(m.at), m.by].filter(Boolean).join(' · ')}
                />
              ))}
            </Block>
            <Block
              icon={FlaskConical}
              tint="teal"
              title={t('journey.tests')}
              empty={j.tests.length === 0}
              emptyText={t('journey.noTests')}
            >
              {j.tests.map((x, i) => (
                <Line
                  key={i}
                  main={`${x.test}${x.result ? ` — ${x.result}` : ''}`}
                  meta={[t(`lab.status.${x.status}`, { defaultValue: x.status }), at(x.at), x.by]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </Block>
          </>
        )}
        <Block
          icon={Receipt}
          tint="amber"
          title={t('journey.charges')}
          empty={j.charges.length === 0}
          emptyText={t('visit.charges.empty')}
        >
          {j.charges.map((c, i) => (
            <Line
              key={i}
              main={`${c.description} × ${c.quantity} = ${formatRwf(Number(c.total))}`}
              meta={[station(c.office), at(c.at), c.by].filter(Boolean).join(' · ')}
            />
          ))}
          {total > 0 && (
            <p className="m-0 mt-1 text-[13px] font-semibold">
              {t('journey.total', { amount: formatRwf(total) })}
            </p>
          )}
        </Block>
        <Block
          icon={Wallet}
          tint="navy"
          title={t('journey.payments')}
          empty={j.payments.length === 0 && total === 0}
          emptyText={t('finance.nothingYet')}
        >
          {j.payments.map((p, i) => (
            <Line
              key={i}
              main={`${formatRwf(Number(p.amount))} · ${t(`visit.payment.methods.${p.method}`, { defaultValue: p.method })}`}
              meta={[p.reference, at(p.at), p.by].filter(Boolean).join(' · ')}
            />
          ))}
          {j.bill && total > 0 && (
            <p className="m-0 mt-1">
              {balance > 0 ? (
                <Badge tone="yellow">
                  {t('visit.pay.pending', { amount: formatRwf(balance) })}
                </Badge>
              ) : (
                <Badge tone="green" icon={<CheckCircle2 size={12} strokeWidth={3} />}>
                  {j.bill.settledBy
                    ? t('visit.pay.paidBy', { name: j.bill.settledBy, time: at(j.bill.settledAt) })
                    : t('visit.pay.paid')}
                </Badge>
              )}
            </p>
          )}
        </Block>
      </div>
    </div>
  )
}

const TINT: Record<string, string> = {
  teal: 'bg-primary-tint text-primary',
  mint: 'bg-green-bg text-green',
  amber: 'bg-amber-bg text-amber',
  coral: 'bg-red-bg text-red',
  violet: 'bg-violet-bg text-violet',
  navy: 'bg-blue-bg text-navy-ink',
}
function Dot({
  icon: Icon,
  tint,
  pulse = false,
}: {
  icon: typeof Footprints
  tint: string
  /** The step the patient is at now. */
  pulse?: boolean
}) {
  return (
    <span
      className={cn(
        'bg-card relative inline-flex size-7 flex-none items-center justify-center rounded-full',
        TINT[tint],
        pulse && 'anim-pulse-dot ring-primary/40 ring-1',
      )}
    >
      <Icon size={14} aria-hidden="true" />
    </span>
  )
}
function Block({
  icon: Icon,
  tint,
  title,
  empty,
  emptyText,
  children,
}: {
  icon: typeof Footprints
  tint: string
  title: string
  empty: boolean
  emptyText: string
  children: React.ReactNode
}) {
  return (
    <section className={cn(card, 'gap-1.5 p-3')}>
      <h4 className="m-0 flex items-center gap-2 text-[14px] font-semibold">
        <span className={cn('inline-flex size-6 items-center justify-center rounded', TINT[tint])}>
          <Icon size={14} aria-hidden="true" />
        </span>
        {title}
      </h4>
      {empty ? <EmptyNote>{emptyText}</EmptyNote> : children}
    </section>
  )
}
function Line({ main, meta }: { main: string; meta: string }) {
  return (
    <p className="m-0 text-[13px]">
      <span className="text-ink block">{main}</span>
      {meta && <span className="text-ink-3 block text-[12px]">{meta}</span>}
    </p>
  )
}
