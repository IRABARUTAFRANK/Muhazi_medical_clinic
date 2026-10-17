import { useState, type CSSProperties, type FormEvent } from 'react'
import { ArrowLeft, Check, FolderOpen, Pencil, Stethoscope, Ticket } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { StaffLink } from '@/components/staff/staff-link'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  ageSexOf,
  usePatientActions,
  usePatientFile,
  type PatientFile,
  type PatientRecord,
} from '@/lib/api/patients'
import {
  TREATING_STATIONS,
  stationFor,
  useVisitActions,
  type Sex,
  type Station,
} from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'

type Tab = 'overview' | 'visits' | 'clinical' | 'bills'
const TABS: Tab[] = ['overview', 'visits', 'clinical', 'bills']
const errorBox = 'bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[13px] font-semibold'

/**
 * The patient file. Header with identity, allergies and the current visit; tabs for the
 * editable overview, visit history, clinical record (vitals and diagnoses) and bills.
 * Starting a visit from here follows the same rule as registration: triage first, unless
 * it is an emergency.
 */
export function PatientFilePage({
  user,
  patientId,
  initialTab,
}: {
  user: StaffUser
  patientId: string
  initialTab?: string
}) {
  const { t } = useTranslation()
  const { data, isLoading, error } = usePatientFile(patientId)
  const [tab, setTab] = useState<Tab>(
    TABS.includes(initialTab as Tab) ? (initialTab as Tab) : 'overview',
  )
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const visitActions = useVisitActions()
  const [emergency, setEmergency] = useState(false)
  const myStation = stationFor(user)
  const [station, setStation] = useState<Station>(
    TREATING_STATIONS.includes(myStation) ? myStation : 'consultation',
  )

  const openVisit = data?.visits.find((v) => v.status === 'open')
  const p = data?.patient

  const startVisit = async () => {
    if (!p) return
    setActionError(null)
    try {
      const r = await visitActions.startVisit.mutateAsync({
        patient: {
          id: p.id,
          fileNumber: p.file_number,
          surname: p.surname,
          givenNames: p.given_names,
          sex: p.sex,
          birthDate: p.birth_date,
          phone: p.phone_1,
          hasOpenVisit: false,
        },
        visit: { emergency, station },
      })
      setNotice(
        t('file.visitStarted', {
          ticket: r.ticketNo,
          station: t(`register.stations.${r.station}`),
        }),
      )
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="patients">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <StaffLink
          to="/app/patients"
          className="text-ink-2 inline-flex items-center gap-1 text-[13px] no-underline"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {t('file.back')}
        </StaffLink>
        {isLoading && <p className="text-ink-3 m-0">…</p>}
        {error && (
          <p role="alert" className={errorBox}>
            {error.message}
          </p>
        )}
        {(actionError || notice) && (
          <p
            role={actionError ? 'alert' : 'status'}
            className={
              actionError
                ? errorBox
                : 'bg-green-bg text-green m-0 rounded-xl px-3 py-2 text-[13px] font-semibold'
            }
          >
            {actionError ?? notice}
          </p>
        )}

        {data && p && (
          <>
            {/* Header */}
            <Card className="anim-enter">
              <CardBody className="flex-row flex-wrap items-center gap-x-5 gap-y-3">
                <span className="bg-primary-tint text-primary inline-flex size-14 flex-none items-center justify-center rounded-2xl text-lg font-extrabold">
                  {initials(p)}
                </span>
                <span className="min-w-[220px] flex-1">
                  <span className="block text-xl font-bold">
                    {p.surname} {p.given_names}
                  </span>
                  <span className="text-ink-3 block text-[13px] tabular-nums">
                    {p.file_number} · {ageSexOf(p.birth_date, p.sex)}
                    {p.birth_date
                      ? ` · ${formatDate(new Date(p.birth_date))}${p.age_estimated ? ` (${t('file.estimated')})` : ''}`
                      : ''}
                    {p.phone_1 ? ` · ${p.phone_1}` : ''}
                    {p.sector ? ` · ${p.sector}` : ''}
                  </span>
                </span>
                {p.blood_group && <Chip>{p.blood_group}</Chip>}
                {!!p.flags.vip && <Chip>VIP</Chip>}
                {openVisit ? (
                  <StaffLink
                    to="/app/visit"
                    search={{ encounter: openVisit.id }}
                    className={buttonVariants({ variant: 'primary' })}
                  >
                    <Stethoscope size={16} aria-hidden="true" />
                    {t('file.openVisit', {
                      station: openVisit.currentStation
                        ? t(`register.stations.${openVisit.currentStation}`)
                        : '',
                    })}
                  </StaffLink>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => void startVisit()}
                    loading={visitActions.startVisit.isPending}
                  >
                    <Ticket size={16} aria-hidden="true" />
                    {t(emergency ? 'register.submitEmergency' : 'file.startVisit')}
                  </Button>
                )}
                <Button onClick={() => setEditing((e) => !e)}>
                  <Pencil size={16} aria-hidden="true" />
                  {t(editing ? 'staff.form.cancel' : 'file.edit')}
                </Button>
              </CardBody>
              {p.allergies && (
                <CardBody className="bg-red-bg text-red border-border rounded-b-[16px] border-t py-2 text-[13px] font-semibold">
                  ⚠ {t('file.allergiesLabel')}: {p.allergies}
                </CardBody>
              )}
              {!openVisit && (
                <CardBody className="border-border flex-row flex-wrap items-end gap-3 border-t">
                  <label className="flex min-h-11 items-center gap-2 text-[13px] font-semibold">
                    <input
                      type="checkbox"
                      className="accent-red size-[18px]"
                      checked={emergency}
                      onChange={(e) => setEmergency(e.target.checked)}
                    />
                    {t('register.emergency')}
                  </label>
                  {emergency && (
                    <Select
                      label={t('register.station')}
                      value={station}
                      onChange={(e) => setStation(e.target.value as Station)}
                      wrapperClassName="w-56"
                    >
                      {TREATING_STATIONS.map((s) => (
                        <option key={s} value={s}>
                          {t(`register.stations.${s}`)}
                        </option>
                      ))}
                    </Select>
                  )}
                  <span className="text-ink-3 text-xs">
                    {t(emergency ? 'register.emergencyHint' : 'register.triageHint')}
                  </span>
                </CardBody>
              )}
            </Card>

            {editing && (
              <EditForm
                patient={p}
                onDone={() => {
                  setEditing(false)
                  setNotice(t('file.saved'))
                }}
                onError={setActionError}
              />
            )}

            {/* Tabs */}
            <div
              className="anim-enter flex flex-wrap gap-1 rounded-xl bg-white/60 p-1"
              style={{ '--i': 1 } as CSSProperties}
              role="tablist"
            >
              {TABS.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    'min-h-10 rounded-lg px-4 text-[13px] font-semibold transition-colors',
                    tab === k ? 'bg-navy shadow-card text-white' : 'text-ink-2 hover:bg-hover',
                  )}
                >
                  {t(`file.tabs.${k}`)}
                  {k === 'visits' && ` · ${data.visits.length}`}
                  {k === 'bills' && data.bills.some((b) => b.balance > 0) && ' · ⚠'}
                </button>
              ))}
            </div>

            <div key={tab} className="flex flex-col gap-4">
              {tab === 'overview' && <Overview file={data} />}
              {tab === 'visits' && <Visits file={data} />}
              {tab === 'clinical' && <Clinical file={data} />}
              {tab === 'bills' && <Bills file={data} />}
            </div>
          </>
        )}
      </main>
    </StaffShell>
  )
}

