import { useState, type FormEvent } from 'react'
import { AlertTriangle, Search, UserPlus, Check, Ticket } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { PageBanner } from '@/components/dash/page-banner'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  TREATING_STATIONS,
  stationFor,
  useFindPatients,
  useVisitActions,
  type PatientHit,
  type Sex,
  type Station,
  type VisitResult,
} from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

const SEXES: readonly Sex[] = ['female', 'male', 'other', 'unknown']

/**
 * Registration from any station (MoH workflow). Normal path: the patient is queued at triage
 * for vitals first. Emergency: the staff member registering keeps the patient at their own
 * station (red triage, top of the queue) and can register the file afterwards.
 */
export function RegisterPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const actions = useVisitActions()
  const myStation = stationFor(user)
  const [query, setQuery] = useState('')
  const [emergency, setEmergency] = useState(false)
  const [station, setStation] = useState<Station>(
    TREATING_STATIONS.includes(myStation) ? myStation : 'consultation',
  )
  const [result, setResultState] = useState<VisitResult | null>(null)
  const navigate = useNavigate()
  // The nurse sees the patient first: once registered, she goes straight to the measurements.
  const setResult = (r: VisitResult | null) => {
    if (r && user.role === 'nurse' && r.station === 'triage')
      void navigate({ to: '/app/vitals', search: { encounter: r.encounterId } })
    else setResultState(r)
  }
  const [error, setError] = useState<string | null>(null)
  const { data: hits = [], isFetching } = useFindPatients(query)

  const describe = (e: unknown): string => {
    const m = e instanceof Error ? e.message : String(e)
    if (/open visit/i.test(m)) return t('register.errors.openVisit')
    if (/national ID/i.test(m)) return t('register.errors.nationalId', { message: m })
    return t('register.errors.generic', { message: m })
  }

  const startVisit = async (p: PatientHit) => {
    setError(null)
    try {
      setResult(await actions.startVisit.mutateAsync({ patient: p, visit: { emergency, station } }))
    } catch (e) {
      setError(describe(e))
    }
  }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="register">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={UserPlus}
          tint="teal"
          title={t('register.title')}
          lead={t('register.lead')}
          user={user}
        />

        {/* Visit options apply to both an existing and a new patient */}
        <Card className={cn(emergency && 'border-red')}>
          <CardBody className="gap-3">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 font-semibold">
              <input
                type="checkbox"
                className="accent-red size-5"
                checked={emergency}
                onChange={(e) => setEmergency(e.target.checked)}
              />
              <AlertTriangle size={18} className={emergency ? 'text-red' : 'text-ink-3'} />
              {t('register.emergency')}
            </label>
            <p className="text-ink-2 m-0 text-[13px]">
              {t(emergency ? 'register.emergencyHint' : 'register.triageHint')}
            </p>
            {emergency && (
              <Select
                label={t('register.station')}
                value={station}
                onChange={(e) => setStation(e.target.value as Station)}
                wrapperClassName="max-w-xs"
              >
                {TREATING_STATIONS.map((s) => (
                  <option key={s} value={s}>
                    {t(`register.stations.${s}`)}
                  </option>
                ))}
              </Select>
            )}
          </CardBody>
        </Card>

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
          >
            {error}
          </p>
        )}

        {result && (
          <ResultCard
            result={result}
            onAnother={() => {
              setResult(null)
              setQuery('')
            }}
          />
        )}

        <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
          {/* Existing patient */}
          <Card>
            <CardHeader>
              <span className="inline-flex items-center gap-2">
                <Search size={16} aria-hidden="true" />
                {t('register.search')}
              </span>
              <span className="text-ink-3 text-xs">{isFetching ? '…' : ''}</span>
            </CardHeader>
            <CardBody className="gap-3">
              <Field
                label={t('register.searchLabel')}
                placeholder={t('register.searchPh')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
              />
              {query.trim().length >= 2 && hits.length === 0 && !isFetching && (
                <p className="text-ink-3 m-0 text-[13px]">{t('register.noMatch')}</p>
              )}
              {hits.map((p) => (
                <Row key={p.id} className="flex-wrap gap-x-3 gap-y-1 py-2">
                  <span className="min-w-[160px] flex-1">
                    <span className="block font-semibold">
                      {p.surname} {p.givenNames}
                    </span>
                    <span className="text-ink-3 text-xs tabular-nums">
                      {p.fileNumber} · {t(`register.sexes.${p.sex}`)}
                      {p.birthDate ? ` · ${p.birthDate}` : ''}
                      {p.phone ? ` · ${p.phone}` : ''}
                    </span>
                  </span>
                  {p.hasOpenVisit ? (
                    <Badge tone="blue">{t('register.openVisit')}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant={emergency ? 'danger' : 'primary'}
                      disabled={actions.startVisit.isPending}
                      onClick={() => void startVisit(p)}
                    >
                      <Ticket size={16} aria-hidden="true" />
                      {t('register.startVisit')}
                    </Button>
                  )}
                </Row>
              ))}
            </CardBody>
          </Card>

          {/* New patient */}
          <NewPatientForm
            emergency={emergency}
            station={station}
            onDone={setResult}
            describe={describe}
            nurse={user.role === 'nurse'}
          />
        </div>
      </main>
    </StaffShell>
  )
}

