import { useState } from 'react'
import {
  Activity,
  CalendarCheck,
  CircleAlert,
  DoorOpen,
  FileLock2,
  History,
  MessageSquare,
  Route,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Hint, IconChip } from '@/components/dash/kit'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import {
  useSaveColleagueAccept,
  useSaveFlowSetting,
  useSaveHistoryForTreatingDoctor,
  useStaffSettings,
} from '@/lib/api/settings'
import { useConfirm } from '@/lib/confirm'
import { card } from '@/components/dash/kit-style'
import { lift } from '@/components/clinical/lift'
import { cn } from '@/lib/utils'

/**
 * Patient flow (manager): new visits go straight to the chosen desk (default), or every
 * patient passes at triage first. Vitals can be recorded at any desk either way.
 */
export function FlowCard() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveFlowSetting()
  const confirm = useConfirm()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = data?.triageFirst ?? false

  const choose = async (v: boolean) => {
    // the flow in use already: nothing changes, nothing to ask
    if (v === current) return
    const k = v ? 'confirm.settings.flow.triageFirst' : 'confirm.settings.flow.deskFirst'
    if (
      !(await confirm({
        title: t(`${k}.title`),
        body: t(`${k}.body`),
        confirmLabel: t('confirm.settings.flow.yes'),
      }))
    )
      return
    setDone(false)
    setError(null)
    try {
      await save.mutateAsync(v)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card className="anim-enter">
      <CardHeader hue="amber">
        <span className="flex items-center gap-2.5">
          <IconChip icon={Route} tint="amber" />
          {t('settings.flow.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('settings.flow.lead')}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {([false, true] as const).map((v) => {
            const on = current === v
            return (
              <button
                key={String(v)}
                type="button"
                aria-pressed={on}
                disabled={save.isPending}
                onClick={() => void choose(v)}
                className={cn(
                  card,
                  lift,
                  'gap-1 p-3 text-left',
                  on && 'border-amber/40 bg-amber-bg',
                )}
              >
                <span
                  className={cn(
                    'flex items-center gap-2 text-[16px] font-semibold',
                    on && 'text-amber',
                  )}
                >
                  <IconChip icon={v ? Activity : DoorOpen} tint={on ? 'amber' : 'teal'} size="sm" />
                  {t(v ? 'settings.flow.triageFirst' : 'settings.flow.deskFirst')}
                </span>
                <span className="text-ink-2 text-[14px]">
                  {t(v ? 'settings.flow.triageFirstHint' : 'settings.flow.deskFirstHint')}
                </span>
              </button>
            )
          })}
        </div>
        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error}
          </p>
        )}
        {done && <Flash onClose={() => setDone(false)}>{t('settings.flow.saved')}</Flash>}
        <Hint>{t('settings.flow.vitalsNote')}</Hint>
        <ColleagueBookings />
        <HistoryForTreatingDoctor />
      </CardBody>
    </Card>
  )
}

/**
 * 0125: a doctor or nurse who books a patient for a colleague: the colleague is asked to accept
 * (default, as for reception's bookings), or the booking is confirmed at once and they are told.
 * A booking made for oneself is always confirmed at once.
 */