const initials = (p: PatientRecord) =>
  `${p.surname[0] ?? ''}${p.given_names[0] ?? ''}`.toUpperCase()
const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

function Info({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-ink-3 text-[11px] font-semibold tracking-[.04em] uppercase">
        {label}
      </span>
      <span className="text-[14px] font-medium">{value == null || value === '' ? '—' : value}</span>
    </div>
  )
}

function Overview({ file }: { file: PatientFile }) {
  const { t } = useTranslation()
  const p = file.patient
  const f = (k: string) => t(`file.fields.${k}`)
  return (
    <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
      <Card className="anim-enter">
        <CardHeader>
          <span>{t('file.identity')}</span>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Info label={f('file_number')} value={p.file_number} />
          <Info label={f('national_id')} value={p.national_id} />
          <Info label={f('sex')} value={t(`register.sexes.${p.sex}`)} />
          <Info
            label={f('birth_date')}
            value={
              p.birth_date
                ? `${formatDate(new Date(p.birth_date))} · ${ageSexOf(p.birth_date, 'unknown')}`
                : null
            }
          />
          <Info label={f('phone_1')} value={p.phone_1} />
          <Info label={f('phone_2')} value={p.phone_2} />
          <Info label={f('district')} value={p.district} />
          <Info label={f('sector')} value={p.sector} />
          <Info label={f('cell')} value={[p.cell, p.village].filter(Boolean).join(' · ')} />
          <Info label={f('occupation')} value={p.occupation} />
          <Info label={f('ubudehe_category')} value={p.ubudehe_category} />
          <Info label={f('language')} value={p.language} />
          <Info label={f('registered')} value={when(p.created_at)} />
        </CardBody>
      </Card>
      <Card className="anim-enter" style={{ '--i': 1 } as CSSProperties}>
        <CardHeader>
          <span>{t('file.medical')}</span>
        </CardHeader>
        <CardBody className="gap-3">
          <Info label={f('blood_group')} value={p.blood_group} />
          <div
            className={cn(
              'rounded-xl px-3 py-2',
              p.allergies ? 'bg-red-bg text-red' : 'bg-hover text-ink-2',
            )}
          >
            <span className="block text-[11px] font-semibold tracking-[.04em] uppercase">
              {f('allergies')}
            </span>
            <span className="font-medium">{p.allergies ?? t('file.noAllergies')}</span>
          </div>
          <Info
            label={f('emergency')}
            value={[p.emergency_name, p.emergency_phone].filter(Boolean).join(' · ')}
          />
          <Info label={f('notes')} value={p.notes} />
        </CardBody>
      </Card>
    </div>
  )
}

