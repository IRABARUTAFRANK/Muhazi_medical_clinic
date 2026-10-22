import { useState } from 'react'
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
import { NewPatientForm } from '@/components/clinical/new-patient-form'
import {
  TREATING_STATIONS,
  stationFor,
  useFindPatients,
  useVisitActions,
  type PatientHit,
  type Station,
  type VisitResult,
} from '@/lib/api/visits'
import { useStaffSettings } from '@/lib/api/settings'
import { navForUser } from '@/lib/nav'
import { canRegisterEmergency } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { StartVisitConfirm } from '@/components/clinical/start-visit-confirm'
import { useCan } from '@/lib/api/permissions'

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
  // The nurse sees the patient first: once registered, she goes straight to the measurements
  // (whatever desk the visit starts at; an emergency is treated first).
  const setResult = (r: VisitResult | null) => {
    if (r && user.role === 'nurse' && (r.station === 'triage' || !emergency))
      void navigate({ to: '/app/vitals', search: { encounter: r.encounterId } })
    else setResultState(r)
  }
  const [error, setError] = useState<string | null>(null)
  const { data: hits = [], isFetching } = useFindPatients(query)
  const { data: staffSettings } = useStaffSettings()
  const triageFirst = staffSettings?.triageFirst ?? false

  const describe = (e: unknown): string => {
    const m = e instanceof Error ? e.message : String(e)
    if (/open visit/i.test(m)) return t('register.errors.openVisit')
    if (/national ID/i.test(m)) return t('register.errors.nationalId', { message: m })
    return t('register.errors.generic', { message: m })
  }

  // The returning patient whose visit waits for "Yes" (a ticket, a queue, a new bill).
  const [confirmFor, setConfirmFor] = useState<PatientHit | null>(null)
  const nextDesk: Station = emergency ? station : triageFirst ? 'triage' : station
  const mayStart = useCan(user)('visit.start')

  const startVisit = async (p: PatientHit) => {
    setError(null)
    try {
      setResult(await actions.startVisit.mutateAsync({ patient: p, visit: { emergency, station } }))
      setConfirmFor(null)
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
        />

        {!mayStart && (
          <p className="bg-amber-bg text-amber m-0 rounded-xl px-3 py-2.5 text-[14px] font-semibold">
            {t('perms.blocked.visitBanner')}
          </p>
        )}
        {/* Visit options apply to both an existing and a new patient */}
        <Card className={cn(emergency && 'border-red')}>
          <CardBody className="gap-3">
            {canRegisterEmergency(user) && (
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
            )}
            <p className="text-ink-2 m-0 text-[13px]">
              {t(
                emergency
                  ? 'register.emergencyHint'
                  : triageFirst
                    ? 'register.triageHint'
                    : 'register.deskHint',
              )}
            </p>
            {(emergency || !triageFirst) && (
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
            emergency={emergency}
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
                  {/* the file opens from here (an open visit is reached from the file) */}
                  <StaffLink
                    to="/app/patient"
                    search={{ id: p.id }}
                    className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                  >
                    {t('patients.openFile')}
                  </StaffLink>
                  {p.hasOpenVisit ? (
                    <Badge tone="blue">{t('register.openVisit')}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant={emergency ? 'danger' : 'primary'}
                      disabled={
                        actions.startVisit.isPending || confirmFor?.id === p.id || !mayStart
                      }
                      title={mayStart ? undefined : t('perms.blocked.visit')}
                      onClick={() => setConfirmFor(p)}
                    >
                      <Ticket size={16} aria-hidden="true" />
                      {t('register.startVisit')}
                    </Button>
                  )}
                  {confirmFor?.id === p.id && (
                    <StartVisitConfirm
                      className="basis-full"
                      name={`${p.surname} ${p.givenNames}`}
                      fileNumber={p.fileNumber}
                      desk={nextDesk}
                      emergency={emergency}
                      busy={actions.startVisit.isPending}
                      onConfirm={() => void startVisit(p)}
                      onCancel={() => setConfirmFor(null)}
                    />
                  )}
                </Row>
              ))}
            </CardBody>
          </Card>

          {/* New patient */}
          <NewPatientForm
            emergency={emergency}
            station={station}
            triageFirst={triageFirst}
            onDone={setResult}
            describe={describe}
            nurse={user.role === 'nurse'}
            blocked={!mayStart}
          />
        </div>
      </main>
    </StaffShell>
  )
}

function ResultCard({
  result,
  emergency,
  onAnother,
}: {
  result: VisitResult
  emergency: boolean
  onAnother: () => void
}) {
  const { t } = useTranslation()
  const triage = result.station === 'triage'
  const station = t(`register.stations.${result.station}`)
  return (
    <Card className={emergency ? 'border-red' : 'border-green'}>
      <CardHeader>
        <span>{t('register.done.title')}</span>
        <Badge tone={emergency ? 'red' : 'green'} icon={<Check size={12} strokeWidth={3} />}>
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
            {t(
              emergency
                ? 'register.done.emergencyNote'
                : triage
                  ? 'register.done.triageNote'
                  : 'register.done.deskNote',
              { station },
            )}
          </span>
        </div>
        <p className="text-ink-2 m-0 text-[13px]">
          {t(triage ? 'register.done.where' : 'register.done.whereDesk', { station })}
        </p>
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