function NewPatientForm({
  emergency,
  station,
  onDone,
  describe,
  nurse = false,
}: {
  emergency: boolean
  station: Station
  onDone: (r: VisitResult) => void
  describe: (e: unknown) => string
  /** The nurse registers what she can; reception completes phone, ID and address later. */
  nurse?: boolean
}) {
  const { t } = useTranslation()
  const actions = useVisitActions()
  const [surname, setSurname] = useState('')
  const [givenNames, setGivenNames] = useState('')
  const [sex, setSex] = useState<Sex>('unknown')
  const [birthDate, setBirthDate] = useState('')
  const [age, setAge] = useState('')
  const [phone, setPhone] = useState('')
  const [nationalId, setNationalId] = useState('')
  const [sector, setSector] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setSurname('')
    setGivenNames('')
    setSex('unknown')
    setBirthDate('')
    setAge('')
    setPhone('')
    setNationalId('')
    setSector('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (nationalId && nationalId.replace(/\D/g, '').length !== 16)
      return setError(t('register.errors.nationalIdFormat'))
    try {
      const r = await actions.register.mutateAsync({
        patient: {
          surname,
          givenNames,
          sex,
          birthDate: birthDate || undefined,
          ageYears: !birthDate && age ? Number(age) : undefined,
          phone: phone || undefined,
          nationalId: nationalId || undefined,
          sector: sector || undefined,
        },
        visit: { emergency, station },
      })
      reset()
      onDone(r)
    } catch (err) {
      setError(describe(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <UserPlus size={16} aria-hidden="true" />
          {t('register.newPatient')}
        </span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <p className="text-ink-2 bg-primary-tint/60 m-0 rounded-lg px-3 py-2 text-xs">
            {t(nurse ? 'files.nurseHint' : 'files.receptionHint')}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t('register.surname')}
              value={surname}
              onChange={(e) => setSurname(e.target.value)}
              autoComplete="off"
              required
            />
            <Field
              label={t('register.givenNames')}
              value={givenNames}
              onChange={(e) => setGivenNames(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select
              label={t('register.sex')}
              value={sex}
              onChange={(e) => setSex(e.target.value as Sex)}
            >
              {SEXES.map((s) => (
                <option key={s} value={s}>
                  {t(`register.sexes.${s}`)}
                </option>
              ))}
            </Select>
            <Field
              label={t('register.birthDate')}
              type="date"
              value={birthDate}
              onChange={(e) => {
                // A date of birth wins: it fills the age; typing an age clears the date.
                setBirthDate(e.target.value)
                setAge(e.target.value ? String(yearsSince(e.target.value)) : '')
              }}
              max={new Date().toISOString().slice(0, 10)}
            />
            <Field
              label={t('register.ageYears')}
              inputMode="numeric"
              value={age}
              onChange={(e) => {
                setAge(e.target.value.replace(/\D/g, '').slice(0, 3))
                setBirthDate('')
              }}
              placeholder={t('register.agePh')}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t('register.phone')}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="07xx xxx xxx"
            />
            <Field
              label={t('register.nationalId')}
              inputMode="numeric"
              value={nationalId}
              onChange={(e) => setNationalId(e.target.value.replace(/\D/g, '').slice(0, 16))}
              placeholder="1 1990 8 …"
            />
            <Field
              label={t('register.sector')}
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              placeholder="Kiramuruzi"
            />
          </div>
          {error && (
            <p
              role="alert"
              className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold"
            >
              {error}
            </p>
          )}
          <Button
            type="submit"
            variant={emergency ? 'danger' : 'primary'}
            size="lg"
            className="self-start"
            disabled={actions.register.isPending}
          >
            {actions.register.isPending
              ? t('register.submitting')
              : t(
                  emergency
                    ? 'register.submitEmergency'
                    : nurse
                      ? 'files.submitNurse'
                      : 'register.submit',
                )}
          </Button>
        </CardBody>
      </form>
    </Card>
  )
}

/** Whole years between a YYYY-MM-DD date and today. */
const yearsSince = (iso: string): number => {
  const b = new Date(iso)
  const n = new Date()
  let y = n.getFullYear() - b.getFullYear()
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) y -= 1
  return Math.max(0, y)
}

function ResultCard({ result, onAnother }: { result: VisitResult; onAnother: () => void }) {
  const { t } = useTranslation()
  const triage = result.station === 'triage'
  return (
    <Card className={triage ? 'border-green' : 'border-red'}>
      <CardHeader>
        <span>{t('register.done.title')}</span>
        <Badge tone={triage ? 'green' : 'red'} icon={<Check size={12} strokeWidth={3} />}>
          {t(`register.stations.${result.station}`)}
        </Badge>
      </CardHeader>
      <CardBody className="gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="border-border bg-surface rounded-lg border px-4 py-2 text-2xl font-bold tabular-nums">
            {result.ticketNo}
          </span>
          <Chip>{result.fileNumber}</Chip>
          <span className="text-ink-2 text-[13px]">
            {t(triage ? 'register.done.triageNote' : 'register.done.emergencyNote', {
              station: t(`register.stations.${result.station}`),
            })}
          </span>
        </div>
        <p className="text-ink-2 m-0 text-[13px]">{t('register.done.where')}</p>
        <div className="flex flex-wrap gap-2">
          {triage && (
            <StaffLink
              to="/app/vitals"
              search={{ encounter: result.encounterId }}
              className={buttonVariants({ variant: 'primary' })}
            >
              {t('register.done.takeVitals')}
            </StaffLink>
          )}
          <StaffLink
            to="/app/patient"
            search={{ id: result.patientId }}
            className={buttonVariants({ variant: triage ? 'default' : 'primary' })}
          >
            {t('register.done.openFile')}
          </StaffLink>
          <StaffLink
            to="/app/visit"
            search={{ encounter: result.encounterId }}
            className={buttonVariants({ variant: 'default' })}
          >
            {t('register.done.openVisit')}
          </StaffLink>
          <StaffLink to="/app/patients" className={buttonVariants({ variant: 'default' })}>
            {t('register.done.register')}
          </StaffLink>
          <Button variant="ghost" onClick={onAnother}>
            {t('register.another')}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