function EditForm({
  patient: p,
  onDone,
  onError,
}: {
  patient: PatientRecord
  onDone: () => void
  onError: (m: string | null) => void
}) {
  const { t } = useTranslation()
  const actions = usePatientActions(p.id)
  const f = (k: string) => t(`file.fields.${k}`)
  const [v, setV] = useState<Record<string, string>>({
    surname: p.surname,
    given_names: p.given_names,
    sex: p.sex,
    birth_date: p.birth_date ?? '',
    age_years: '',
    national_id: p.national_id ?? '',
    phone_1: p.phone_1 ?? '',
    phone_2: p.phone_2 ?? '',
    district: p.district ?? '',
    sector: p.sector ?? '',
    cell: p.cell ?? '',
    village: p.village ?? '',
    occupation: p.occupation ?? '',
    ubudehe_category: p.ubudehe_category == null ? '' : String(p.ubudehe_category),
    emergency_name: p.emergency_name ?? '',
    emergency_phone: p.emergency_phone ?? '',
    blood_group: p.blood_group ?? '',
    allergies: p.allergies ?? '',
    notes: p.notes ?? '',
  })
  const set = (k: string, val: string) => setV((s) => ({ ...s, [k]: val }))
  const text = (k: string, extra: Record<string, unknown> = {}) => (
    <Field
      key={k}
      label={f(k)}
      value={v[k] ?? ''}
      onChange={(e) => set(k, e.target.value)}
      {...extra}
    />
  )
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    onError(null)
    try {
      const fields: Record<string, string | number | null> = { ...v }
      if (!v.birth_date && v.age_years) fields.age_years = Number(v.age_years)
      else delete fields.age_years
      await actions.update.mutateAsync(fields)
      onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <Card className="border-primary anim-enter">
      <CardHeader>
        <span>{t('file.editTitle')}</span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {text('surname', { required: true })}
            {text('given_names', { required: true })}
            <Select
              label={f('sex')}
              value={v.sex}
              onChange={(e) => set('sex', e.target.value as Sex)}
            >
              {(['female', 'male', 'other', 'unknown'] as Sex[]).map((s) => (
                <option key={s} value={s}>
                  {t(`register.sexes.${s}`)}
                </option>
              ))}
            </Select>
            {text('birth_date', { type: 'date', max: new Date().toISOString().slice(0, 10) })}
            <Field
              label={t('register.ageYears')}
              inputMode="numeric"
              value={v.age_years ?? ''}
              onChange={(e) => {
                set('age_years', e.target.value.replace(/\D/g, '').slice(0, 3))
                set('birth_date', '')
              }}
              placeholder={t('register.agePh')}
            />
            {text('national_id', { inputMode: 'numeric' })}
            {text('phone_1', { type: 'tel' })}
            {text('phone_2', { type: 'tel' })}
            {text('district')}
            {text('sector')}
            {text('cell')}
            {text('village')}
            {text('occupation')}
            {text('ubudehe_category', { inputMode: 'numeric' })}
            {text('blood_group', { placeholder: 'O+' })}
            {text('emergency_name')}
            {text('emergency_phone', { type: 'tel' })}
          </div>
          {text('allergies', { placeholder: t('file.allergiesPh'), className: 'border-red/60' })}
          {text('notes')}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={actions.update.isPending}>
              <Check size={16} aria-hidden="true" />
              {t('file.save')}
            </Button>
          </div>
        </CardBody>
      </form>
    </Card>
  )
}

