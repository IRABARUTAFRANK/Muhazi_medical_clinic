import { useState, type FormEvent } from 'react'
import {
  AlarmClock,
  ArrowRightLeft,
  BedDouble,
  CalendarClock,
  CalendarPlus,
  Check,
  LogOut,
  Receipt,
  Stethoscope,
  Wallet,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { Select } from '@/components/ui/select'
import type { BoardBed } from '@/lib/api/desk-ops'
import { useBedActions, useBedStays, type BedStay } from '@/lib/api/beds'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

/**
 * 0197 · A patient kept in a bed: what the stay is (bed, since when, the days so far and expected,
 * the bed days on the bill, why, the doctor) and what can be done with it (give a bed, move to
 * another, extend, end). Used by step 6 of the visit, the nurse's Beds panel and "Patients in beds".
 * One bed day goes on the bill on the day the patient is given the bed and one more each new day
 * until the stay ends: the questions say so before anything is saved.
 */

const errorLine = 'bg-red-bg text-red m-0 rounded-md px-2.5 py-1.5 text-[13px] font-semibold'
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
const fact = 'text-ink-2 inline-flex min-w-0 items-start gap-1.5 text-[13px]'
const factIcon = 'text-ink-3 mt-0.5 flex-none'

/** The facts of a stay, one per line on a phone, side by side when there is room. */
export function StayFacts({
  stay,
  showBed = true,
  showOwed = false,
  className,
}: {
  stay: BedStay
  showBed?: boolean
  showOwed?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  // 0206: the last expected day, or past it — extend the stay or end it (the nurses and the doctor
  // in charge are told once a day too)
  const over = stay.expectedDays ? stay.days - stay.expectedDays : null
  return (
    <span className={cn('flex min-w-0 flex-wrap gap-x-4 gap-y-1', className)}>
      {over != null && over >= 0 && (
        <span
          className={cn(
            'inline-flex max-w-full min-w-0 items-start gap-1.5 rounded-md px-2 py-0.5 text-[13px] font-semibold',
            over > 0 ? 'bg-red-bg text-red' : 'bg-amber-bg text-amber',
          )}
        >
          <AlarmClock size={14} aria-hidden="true" className="mt-0.5 flex-none" />
          <span className="min-w-0 break-words">
            {over > 0 ? t('beds.overBy', { count: over }) : t('beds.lastDay')}
          </span>
        </span>
      )}
      {showBed && (
        <span className={cn(fact, 'text-ink font-semibold')}>
          <BedDouble size={14} aria-hidden="true" className={factIcon} />
          <span className="min-w-0 break-words">{stay.bed.name}</span>
        </span>
      )}
      <span className={fact}>
        <CalendarClock size={14} aria-hidden="true" className={factIcon} />
        <span className="min-w-0 break-words">
          {[
            stay.since ? t('beds.since', { date: formatDate(new Date(stay.since)) }) : null,
            t('beds.daysSoFar', { count: stay.days }),
            stay.expectedDays
              ? t('beds.expected', { count: stay.expectedDays })
              : t('beds.notDecided'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      {stay.amount != null && (
        <span className={fact}>
          <Receipt size={14} aria-hidden="true" className={factIcon} />
          <span className="min-w-0 break-words">
            {t('beds.amount', { amount: formatRwf(stay.amount) })}
          </span>
        </span>
      )}
      {showOwed && stay.owed != null && (
        <span className={fact}>
          <Wallet size={14} aria-hidden="true" className={factIcon} />
          <span className="min-w-0 break-words">
            {t('beds.owed', { amount: formatRwf(stay.owed) })}
          </span>
        </span>
      )}
      {stay.doctor && (
        <span className={fact}>
          <Stethoscope size={14} aria-hidden="true" className={factIcon} />
          <span className="min-w-0 break-words">{stay.doctor}</span>
        </span>
      )}
      {stay.reason && (
        <span className="text-ink-2 w-full text-[13px] break-words">
          {t('beds.why', { reason: stay.reason })}
        </span>
      )}
    </span>
  )
}

type FormMode = 'keep' | 'move' | 'extend'

/**
 * Give a bed (keep), move to another free bed, or change the days expected (extend). The bed is
 * chosen among the free ones, unless the panel already chose it (bedId); the patient comes from
 * the visit (encounterId) or is chosen among the patients in the clinic (candidates).
 */
export function BedStayForm({
  mode,
  stay,
  encounterId,
  patient,
  candidates,
  bedId,
  free,
  onDone,
  onCancel,
}: {
  mode: FormMode
  /** Move / extend: the stay. */
  stay?: BedStay | null
  /** Keep from the visit: the visit and its patient. */
  encounterId?: string
  patient?: string
  /** Keep from the Beds panel: the patients in the clinic not in a bed. */
  candidates?: { encounterId: string; ticket: string; name: string }[]
  /** Keep from the Beds panel: the bed is the one pressed. */
  bedId?: string
  free: BoardBed[]
  onDone: (message: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const actions = useBedActions()
  const [bed, setBed] = useState(bedId ?? (free.length === 1 ? free[0]!.id : ''))
  const [who, setWho] = useState(encounterId ?? '')
  const [days, setDays] = useState(
    mode === 'extend' && stay?.expectedDays ? String(stay.expectedDays) : '',
  )
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chosen = free.find((b) => b.id === bed) ?? null
  const name =
    patient ?? stay?.patient ?? candidates?.find((c) => c.encounterId === who)?.name ?? ''
  const daysNum = days.trim() === '' ? null : Number(days)
  const daysOk = daysNum === null || (Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 365)
  const valid =
    daysOk &&
    (mode === 'extend' ||
      (!!bed && (mode === 'move' || (!!who && reason.trim().length >= 2)) && bed !== stay?.bed.id))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    if (mode === 'keep' && chosen) {
      const ok = await confirm({
        title: t('beds.confirm.keepTitle', { name, bed: chosen.name }),
        body: t('beds.confirm.keepBody', { price: formatRwf(chosen.nightlyPrice) }),
        confirmLabel: t('beds.confirm.keepYes'),
      })
      if (!ok) return
    }
    if (mode === 'move' && chosen && stay) {
      const ok = await confirm({
        title: t('beds.confirm.moveTitle', { name, from: stay.bed.name, to: chosen.name }),
        body: t('beds.confirm.moveBody', {
          from: stay.bed.name,
          to: chosen.name,
          price: formatRwf(chosen.nightlyPrice),
        }),
        confirmLabel: t('beds.confirm.moveYes'),
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      if (mode === 'keep') {
        await actions.keep.mutateAsync({
          encounterId: who,
          bedId: bed,
          days: daysNum,
          reason,
          patient: name,
        })
        onDone(t('beds.done.keep', { name, bed: chosen?.name ?? '' }))
      } else if (mode === 'move' && stay) {
        await actions.move.mutateAsync({ encounterId: stay.encounterId, bedId: bed, reason })
        onDone(t('beds.done.move', { name, bed: chosen?.name ?? '' }))
      } else if (stay) {
        await actions.setDays.mutateAsync({
          encounterId: stay.encounterId,
          bedId: stay.bed.id,
          days: daysNum,
        })
        onDone(
          daysNum
            ? t('beds.done.days', { name, count: daysNum })
            : t('beds.done.daysOpen', { name }),
        )
      }
    } catch (x) {
      setError(describe(x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Reveal focus block="nearest">
      <form
        onSubmit={submit}
        className="border-border bg-hover/40 flex min-w-0 flex-col gap-3 rounded-md border p-3"
      >
        {mode === 'keep' && candidates && (
          <Select
            label={t('ops.beds.patient')}
            value={who}
            onChange={(e) => setWho(e.target.value)}
            className="w-full"
          >
            <option value="" disabled>
              {candidates.length ? t('ops.beds.pick') : t('ops.beds.nobody')}
            </option>
            {candidates.map((c) => (
              <option key={c.encounterId} value={c.encounterId}>
                {c.ticket} · {c.name}
              </option>
            ))}
          </Select>
        )}
        {mode !== 'extend' && !bedId && (
          <div className="flex min-w-0 flex-col gap-1">
            <Select
              label={t('beds.bed')}
              value={bed}
              onChange={(e) => setBed(e.target.value)}
              className="w-full"
              disabled={free.length === 0}
            >
              <option value="" disabled>
                {free.length ? t('beds.pickBed') : t('beds.noFree')}
              </option>
              {free.map((b) => (
                <option key={b.id} value={b.id}>
                  {t('beds.bedOption', { bed: b.name, price: formatRwf(b.nightlyPrice) })}
                </option>
              ))}
            </Select>
            {free.length === 0 && (
              <span className="text-ink-3 text-xs">{t('beds.noFreeHint')}</span>
            )}
          </div>
        )}
        {mode !== 'move' && (
          <div className="flex min-w-0 flex-col gap-1">
            <Field
              label={t('beds.days')}
              inputMode="numeric"
              value={days}
              placeholder={t('beds.daysPlaceholder')}
              onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
              className="w-full"
            />
            <span className="text-ink-3 text-xs">
              {daysOk ? t('beds.daysHint') : t('beds.daysBad')}
            </span>
          </div>
        )}
        {mode !== 'extend' && (
          <div className="flex min-w-0 flex-col gap-1">
            <Field
              label={t(mode === 'keep' ? 'beds.reason' : 'beds.moveReason')}
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              className="w-full"
            />
            {mode === 'keep' && <span className="text-ink-3 text-xs">{t('beds.reasonHint')}</span>}
          </div>
        )}
        {mode === 'keep' && chosen && (
          <p className="border-primary/20 wash wash-teal m-0 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px]">
            <Receipt size={14} aria-hidden="true" className="text-primary mt-0.5 flex-none" />
            <span className="min-w-0">
              {t('beds.billNote', { price: formatRwf(chosen.nightlyPrice) })}
            </span>
          </p>
        )}
        {error && <p className={errorLine}>{error}</p>}
        <span className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!valid}>
            <Check size={14} aria-hidden="true" />
            {t(
              mode === 'keep'
                ? 'beds.keepBtn'
                : mode === 'move'
                  ? 'beds.moveBtn'
                  : 'beds.extendBtn',
            )}
          </Button>
          <Button type="button" size="sm" variant="tint-coral" onClick={onCancel}>
            <X size={14} aria-hidden="true" />
            {t('staff.form.cancel')}
          </Button>
        </span>
      </form>
    </Reveal>
  )
}

/**
 * Move, Extend and End the stay, each with its question; the form opens under the buttons.
 * `onDone` receives the sentence to show (the bed panel and the pages show it their own way).
 */
export function StayActions({
  stay,
  free,
  onDone,
  onFormChange,
  className,
}: {
  stay: BedStay
  free: BoardBed[]
  onDone: (message: string) => void
  /** A form opened or closed (the bed panel widens the bed's card). */
  onFormChange?: (open: boolean) => void
  className?: string
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const actions = useBedActions()
  const [form, setFormState] = useState<'move' | 'extend' | null>(null)
  const setForm = (f: 'move' | 'extend' | null) => {
    setFormState(f)
    onFormChange?.(f !== null)
  }
  const [error, setError] = useState<string | null>(null)
  const end = async () => {
    setError(null)
    const ok = await confirm({
      title: t('beds.confirm.endTitle', { name: stay.patient, bed: stay.bed.name }),
      body: t('beds.confirm.endBody', {
        count: stay.days,
        amount: stay.amount != null ? formatRwf(stay.amount) : '—',
      }),
      confirmLabel: t('beds.confirm.endYes'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await actions.end.mutateAsync({ encounterId: stay.encounterId, bedId: stay.bed.id })
      onDone(t('beds.done.end', { name: stay.patient, bed: stay.bed.name }))
    } catch (x) {
      setError(describe(x))
    }
  }
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <span className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={form === 'move' ? 'primary' : 'tint-blue'}
          onClick={() => setForm(form === 'move' ? null : 'move')}
        >
          <ArrowRightLeft size={14} aria-hidden="true" />
          {t('beds.move')}
        </Button>
        <Button
          size="sm"
          variant={form === 'extend' ? 'primary' : 'tint-amber'}
          onClick={() => setForm(form === 'extend' ? null : 'extend')}
        >
          <CalendarPlus size={14} aria-hidden="true" />
          {t('beds.extend')}
        </Button>
        <Button size="sm" variant="tint-coral" loading={actions.end.isPending} onClick={end}>
          <LogOut size={14} aria-hidden="true" />
          {t('beds.end')}
        </Button>
      </span>
      {error && <p className={errorLine}>{error}</p>}
      {form && (
        <BedStayForm
          key={form}
          mode={form}
          stay={stay}
          free={free}
          onCancel={() => setForm(null)}
          onDone={(m) => {
            setForm(null)
            onDone(m)
          }}
        />
      )}
    </div>
  )
}

/**
 * Step 6 (Treatment plan): the patient's bed. In a bed: the stay and its actions. Not in a bed:
 * "Keep in a bed" for the doctor (or a nurse, the manager) while the visit is open.
 */
export function BedStayStep({
  encounterId,
  patientName,
  canAct,
  visitOver = false,
  onDone,
}: {
  encounterId: string
  patientName: string
  canAct: boolean
  visitOver?: boolean
  onDone: (message: string) => void
}) {
  const { t } = useTranslation()
  const { stays, free, isLoading } = useBedStays()
  const stay = stays.find((s) => s.encounterId === encounterId) ?? null
  const [adding, setAdding] = useState(false)
  if (isLoading) return null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-ink-2 text-[13px] font-semibold">{t('beds.step.title')}</span>
        {!stay && canAct && !visitOver && !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <BedDouble size={14} aria-hidden="true" />
            {t('beds.keep')}
          </Button>
        )}
      </span>
      {stay ? (
        <div className="border-primary/30 bg-primary-tint/40 flex min-w-0 flex-col gap-2 rounded-md border px-3 py-2">
          <span className="text-[14px] font-semibold break-words">
            {t('beds.inBed', { bed: stay.bed.name })}
          </span>
          <StayFacts stay={stay} showBed={false} />
          {canAct && !visitOver && <StayActions stay={stay} free={free} onDone={onDone} />}
        </div>
      ) : adding ? (
        <BedStayForm
          mode="keep"
          encounterId={encounterId}
          patient={patientName}
          free={free}
          onCancel={() => setAdding(false)}
          onDone={(m) => {
            setAdding(false)
            onDone(m)
          }}
        />
      ) : (
        <span className="text-ink-3 text-xs">{t('beds.step.hint')}</span>
      )}
    </div>
  )
}
