import { useEffect, useState, type ReactNode } from 'react'
import { Activity, Building2, FilePlus2, History, Send, Siren, UserRoundCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, type StaffUser } from '@mmc/shared'
import { stationIconFor } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { useDepartments } from '@/lib/api/staff'
import {
  DESK_ROLE,
  TREATING_STATIONS,
  stationFor,
  useVisitActions,
  type Station,
  type VisitResult,
} from '@/lib/api/visits'
import { cn } from '@/lib/utils'

/** The desks a person may start a visit with "I see this patient myself" (the database agrees). */
const MY_DESKS: Record<string, Station[]> = {
  doctor: ['consultation', 'dental', 'theatre', 'ultrasound'],
  nurse: ['triage', 'nursing', 'beds'],
  lab_tech: ['laboratory'],
  sonographer: ['ultrasound'],
  pharmacist: ['pharmacy'],
}

type Target = 'myself' | 'triage' | Station

/**
 * Register first, then send. Once the patient is found or registered, whoever registered
 * decides where the visit starts from what the patient comes for: "I see this patient myself"
 * (the person who treats: the visit starts at their desk, already theirs), the triage nurse, a
 * desk by service, and one of that desk's departments; with what the patient comes for. With
 * "triage first" on (Settings), the visit starts at triage unless it is an emergency or the
 * person treating sees the patient themselves.
 */
export function SendPatientCard({
  user,
  patient,
  mode,
  emergency = false,
  triageFirst = false,
  lastVisit,
  onStarted,
  onLater,
  className,
}: {
  user: StaffUser
  patient: { id: string; name: string; fileNumber: string }
  /** register: the file was just made; visit: a returning patient. */
  mode: 'register' | 'visit'
  emergency?: boolean
  triageFirst?: boolean
  /** When the patient last came; null = never; undefined = not known here. */
  lastVisit?: { at: string; count: number } | null
  onStarted: (r: VisitResult) => void
  /** register: "Only the file for now"; visit: cancel. */
  onLater: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const actions = useVisitActions()
  const { data: departments = [] } = useDepartments()
  const role = user.dbRole ?? user.role
  const myDesk = stationFor(user)
  const mayMyself = (MY_DESKS[role] ?? []).includes(myDesk)
  const deskOnly = triageFirst && !emergency
  const [target, setTarget] = useState<Target>(
    // the person who treats sees the patient first; otherwise the nurse measures first
    mayMyself ? 'myself' : 'triage',
  )
  const [departmentId, setDepartmentId] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onLater()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLater])

  const station: Station = target === 'myself' ? myDesk : target === 'triage' ? 'triage' : target
  // the departments that work at the chosen desk (a department belongs to a desk by its roles)
  const deskDepartments =
    target === 'myself' || target === 'triage'
      ? []
      : departments.filter((d) => (d.roles as string[]).includes(DESK_ROLE[station]))
  const deskName = (s: Station) => t(`register.stations.${s}`)

  const start = async () => {
    setError(null)
    try {
      const r = await actions.beginVisit.mutateAsync({
        patientId: patient.id,
        fileNumber: patient.fileNumber,
        station,
        departmentId: departmentId || null,
        note,
        myself: target === 'myself',
        emergency,
      })
      onStarted(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const option = (key: Target, icon: ReactNode, title: string, hint: string, disabled = false) => (
    <label
      key={key}
      className={cn(
        'border-border flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5',
        target === key && 'border-primary bg-primary-tint',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        name={`send-${patient.id}`}
        className="accent-primary mt-1"
        checked={target === key}
        disabled={disabled}
        onChange={() => {
          setTarget(key)
          setDepartmentId('')
        }}
      />
      <span className="text-primary mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="text-ink-3 block text-[13px]">{hint}</span>
      </span>
    </label>
  )

  // the visit's destination in the button: what will happen when it is pressed
  const where =
    target === 'myself'
      ? t('sendPatient.goMyself')
      : deskOnly && target !== 'triage'
        ? t('sendPatient.goTo', { desk: deskName('triage') })
        : t('sendPatient.goTo', { desk: deskName(station) })

  return (
    <Card className={cn(emergency ? 'border-red' : 'border-primary', 'anim-enter', className)}>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          {mode === 'register' ? (
            <FilePlus2 size={16} aria-hidden="true" />
          ) : (
            <Send size={16} aria-hidden="true" />
          )}
          {t(mode === 'register' ? 'sendPatient.titleNew' : 'sendPatient.title', {
            name: patient.name,
          })}
        </span>
        <span className="text-ink-3 text-xs tabular-nums">{patient.fileNumber}</span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[13px]">
          {mode === 'register' ? t('sendPatient.leadNew') : t('sendPatient.lead')}
        </p>
        {lastVisit !== undefined && (
          <p className="text-ink-3 m-0 inline-flex items-center gap-1.5 text-[13px]">
            <History size={14} aria-hidden="true" />
            {lastVisit
              ? t('visitConfirm.last', {
                  date: formatDate(new Date(lastVisit.at)),
                  count: lastVisit.count,
                })
              : t('visitConfirm.first')}
          </p>
        )}
        {emergency && (
          <p className="bg-red-bg text-red m-0 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold">
            <Siren size={16} aria-hidden="true" />
            {t('sendPatient.emergency')}
          </p>
        )}

        <div className="pc:grid-cols-2 grid grid-cols-1 gap-2" role="radiogroup">
          {mayMyself &&
            option(
              'myself',
              <UserRoundCheck size={18} aria-hidden="true" />,
              t('sendPatient.myself'),
              t('sendPatient.myselfHint', { desk: deskName(myDesk) }),
            )}
          {option(
            'triage',
            <Activity size={18} aria-hidden="true" />,
            t('sendPatient.triage'),
            t('sendPatient.triageHint'),
          )}
        </div>

        <span className="text-ink-2 text-[13px] font-semibold">{t('sendPatient.byService')}</span>
        {deskOnly && (
          <p className="bg-amber-bg text-amber m-0 rounded-lg px-3 py-2 text-[13px]">
            {t('sendPatient.triageFirstOn')}
          </p>
        )}
        <div className="pc:grid-cols-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TREATING_STATIONS.map((s) => {
            const Icon = stationIconFor(s)
            return option(
              s,
              <Icon size={18} aria-hidden="true" />,
              deskName(s),
              t(`sendPatient.for.${s}`),
              deskOnly,
            )
          })}
        </div>

        {deskDepartments.length > 0 && (
          <Select
            label={t('sendPatient.department')}
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            wrapperClassName="max-w-md"
          >
            <option value="">{t('sendPatient.anyone', { desk: deskName(station) })}</option>
            {deskDepartments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
        {departmentId && (
          <p className="text-ink-3 m-0 inline-flex items-center gap-1.5 text-[13px]">
            <Building2 size={14} aria-hidden="true" />
            {t('sendPatient.departmentHint')}
          </p>
        )}

        <Field
          label={t('sendPatient.why')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('sendPatient.whyPh')}
        />

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant={emergency ? 'danger' : 'primary'}
            size="lg"
            loading={actions.beginVisit.isPending}
            onClick={() => void start()}
          >
            {where}
          </Button>
          <Button variant="ghost" size="lg" onClick={onLater}>
            {t(mode === 'register' ? 'sendPatient.later' : 'staff.form.cancel')}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
