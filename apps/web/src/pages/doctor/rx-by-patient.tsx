import type { CSSProperties } from 'react'
import { Ban, ChevronRight, CircleCheck, Hourglass, Pill as PillIcon, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Pill } from '@/components/dash/kit'
import { avatarTint, card, initials } from '@/components/dash/kit-style'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { buttonVariants } from '@/components/ui/button'
import { SidePanel } from '@/components/ui/side-panel'
import type { RxState } from '@/lib/api/doctor'
import { statesOf, type RxPatientGroup, type RxVisitGroup } from '@/lib/rx-groups'
import { cn } from '@/lib/utils'
import { VisitLink } from './visit-link'

/*
 * 0209: "My prescriptions" one row per patient (name, file number, how many prescriptions and
 * medicines, where they stand); the row opens the patient's prescriptions beside the list, each
 * visit's medicines together, newest first.
 */

const RX_ICON = {
  waiting: Hourglass,
  given: CircleCheck,
  not_given: Ban,
  room: PillIcon,
  outside: Store,
} as const
const RX_TINT = {
  waiting: 'amber',
  given: 'mint',
  not_given: 'coral',
  room: 'teal',
  outside: 'violet',
} as const

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

function StatePill({ state, count }: { state: RxState; count?: number }) {
  const { t } = useTranslation()
  return (
    <Pill tint={RX_TINT[state]} icon={RX_ICON[state]}>
      {t(`doctorLists.rxTabs.${state}`)}
      {count != null ? ` · ${count}` : ''}
    </Pill>
  )
}

/** One patient in the list: the row opens their prescriptions. */
export function RxPatientRow({
  group,
  index,
  onOpen,
}: {
  group: RxPatientGroup
  index: number
  onOpen: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('doctorLists.rxByPatient.open', { name: group.patient })}
      className="border-grid hover:bg-hover focus-visible:ring-primary/20 anim-enter flex w-full min-w-0 items-start gap-3 border-b px-1 py-3 text-left outline-none last:border-b-0 focus-visible:ring-2"
      style={{ '--i': Math.min(index, 12) } as CSSProperties}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 inline-flex size-9 flex-none items-center justify-center rounded-full text-[13px] font-semibold',
          avatarTint(index),
        )}
      >
        {initials(group.patient)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-ink text-[15px] font-semibold break-words">{group.patient}</span>
        <span className="text-ink-3 text-[13px] break-words">
          {[
            group.fileNumber,
            t('doctorLists.rxByPatient.rx', { count: group.visits.length }),
            t('doctorLists.rxByPatient.meds', { count: group.medicines }),
            t('doctorLists.rxByPatient.last', { when: when(group.last) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {statesOf(group).map((s) => (
            <StatePill key={s.state} state={s.state} count={s.count} />
          ))}
        </span>
      </span>
      <ChevronRight size={18} aria-hidden="true" className="text-ink-3 mt-2 flex-none" />
    </button>
  )
}

/** One visit's medicines: one prescription. */
function VisitRx({
  visit,
  patientId,
  onLeave,
}: {
  visit: RxVisitGroup
  patientId: string
  onLeave: () => void
}) {
  const { t } = useTranslation()
  return (
    <section className={cn(card, 'flex flex-col gap-3')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <h3 className="text-ink m-0 text-[15px] font-semibold break-words">
            {t('doctorLists.rxByPatient.rxOf', { when: when(visit.at) })}
          </h3>
          <span className="text-ink-3 text-[13px]">
            {[
              t('doctorLists.rxByPatient.meds', { count: visit.lines.length }),
              t(
                visit.visitOpen
                  ? 'doctorLists.rxByPatient.visitOpen'
                  : 'doctorLists.rxByPatient.visitDone',
              ),
            ].join(' · ')}
          </span>
        </span>
        {/* leaving for the visit or the file closes this window first (one window at a time) */}
        <span onClickCapture={onLeave} className="flex-none">
          <VisitLink open={visit.visitOpen} encounterId={visit.encounterId} patientId={patientId} />
        </span>
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {visit.lines.map((r) => (
          <li
            key={r.id}
            className="border-grid flex flex-col gap-1 border-t py-2.5 first:border-t-0 first:pt-0 last:pb-0"
          >
            <span className="flex flex-wrap items-center gap-2">
              <StatePill state={r.state} />
              <span className="text-ink min-w-0 text-[14px] font-semibold break-words">
                {r.item} × {r.quantity}
              </span>
            </span>
            {(r.dose || r.frequency || r.days || r.instructions) && (
              <span className="text-ink-2 text-[13px] break-words">
                {[
                  r.dose,
                  r.frequency,
                  r.days ? t('clinical.forDays', { count: r.days }) : null,
                  r.instructions,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            {r.givenAt && r.state === 'given' && (
              <span className="text-ink-3 text-[13px]">
                {t('doctorLists.rxByPatient.givenAt', { when: when(r.givenAt) })}
              </span>
            )}
            {r.notGivenReason && (
              <span className="text-red text-[13px] font-semibold break-words">
                {t('clinical.notGivenWhy', { reason: r.notGivenReason })}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

/** The patient's prescriptions of the period beside the list. */
export function RxPatientPanel({
  group,
  from,
  to,
  onClose,
}: {
  group: RxPatientGroup | null
  from: string
  to: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <SidePanel
      open={group !== null}
      onClose={onClose}
      hue="violet"
      icon={PillIcon}
      title={group ? group.patient : t('doctorLists.rxTitle')}
      // the header line is one line: only the file number there, the counts in the body
      subtitle={group?.fileNumber || undefined}
    >
      {group && (
        <div className="flex flex-col gap-4">
          <p className="text-ink-2 m-0 text-[14px] font-medium">
            {[
              t('doctorLists.rxByPatient.rx', { count: group.visits.length }),
              t('doctorLists.rxByPatient.meds', { count: group.medicines }),
            ].join(' · ')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {statesOf(group).map((s) => (
              <StatePill key={s.state} state={s.state} count={s.count} />
            ))}
            {group.patientId && (
              <span onClickCapture={onClose} className="ml-auto">
                <OpenFileLink
                  patientId={group.patientId}
                  className={buttonVariants({ size: 'sm', variant: 'tint-blue' })}
                >
                  {t('patients.openFile')}
                </OpenFileLink>
              </span>
            )}
          </div>
          {group.visits.map((v) => (
            <VisitRx key={v.encounterId} visit={v} patientId={group.patientId} onLeave={onClose} />
          ))}
          <p className="text-ink-3 m-0 text-[13px]">
            {t('doctorLists.rxByPatient.period', {
              from: formatDate(new Date(`${from}T12:00:00`)),
              to: formatDate(new Date(`${to}T12:00:00`)),
            })}
          </p>
        </div>
      )}
    </SidePanel>
  )
}