function ColleagueBookings() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveColleagueAccept()
  const confirm = useConfirm()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = data?.colleagueAccept ?? true

  const choose = async (v: boolean) => {
    if (v === current) return
    if (
      !(await confirm({
        title: t(v ? 'settings.colleague.askTitle' : 'settings.colleague.directTitle'),
        body: t(v ? 'settings.colleague.askBody' : 'settings.colleague.directBody'),
        confirmLabel: t('confirm.settings.flow.yes'),
      }))
    )
      return
    setDone(false)
    setError(null)
    try {
      await save.mutateAsync(v)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="border-border flex flex-col gap-3 border-t pt-3">
      <h3 className="text-ink m-0 flex items-center gap-2 text-[15px] font-semibold">
        <IconChip icon={CalendarCheck} tint="violet" size="sm" />
        {t('settings.colleague.title')}
      </h3>
      <p className="text-ink-2 m-0 text-[14px]">{t('settings.colleague.lead')}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {([true, false] as const).map((v) => {
          const on = current === v
          return (
            <button
              key={String(v)}
              type="button"
              aria-pressed={on}
              disabled={save.isPending}
              onClick={() => void choose(v)}
              className={cn(
                card,
                lift,
                'gap-1 p-3 text-left',
                on && 'border-violet/40 bg-violet-bg',
              )}
            >
              <span
                className={cn(
                  'flex items-center gap-2 text-[16px] font-semibold',
                  on && 'text-violet',
                )}
              >
                <IconChip
                  icon={v ? MessageSquare : CalendarCheck}
                  tint={on ? 'violet' : 'teal'}
                  size="sm"
                />
                {t(v ? 'settings.colleague.ask' : 'settings.colleague.direct')}
              </span>
              <span className="text-ink-2 text-[14px]">
                {t(v ? 'settings.colleague.askHint' : 'settings.colleague.directHint')}
              </span>
            </button>
          )
        })}
      </div>
      {error && (
        <p
          role="alert"
          className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
          {error}
        </p>
      )}
      {done && <Flash onClose={() => setDone(false)}>{t('settings.flow.saved')}</Flash>}
    </section>
  )
}

/**
 * 0127: the patient's past in step 1 of the visit. On (default): a doctor working on the patient's
 * open visit sees the summary of the earlier visits (complaint, diagnoses, plan, results), each
 * opening written to the access log. Off: the doctor asks (request, emergency access) as before.
 * Someone who is not a doctor never sees it.
 */
function HistoryForTreatingDoctor() {
  const { t } = useTranslation()
  const { data } = useStaffSettings()
  const save = useSaveHistoryForTreatingDoctor()
  const confirm = useConfirm()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = data?.historyForTreatingDoctor ?? true

  const choose = async (v: boolean) => {
    if (v === current) return
    if (
      !(await confirm({
        title: t(v ? 'settings.pastForDoctor.onTitle' : 'settings.pastForDoctor.offTitle'),
        body: t(v ? 'settings.pastForDoctor.onBody' : 'settings.pastForDoctor.offBody'),
        confirmLabel: t('confirm.settings.flow.yes'),
      }))
    )
      return
    setDone(false)
    setError(null)
    try {
      await save.mutateAsync(v)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="border-border flex flex-col gap-3 border-t pt-3">
      <h3 className="text-ink m-0 flex items-center gap-2 text-[15px] font-semibold">
        <IconChip icon={History} tint="teal" size="sm" />
        {t('settings.pastForDoctor.title')}
      </h3>
      <p className="text-ink-2 m-0 text-[14px]">{t('settings.pastForDoctor.lead')}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {([true, false] as const).map((v) => {
          const on = current === v
          return (
            <button
              key={String(v)}
              type="button"
              aria-pressed={on}
              disabled={save.isPending}
              onClick={() => void choose(v)}
              className={cn(card, lift, 'gap-1 p-3 text-left', on && 'border-teal/40 bg-teal-bg')}
            >
              <span
                className={cn(
                  'flex items-center gap-2 text-[16px] font-semibold',
                  on && 'text-teal',
                )}
              >
                <IconChip icon={v ? History : FileLock2} tint={on ? 'teal' : 'amber'} size="sm" />
                {t(v ? 'settings.pastForDoctor.on' : 'settings.pastForDoctor.off')}
              </span>
              <span className="text-ink-2 text-[14px]">
                {t(v ? 'settings.pastForDoctor.onHint' : 'settings.pastForDoctor.offHint')}
              </span>
            </button>
          )
        })}
      </div>
      <Hint>{t('settings.pastForDoctor.note')}</Hint>
      {error && (
        <p
          role="alert"
          className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
          {error}
        </p>
      )}
      {done && <Flash onClose={() => setDone(false)}>{t('settings.flow.saved')}</Flash>}
    </section>
  )
}
