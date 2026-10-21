import { useState } from 'react'
import { ArrowRightLeft, CornerDownLeft, Send, Stethoscope, UserRound, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StationGlyph } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useBillingActions } from '@/lib/api/billing'
import { useColleagues, useRefer, useVisitRouting } from '@/lib/api/referrals'
import { TREATING_STATIONS, type Station } from '@/lib/api/visits'
import { cn } from '@/lib/utils'
import { useDepartments } from '@/lib/api/staff'

/** Desks where doctors see patients: "any available doctor" puts the patient in all of them. */
const DOCTOR_DESKS: Station[] = ['consultation', 'dental', 'theatre']
/** Who works at each desk, to offer the departments of that role. */
const DESK_ROLE: Partial<Record<Station, string>> = {
  consultation: 'doctor',
  dental: 'doctor',
  theatre: 'doctor',
  triage: 'nurse',
  nursing: 'nurse',
  beds: 'nurse',
  laboratory: 'lab_tech',
  ultrasound: 'sonographer',
  pharmacy: 'pharmacist',
}

const control =
  'border-border bg-card text-ink focus:border-primary h-10 w-full rounded-lg border px-2.5 text-[14px] outline-none'

/**
 * "Where next" on the visit screen. Back to the colleague who referred the patient (one click),
 * any available doctor, one or more desks, the cashier, or a referral to a desk or a named
 * colleague with the reason and, if wanted, "send the patient back to me afterwards".
 */