function Visits({ file }: { file: PatientFile }) {
  const { t } = useTranslation()
  if (file.visits.length === 0)
    return (
      <Card className="anim-enter">
        <CardBody>
          <p className="text-ink-3 m-0 text-[13px]">{t('file.noVisits')}</p>
        </CardBody>
      </Card>
    )
  return (
    <Card className="anim-enter">
      {file.visits.map((v, i) => (
        <Row
          key={v.id}
          className="flex-wrap gap-x-4 gap-y-1 py-3"
          style={{ '--i': i } as CSSProperties}
        >
          <span className="min-w-[200px] flex-1">
            <span className="block font-semibold tabular-nums">{when(v.arrivedAt)}</span>
            <span className="text-ink-3 block text-xs">
              {[v.practitioner, v.stations.map((s) => t(`register.stations.${s}`)).join(' → ')]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {v.triage && <Badge tone={v.triage}>{t(`home.triage.${v.triage}`)}</Badge>}
          <span className="min-w-[160px] text-[13px]">
            {v.diagnosis ?? <span className="text-ink-3">{t('file.noDiagnosis')}</span>}
          </span>
          <span className="font-semibold tabular-nums">
            {v.total != null ? formatRwf(v.total) : '—'}
          </span>
          {v.status === 'open' ? (
            <Badge tone="blue">
              {t('file.visitOpen', {
                station: v.currentStation ? t(`register.stations.${v.currentStation}`) : '',
              })}
            </Badge>
          ) : (
            <Badge tone="green">{t('file.visitClosed')}</Badge>
          )}
          <StaffLink
            to="/app/visit"
            search={{ encounter: v.id }}
            className={buttonVariants({ size: 'sm' })}
          >
            <FolderOpen size={14} aria-hidden="true" />
            {t('common.open')}
          </StaffLink>
        </Row>
      ))}
    </Card>
  )
}

function Clinical({ file }: { file: PatientFile }) {
  const { t } = useTranslation()
  const latest = new Map<string, (typeof file.vitals)[number]>()
  for (const v of file.vitals) if (!latest.has(v.code)) latest.set(v.code, v)
  return (
    <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
      <Card className="anim-enter">
        <CardHeader>
          <span>{t('file.latestVitals')}</span>
          <span className="text-ink-3 text-xs">
            {latest.size ? when([...latest.values()][0]!.at) : ''}
          </span>
        </CardHeader>
        <CardBody className="flex-row flex-wrap gap-2">
          {latest.size === 0 && <p className="text-ink-3 m-0 text-[13px]">{t('file.noVitals')}</p>}
          {[...latest.values()].map((v) => (
            <Chip key={v.code}>
              {t(`triage.vitals.${v.code}`)}:{' '}
              <b className="ml-1 tabular-nums">{v.value ?? v.text}</b>
              {v.unit ? ` ${v.unit}` : ''}
            </Chip>
          ))}
        </CardBody>
      </Card>
      <Card className="anim-enter" style={{ '--i': 1 } as CSSProperties}>
        <CardHeader>
          <span>{t('file.diagnoses')}</span>
          <span className="text-ink-3 text-xs">{file.conditions.length}</span>
        </CardHeader>
        {file.conditions.length === 0 && (
          <CardBody>
            <p className="text-ink-3 m-0 text-[13px]">{t('file.noDiagnosis')}</p>
          </CardBody>
        )}
        {file.conditions.map((c) => (
          <Row key={c.id} className="flex-wrap gap-x-3 gap-y-1 py-2">
            <span className="min-w-[160px] flex-1">
              <span className="block font-semibold">
                {c.text}
                {c.icd10 ? <span className="text-ink-3 ml-2 text-xs">{c.icd10}</span> : null}
              </span>
              <span className="text-ink-3 block text-xs">
                {[when(c.at), c.by].filter(Boolean).join(' · ')}
              </span>
            </span>
            <Badge tone={c.type === 'primary' ? 'blue' : 'grey'} dot={false}>
              {t(`clinical.type.${c.type}`)}
              {c.provisional ? ` · ${t('clinical.provisional')}` : ''}
            </Badge>
          </Row>
        ))}
      </Card>
    </div>
  )
}

function Bills({ file }: { file: PatientFile }) {
  const { t } = useTranslation()
  const due = file.bills.reduce((s, b) => s + b.balance, 0)
  return (
    <Card className="anim-enter">
      <CardHeader>
        <span>{t('file.tabs.bills')}</span>
        <span
          className={cn('text-xs font-semibold tabular-nums', due > 0 ? 'text-red' : 'text-ink-3')}
        >
          {t('patients.owes', { amount: formatRwf(due) })}
        </span>
      </CardHeader>
      {file.bills.length === 0 && (
        <CardBody>
          <p className="text-ink-3 m-0 text-[13px]">{t('file.noBills')}</p>
        </CardBody>
      )}
      {file.bills.map((b) => (
        <Row key={b.invoiceId} className="flex-wrap gap-x-4 gap-y-1 py-2">
          <span className="min-w-[180px] flex-1">
            <span className="block font-semibold tabular-nums">
              {b.number ?? t('file.draftBill')}
            </span>
            <span className="text-ink-3 block text-xs">
              {[when(b.at), b.payer ?? t('visit.payer.cash')].join(' · ')}
            </span>
          </span>
          <span className="tabular-nums">{formatRwf(b.total)}</span>
          {b.insurerShare > 0 && (
            <Chip>
              {t('visit.charges.insurerPays', { name: b.payer ?? '' })} {formatRwf(b.insurerShare)}
            </Chip>
          )}
          <Badge tone={b.balance > 0 ? 'orange' : 'green'}>
            {b.balance > 0
              ? t('patients.owes', { amount: formatRwf(b.balance) })
              : t('visit.payment.paidBadge')}
          </Badge>
          <StaffLink
            to="/app/visit"
            search={{ encounter: b.encounterId }}
            className={buttonVariants({ size: 'sm' })}
          >
            {t('common.open')}
          </StaffLink>
        </Row>
      ))}
    </Card>
  )
}
