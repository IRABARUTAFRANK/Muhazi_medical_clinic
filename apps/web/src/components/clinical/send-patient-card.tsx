import { useEffect, useState, type ReactNode } from 'react'
import {
  Activity,
  Baby,
  FilePlus2,
  FlaskConical,
  History,
  Pill,
  Ribbon,
  Scan,
  Scissors,
  Send,
  Siren,
  Smile,
  Stethoscope,
  Syringe,
  UserRoundCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, type StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import {
  SERVICES,
  SERVICE_DESK,
  useServiceStaff,
  type ServiceId,
  type ServicePerson,
  type ServiceStaff,
} from '@/lib/api/services'
import { stationFor, useVisitActions, type Station, type VisitResult } from '@/lib/api/visits'
import { useReveal } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/** The desks a person may start a visit with "I see this patient myself" (the database agrees). */
const MY_DESKS: Record<string, Station[]> = {
  doctor: ['consultation', 'dental', 'theatre', 'ultrasound'],
  nurse: ['triage', 'nursing', 'beds'],
  lab_tech: ['laboratory'],
  sonographer: ['ultrasound'],
  pharmacist: ['pharmacy'],
}

const SERVICE_ICON: Record<ServiceId, LucideIcon> = {
  consultation: Stethoscope,
  dental: Smile,
  laboratory: FlaskConical,
  ultrasound: Scan,
  nursing: Syringe,
  surgery: Scissors,
  circ: Scissors,
  fp: Baby,
  hiv: Ribbon,
  pharmacy: Pill,
}

type Target = 'myself' | 'triage' | ServiceId

/**
 * Register first, then send. Once the patient is found or registered, whoever registered
 * decides where the visit starts from what the patient comes for: "I see this patient myself"
 * (the person who treats), the triage nurse, or one of the clinic's services, which is its
 * section; then anyone in that section or one person of it, seeing who works now and how many
 * patients each already has. With "triage first" on (Settings), the nurse measures first and
 * the patient then goes to the service and person chosen.
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
  const role = user.dbRole ?? user.role
  const myDesk = stationFor(user)
  const mayMyself = (MY_DESKS[role] ?? []).includes(myDesk)
  const viaTriage = triageFirst && !emergency
  const [target, setTarget] = useState<Target>(
    // the person who treats sees the patient first; otherwise the nurse measures first
    mayMyself ? 'myself' : 'triage',
  )
  const service = target === 'myself' || target === 'triage' ? null : target
  const [person, setPerson] = useState<string>('') // '' = anyone in the section
  // the visit starts at triage (chosen, or "triage first" before a service): which nurse
  const atTriage = target === 'triage' || (viaTriage && !!service)
  const [nurse, setNurse] = useState<string>('') // '' = any nurse at triage
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { data: staff, isLoading: staffLoading } = useServiceStaff(service)
  const { data: nurses, isLoading: nursesLoading } = useServiceStaff(atTriage ? 'triage' : null)
  // it opens at the top of the page while the button pressed is lower: bring it into view, the
  // cursor on the chosen option (arrow keys change it)
  const ref = useReveal<HTMLElement>({ focus: true })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onLater()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onLater])

  const station: Station =
    target === 'myself' ? myDesk : target === 'triage' ? 'triage' : SERVICE_DESK[target]
  const serviceName = (s: ServiceId) =>
    s === 'pharmacy' ? t('register.stations.pharmacy') : t(`categories.${s}`)
  const chosen = staff?.staff.find((p) => p.id === person)
  const chosenNurse = nurses?.staff.find((p) => p.id === nurse)

  const start = async () => {
    setError(null)
    try {
      const r = await actions.beginVisit.mutateAsync({
        patientId: patient.id,
        fileNumber: patient.fileNumber,
        station,
        service,
        assignedTo: service && person ? person : null,
        triageTo: atTriage && nurse ? nurse : null,
        note,
        myself: target === 'myself',
        emergency,
      })
      onStarted(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const option = (key: Target, icon: ReactNode, title: string, hint: string) => (
    <label
      key={key}
      className={cn(
        'border-border flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5',
        target === key && 'border-primary bg-primary-tint',
      )}
    >
      <input
        type="radio"
        name={`send-${patient.id}`}
        className="accent-primary mt-1"
        checked={target === key}
        onChange={() => {
          setTarget(key)
          setPerson('')
          setNurse('')
        }}
      />
      <span className="text-primary mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="text-ink-3 block text-[13px]">{hint}</span>
      </span>
    </label>
  )

  // the button says what will happen
  const where =
    target === 'myself'
      ? t('sendPatient.goMyself')
      : target === 'triage'
        ? chosenNurse
          ? t('sendPatient.goToPerson', { name: chosenNurse.name })
          : t('sendPatient.goTo', { desk: t('register.stations.triage') })
        : viaTriage
          ? t('sendPatient.goViaTriage', { service: serviceName(target) })
          : chosen
            ? t('sendPatient.goToPerson', { name: chosen.name })
            : t('sendPatient.goTo', { desk: serviceName(target) })

  return (
    <Card
      ref={ref}
      className={cn(emergency ? 'border-red' : 'border-primary', 'anim-enter', className)}
    >
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
              t('sendPatient.myselfHint', { desk: t(`register.stations.${myDesk}`) }),
            )}
          {option(
            'triage',
            <Activity size={18} aria-hidden="true" />,
            t('sendPatient.triage'),
            t('sendPatient.triageHint'),
          )}
        </div>

        {/* triage chosen: the nurses at triage, so the patient goes to the one meant */}
        {target === 'triage' && (
          <WhoPicker
            name={`nurse-${patient.id}`}
            title={t('sendPatient.whoTitle', { service: t('register.stations.triage') })}
            anyone={t('sendPatient.anyoneIn', { service: t('register.stations.triage') })}
            data={nurses}
            loading={nursesLoading}
            value={nurse}
            onChange={setNurse}
            empty={t('sendPatient.noNurse')}
          />
        )}

        <span className="text-ink-2 text-[13px] font-semibold">{t('sendPatient.byService')}</span>
        {viaTriage && (
          <p className="bg-amber-bg text-amber m-0 rounded-lg px-3 py-2 text-[13px]">
            {t('sendPatient.triageFirstThen')}
          </p>
        )}
        <div
          className="pc:grid-cols-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-label={t('sendPatient.byService')}
        >
          {SERVICES.map((s) => {
            const Icon = SERVICE_ICON[s]
            return option(
              s,
              <Icon size={18} aria-hidden="true" />,
              serviceName(s),
              t(`sendPatient.svc.${s}`),
            )
          })}
        </div>

        {/* the chosen service is the section: anyone in it, or one person of it */}
        {service && (
          <WhoPicker
            name={`who-${patient.id}`}
            title={t('sendPatient.whoTitle', { service: serviceName(service) })}
            anyone={t('sendPatient.anyoneIn', { service: serviceName(service) })}
            data={staff}
            loading={staffLoading}
            value={person}
            onChange={setPerson}
            empty={t('sendPatient.nobody', { service: serviceName(service) })}
          />
        )}
        {/* "triage first": the nurse who measures before the service */}
        {service && viaTriage && (
          <WhoPicker
            name={`nurse-${patient.id}`}
            title={t('sendPatient.whoMeasures')}
            anyone={t('sendPatient.anyoneIn', { service: t('register.stations.triage') })}
            data={nurses}
            loading={nursesLoading}
            value={nurse}
            onChange={setNurse}
            empty={t('sendPatient.noNurse')}
          />
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

/** "Who in …?": anyone in the section, or one person of it with what they do now. */
function WhoPicker({
  name,
  title,
  anyone,
  data,
  loading,
  value,
  onChange,
  empty,
}: {
  name: string
  title: string
  anyone: string
  data: ServiceStaff | undefined
  loading: boolean
  value: string
  onChange: (id: string) => void
  empty: string
}) {
  const { t } = useTranslation()
  return (
    <div
      className="border-border flex flex-col gap-1.5 rounded-xl border p-2.5"
      role="radiogroup"
      aria-label={title}
    >
      <span className="text-ink-2 px-1 text-[13px] font-semibold">{title}</span>
      <PersonRow
        name={name}
        checked={value === ''}
        onPick={() => onChange('')}
        title={anyone}
        detail={t('sendPatient.anyoneHint', { count: data?.sectionWaiting ?? 0 })}
        icon={<Users size={16} aria-hidden="true" />}
      />
      {data?.staff.map((p) => (
        <PersonRow
          key={p.id}
          name={name}
          checked={value === p.id}
          onPick={() => onChange(p.id)}
          title={p.name}
          detail={[
            p.specialty || t(`staff.roles.${p.role}`, { defaultValue: p.role }),
            p.departments,
          ]
            .filter(Boolean)
            .join(' · ')}
          person={p}
        />
      ))}
      {!loading && data && data.staff.length === 0 && (
        <p className="text-ink-3 m-0 px-1 text-[13px]">{empty}</p>
      )}
    </div>
  )
}

/** One choice of "send to whom?": anyone in the section, or a person with what they do now. */
function PersonRow({
  name,
  checked,
  onPick,
  title,
  detail,
  icon,
  person,
}: {
  name: string
  checked: boolean
  onPick: () => void
  title: string
  detail: string
  icon?: ReactNode
  person?: ServicePerson
}) {
  const { t } = useTranslation()
  const busy = person ? person.waiting + person.seeing : 0
  return (
    <label
      className={cn(
        'flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2.5 py-2',
        checked ? 'bg-primary-tint' : 'hover:bg-hover',
      )}
    >
      <input
        type="radio"
        name={name}
        className="accent-primary"
        checked={checked}
        onChange={onPick}
      />
      {icon && <span className="text-primary shrink-0">{icon}</span>}
      <span className="min-w-[160px] flex-1">
        <span className="block font-semibold">{title}</span>
        {detail && <span className="text-ink-3 block text-[13px]">{detail}</span>}
      </span>
      {person && (
        <span className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold">
          {/* working now by the calendar; else signed in today */}
          {person.workingNow === true ? (
            <span className="bg-green-bg text-green rounded-full px-2 py-0.5">
              {t('sendPatient.workingNow')}
            </span>
          ) : person.workingNow === false ? (
            <span className="bg-hover text-ink-3 rounded-full px-2 py-0.5">
              {t('sendPatient.notWorkingNow')}
            </span>
          ) : person.onDuty ? (
            <span className="bg-green-bg text-green rounded-full px-2 py-0.5">
              {t('sendPatient.onDuty')}
            </span>
          ) : (
            <span className="bg-hover text-ink-3 rounded-full px-2 py-0.5">
              {t('sendPatient.notSignedIn')}
            </span>
          )}
          <span
            className={cn(
              'rounded-full px-2 py-0.5 tabular-nums',
              busy === 0
                ? 'bg-green-bg text-green'
                : busy >= 5
                  ? 'bg-red-bg text-red'
                  : 'bg-amber-bg text-amber',
            )}
          >
            {busy === 0
              ? t('sendPatient.free')
              : t('sendPatient.load', { waiting: person.waiting, seeing: person.seeing })}
          </span>
        </span>
      )}
    </label>
  )
}