export function WhereNextCard({
  encounterId,
  myStation,
  isReception,
  closed = false,
  onDone,
  onError,
}: {
  encounterId: string
  myStation: Station
  isReception: boolean
  /** Finished visit: nothing left to send on. */
  closed?: boolean
  onDone: (message: string) => void
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = useBillingActions(encounterId)
  const refer = useRefer(encounterId)
  const { data: routing = [] } = useVisitRouting(encounterId)
  const { data: colleagues = [] } = useColleagues()
  const { data: departments = [] } = useDepartments()
  const [toDept, setToDept] = useState('')
  const [picked, setPicked] = useState<Station[]>([])
  const [referring, setReferring] = useState(false)
  // the first desk the list offers (the list leaves out the desk I am at)
  const [toDesk, setToDesk] = useState<Station>(
    () => TREATING_STATIONS.find((s) => s !== myStation) ?? 'consultation',
  )
  const [toUser, setToUser] = useState('')
  const [note, setNote] = useState('')
  const [comeBack, setComeBack] = useState(true)
  const sending = actions.finishStation.isPending || actions.sendTo.isPending || refer.isPending
  const deskName = (s: Station) => t(`register.stations.${s}`)
  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
  // The referral that brought the patient to this desk, if any.
  const here = routing.find((r) => r.station === myStation)

  const sendOn = async (targets: Station[]) => {
    if (targets.length === 0) return
    onError(null)
    try {
      if (targets.length === 1)
        await actions.finishStation.mutateAsync({ station: myStation, next: targets[0]! })
      else await actions.sendTo.mutateAsync({ station: myStation, next: targets })
      setPicked([])
      onDone(
        t(targets.length === 1 ? 'visit.sent' : 'visit.sentMany', {
          station: targets.map(deskName).join(', '),
        }),
      )
    } catch (e) {
      onError(describe(e))
    }
  }

  const doRefer = async (i: {
    to: Station
    toUser: string | null
    department?: string | null
    note: string
    comeBack: boolean
    message: string
  }) => {
    onError(null)
    try {
      await refer.mutateAsync({ from: myStation, ...i })
      setReferring(false)
      setNote('')
      setToUser('')
      setToDept('')
      onDone(i.message)
    } catch (e) {
      onError(describe(e))
    }
  }

  const person = colleagues.find((c) => c.id === toUser)
  const deskDepts = departments.filter((d) =>
    (d.roles as string[]).includes(DESK_ROLE[toDesk] ?? ''),
  )
  const dept = deskDepts.find((d) => d.id === toDept)
  if (closed) return null

  return (
    <Card className="anim-enter">
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Send size={16} aria-hidden="true" />
          {t('visit.next.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        {/* Referred here: who sent the patient, why, and the way back */}
        {here?.referredName && (
          <div className="border-violet/30 bg-violet-bg/60 flex flex-col gap-2 rounded-xl border px-3 py-2.5">
            <span className="inline-flex items-center gap-2 text-[14px] font-semibold">
              <ArrowRightLeft size={16} aria-hidden="true" className="text-violet" />
              {t('refer.cameFrom', { name: here.referredName })}
            </span>
            {here.note && <span className="text-ink-2 text-[14px]">“{here.note}”</span>}
            {here.returnStation && here.returnTo && (
              <Button
                variant="primary"
                disabled={sending}
                className="self-start"
                onClick={() =>
                  void doRefer({
                    to: here.returnStation!,
                    toUser: here.returnTo,
                    note: t('refer.backNote', { desk: deskName(myStation) }),
                    comeBack: false,
                    message: t('refer.sentBack', { name: here.returnName ?? '' }),
                  })
                }
              >
                <CornerDownLeft size={16} aria-hidden="true" />
                {t('refer.sendBack', {
                  name: here.returnName ?? '',
                  desk: deskName(here.returnStation),
                })}
              </Button>
            )}
          </div>
        )}

        <p className="text-ink-2 m-0 text-[14px]">
          {t('visit.next.lead', { station: deskName(myStation) })}
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant={here?.returnStation ? 'default' : 'primary'}
            disabled={sending}
            onClick={() => void sendOn(DOCTOR_DESKS)}
            className="justify-start"
          >
            <Stethoscope size={18} aria-hidden="true" />
            {t('visit.next.anyDoctor')}
          </Button>
          {!isReception && (
            <Button
              disabled={sending}
              onClick={() => void sendOn(['cashier'])}
              className="justify-start"
            >
              <Wallet size={18} aria-hidden="true" />
              {t('visit.next.toCashier')}
            </Button>
          )}
        </div>
        <p className="text-ink-3 m-0 text-[13px]">
          {t('visit.next.anyDoctorHint', { desks: DOCTOR_DESKS.map(deskName).join(', ') })}
        </p>

        {/* One or more desks */}
        <div className="border-border flex flex-col gap-2 border-t pt-3">
          <span className="text-[14px] font-semibold">{t('visit.next.pick')}</span>
          <div className="flex flex-wrap gap-2">
            {[...TREATING_STATIONS, 'cashier' as Station].map((x) => {
              const on = picked.includes(x)
              return (
                <button
                  key={x}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked((p) => (on ? p.filter((y) => y !== x) : [...p, x]))}
                  className={cn(
                    'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-[14px] font-semibold transition-colors',
                    on
                      ? 'border-primary bg-primary text-white'
                      : 'border-border bg-card text-ink-2 hover:bg-hover',
                  )}
                >
                  <StationGlyph station={x} size={15} />
                  {deskName(x)}
                </button>
              )
            })}
          </div>
          <span className="flex flex-wrap items-center gap-2">
            <Button disabled={sending || picked.length === 0} onClick={() => void sendOn(picked)}>
              <Send size={16} aria-hidden="true" />
              {picked.length > 1
                ? t('visit.next.sendMany', { count: picked.length })
                : t('visit.next.send')}
            </Button>
            {picked.length > 1 && (
              <span className="text-ink-3 text-[13px]">{t('visit.next.manyHint')}</span>
            )}
          </span>
        </div>

        {/* Referral: a desk or a named colleague, with the reason and the way back */}
        <div className="border-border flex flex-col gap-2 border-t pt-3">
          {!referring ? (
            <Button
              className="h-auto min-h-11 self-start text-left whitespace-normal"
              onClick={() => setReferring(true)}
            >
              <ArrowRightLeft size={16} aria-hidden="true" />
              {t('refer.open')}
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <span className="inline-flex items-center gap-2 text-[14px] font-semibold">
                <ArrowRightLeft size={16} aria-hidden="true" className="text-violet" />
                {t('refer.title')}
              </span>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
                  {t('refer.desk')}
                  <select
                    className={control}
                    value={toDesk}
                    onChange={(e) => {
                      setToDesk(e.target.value as Station)
                      setToDept('')
                    }}
                  >
                    {TREATING_STATIONS.filter((s) => s !== myStation).map((s) => (
                      <option key={s} value={s}>
                        {deskName(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
                  {t('refer.person')}
                  <select
                    className={control}
                    value={toUser}
                    onChange={(e) => setToUser(e.target.value)}
                  >
                    <option value="">{t('refer.anyone')}</option>
                    {colleagues.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {t(`staff.roles.${c.role}`, { defaultValue: c.role })}
                        {c.department ? ` · ${c.department}` : c.station ? ` · ${c.station}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!person && deskDepts.length > 0 && (
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
                  {t('refer.department')}
                  <select
                    className={control}
                    value={toDept}
                    onChange={(e) => setToDept(e.target.value)}
                  >
                    <option value="">{t('refer.anyDepartment')}</option>
                    {deskDepts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-ink-3 font-normal">{t('refer.departmentHint')}</span>
                </label>
              )}
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
                {t('refer.why')}
                <textarea
                  rows={2}
                  className="border-border bg-card focus:border-primary rounded-lg border px-2.5 py-2 text-[14px] font-normal outline-none"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <label className="flex items-start gap-2 text-[14px]">
                <input
                  type="checkbox"
                  className="accent-primary mt-0.5 size-4"
                  checked={comeBack}
                  onChange={(e) => setComeBack(e.target.checked)}
                />
                <span>
                  <span className="block font-semibold">{t('refer.comeBack')}</span>
                  <span className="text-ink-3 block text-[13px]">{t('refer.comeBackHint')}</span>
                </span>
              </label>
              <span className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={sending}
                  onClick={() =>
                    void doRefer({
                      to: toDesk,
                      toUser: toUser || null,
                      department: person ? null : (dept?.id ?? null),
                      note,
                      comeBack,
                      message: t('refer.done', {
                        to: person
                          ? `${person.name} (${deskName(toDesk)})`
                          : dept
                            ? `${dept.name} (${deskName(toDesk)})`
                            : deskName(toDesk),
                      }),
                    })
                  }
                >
                  {person ? (
                    <UserRound size={16} aria-hidden="true" />
                  ) : (
                    <Send size={16} aria-hidden="true" />
                  )}
                  {t('refer.send')}
                </Button>
                <Button variant="ghost" onClick={() => setReferring(false)}>
                  {t('staff.form.cancel')}
                </Button>
              </span>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
