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
import { StaffShell } from '@/components/staff/staff-shell'
import { NewPatientForm } from '@/components/clinical/new-patient-form'
import { useFindPatients, type PatientHit, type VisitResult } from '@/lib/api/visits'
import { SendPatientCard } from '@/components/clinical/send-patient-card'
import { useStaffSettings } from '@/lib/api/settings'
import { navForUser } from '@/lib/nav'
import { canRegisterEmergency } from '@/lib/roles'
import { cn } from '@/lib/utils'
import { useCan } from '@/lib/api/permissions'

/**
 * Registration from any desk: register first, then send. The patient is found (returning) or
 * registered (a new file); then whoever registers chooses where the visit starts from what the
 * patient comes for: "I see this patient myself" (the person who treats), the triage nurse, a
 * desk by service and its department, or only the file for now. Emergency: red priority at the
 * chosen desk, first in line.
 */
export function RegisterPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [emergency, setEmergency] = useState(false)
  const [result, setResultState] = useState<VisitResult | null>(null)
  // The patient whose visit is being started (found or just registered): "Where does the patient go?"
  const [sending, setSending] = useState<{
    id: string
    name: string
    fileNumber: string
    isNew: boolean
  } | null>(null)
  const [savedOnly, setSavedOnly] = useState<string | null>(null)
  const navigate = useNavigate()
  // Seen by me: straight to the work (the visit; a nurse at triage to the measurements).
  const setResult = (r: VisitResult | null) => {
    if (r?.myself && r.station === 'triage')
      void navigate({ to: '/app/vitals', search: { encounter: r.encounterId } })
    else if (r?.myself) void navigate({ to: '/app/visit', search: { encounter: r.encounterId } })
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

  const mayStart = useCan(user)('visit.start')
  const send = (p: PatientHit) => {
    setError(null)
    setResultState(null)
    setSavedOnly(null)
    setSending({
      id: p.id,
      name: `${p.surname} ${p.givenNames}`,
      fileNumber: p.fileNumber,
      isNew: false,
    })
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
                    ? 'register.flowTriageFirst'
                    : 'register.flow',
              )}
            </p>
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

        {savedOnly && (
          <p className="bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
            {savedOnly}
          </p>
        )}

        {/* Register first, then send: where the visit starts */}
        {sending && (
          <SendPatientCard
            key={sending.id}
            user={user}
            patient={sending}
            mode={sending.isNew ? 'register' : 'visit'}
            emergency={emergency}
            triageFirst={triageFirst}
            onStarted={(r) => {
              setSending(null)
              setResult(r)
            }}
            onLater={() => {
              if (sending.isNew)
                setSavedOnly(
                  t('register.savedOnly', { name: sending.name, file: sending.fileNumber }),
                )
              setSending(null)
            }}
          />
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
                      disabled={sending?.id === p.id || !mayStart}
                      title={mayStart ? undefined : t('perms.blocked.visit')}
                      onClick={() => send(p)}
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
            describe={describe}
            nurse={user.role === 'nurse'}
            onRegistered={(f) => {
              setError(null)
              setResultState(null)
              setSavedOnly(null)
              // a person not allowed to start visits keeps the file only
              if (!mayStart)
                setSavedOnly(t('register.savedOnly', { name: f.name, file: f.fileNumber }))
              else
                setSending({ id: f.patientId, name: f.name, fileNumber: f.fileNumber, isNew: true })
            }}
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
