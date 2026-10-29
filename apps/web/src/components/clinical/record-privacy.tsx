import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity,
  Eye,
  HeartPulse,
  Lock,
  Pill,
  ShieldAlert,
  ShieldCheck,
  Siren,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { EmptyNote } from '@/components/clinical/empty-note'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Reveal } from '@/components/ui/reveal'
import { ShownList } from '@/components/ui/list-tools'
import { usePatientFile, useVisitClinical } from '@/lib/api/patients'
import {
  usePatientAccessLog,
  useRecordAccessActions,
  type AccessLogRow,
  type PatientAccess,
  type SafetySummary,
} from '@/lib/api/privacy'
import { supabase } from '@/lib/supabase'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { vitalName } from '@/lib/api/vitals'

/**
 * Patient record privacy on the screens (migration 0088): the "Past records are private"
 * notice with Request access and Emergency access, the access in force until the visit closes,
 * the safety summary (level 2), the hidden safety fields (level 1) and "Who looked".
 * The database decides; these only show what it returned.
 */

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
/** Keeps a unit next to its value inside a chip (a plain space is lost there). */
const NBSP = String.fromCharCode(160)
const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'

/**
 * "Past records are private": how many past visits are hidden, my request (waiting, refused),
 * and the Request access / Emergency access buttons for someone treating the patient now.
 * When an approved request or an emergency access is in force: until when, and why.
 * `visit`: shown on a visit whose record is private (instead of its clinical record).
 */
export function PrivacyNotice({
  patientId,
  patientName,
  access,
  visit = false,
  visitOpen = false,
  onMessage,
}: {
  patientId: string
  patientName: string
  access: PatientAccess
  /** On the visit page, for a private visit. */
  visit?: boolean
  /** That visit is still open (its record is for the people working on it). */
  visitOpen?: boolean
  onMessage?: (m: string) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const actions = useRecordAccessActions()
  const [mode, setMode] = useState<'request' | 'emergency' | null>(null)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const req = access.request
  const granted = access.via === 'request' || access.via === 'emergency'

  if (granted && !visit) {
    const emergency = access.via === 'emergency'
    return (
      <p
        className={cn(
          'm-0 flex flex-wrap items-start gap-2 rounded-md px-3 py-2.5 text-[14px]',
          emergency ? 'bg-red-bg text-red' : 'bg-green-bg text-green',
        )}
      >
        {emergency ? (
          <Siren size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
        ) : (
          <ShieldCheck size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <b className="block">
            {emergency
              ? t('recordPrivacy.grantedEmergency', { patient: patientName })
              : req?.answeredBy
                ? t('recordPrivacy.grantedBy', { name: req.answeredBy, patient: patientName })
                : t('recordPrivacy.granted', { patient: patientName })}
          </b>
          {req?.reason && (
            <span className="text-ink-2 block text-[13px]">
              {t('recordPrivacy.yourReason', { reason: req.reason })}
            </span>
          )}
        </span>
      </p>
    )
  }

  const run = async (e: FormEvent) => {
    e.preventDefault()
    if (!mode) return
    const why = reason.trim()
    if (why.length < 3) {
      setErr(t('recordPrivacy.reasonShort'))
      return
    }
    setErr(null)
    const emergency = mode === 'emergency'
    if (
      !(await confirm({
        title: t(emergency ? 'recordPrivacy.confirm.emergency' : 'recordPrivacy.confirm.request', {
          name: patientName,
        }),
        body: t(
          emergency ? 'recordPrivacy.confirm.emergencyBody' : 'recordPrivacy.confirm.requestBody',
        ),
        confirmLabel: t(
          emergency ? 'recordPrivacy.confirm.emergencyYes' : 'recordPrivacy.confirm.requestYes',
        ),
        tone: emergency ? 'danger' : 'primary',
      }))
    )
      return
    try {
      const input = { patientId, encounterId: access.treatingEncounterId, reason: why }
      if (emergency) {
        await actions.emergency.mutateAsync(input)
        onMessage?.(t('recordPrivacy.opened'))
      } else {
        const r = await actions.request.mutateAsync(input)
        onMessage?.(t(r.existing ? 'recordPrivacy.sentExisting' : 'recordPrivacy.sent'))
      }
      setMode(null)
      setReason('')
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }

  const withdraw = async () => {
    if (!req) return
    if (
      !(await confirm({
        title: t('recordPrivacy.confirm.cancel', { name: patientName }),
        body: t('recordPrivacy.confirm.cancelBody'),
        confirmLabel: t('recordPrivacy.confirm.cancelYes'),
      }))
    )
      return
    setErr(null)
    try {
      await actions.cancel.mutateAsync(req.id)
      onMessage?.(t('recordPrivacy.withdrawn'))
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }

  const open = (m: 'request' | 'emergency') => {
    setErr(null)
    setMode((cur) => (cur === m ? null : m))
  }
  const asking = !!access.treatingEncounterId
  const busy = actions.request.isPending || actions.emergency.isPending

  return (
    <Card className="border-violet/40 anim-enter">
      <CardBody className="gap-2.5">
        <p className="text-violet m-0 flex items-start gap-2 text-[16px] font-semibold">
          <Lock size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
          {visit
            ? t(visitOpen ? 'recordPrivacy.visitTitleOpen' : 'recordPrivacy.visitTitle')
            : t('recordPrivacy.title')}
        </p>
        <p className="text-ink-2 m-0 text-[14px]">
          {visit
            ? t(visitOpen ? 'recordPrivacy.visitOpenLead' : 'recordPrivacy.visitLead')
            : access.hiddenVisits > 0
              ? t('recordPrivacy.hiddenCount', { count: access.hiddenVisits, name: patientName })
              : t('recordPrivacy.lead')}
          {(!visit || !visitOpen) && ` ${t('recordPrivacy.who')}`}
          {access.canRequest
            ? ` ${t('recordPrivacy.canAsk')}`
            : access.canEmergency && ` ${t('recordPrivacy.canEmergencyOnly')}`}
        </p>
        {access.ownVisits > 0 && !visit && (
          <p className="text-ink-3 m-0 text-[13px]">
            {t('recordPrivacy.ownShown', { count: access.ownVisits })}
          </p>
        )}

        {req?.status === 'pending' && (
          <div className="bg-amber-bg/70 flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-[13px]">
            <span className="min-w-[min(200px,100%)] flex-1">
              <b className="block">{t('recordPrivacy.pending', { when: when(req.at) })}</b>
              <span className="text-ink-2">
                {t('recordPrivacy.yourReason', { reason: req.reason })}
              </span>
            </span>
            <Button size="sm" loading={actions.cancel.isPending} onClick={() => void withdraw()}>
              {t('recordPrivacy.cancelRequest')}
            </Button>
          </div>
        )}
        {req?.status === 'refused' && (
          <p className="bg-red-bg text-red border-red/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold">
            {req.answeredBy
              ? t('recordPrivacy.refusedBy', { name: req.answeredBy, note: req.answerNote ?? '' })
              : t('recordPrivacy.refused', { note: req.answerNote ?? '' })}
          </p>
        )}

        {(access.canRequest || access.canEmergency) && (
          <div className="flex flex-wrap gap-2">
            {access.canRequest && (
              <Button
                size="sm"
                variant={mode === 'request' ? 'primary' : 'default'}
                onClick={() => open('request')}
              >
                <ShieldCheck size={14} aria-hidden="true" />
                {t('recordPrivacy.request')}
              </Button>
            )}
            {access.canEmergency && (
              <Button size="sm" variant="danger" onClick={() => open('emergency')}>
                <Siren size={14} aria-hidden="true" />
                {t('recordPrivacy.emergency')}
              </Button>
            )}
          </div>
        )}
        {!asking && !req && access.hiddenVisits > 0 && (
          <p className="text-ink-3 m-0 text-[13px]">{t('recordPrivacy.notTreating')}</p>
        )}

        {mode && (
          <Reveal focus block="nearest">
            <form
              onSubmit={(e) => void run(e)}
              className={cn(
                'flex flex-col gap-2 rounded-md border px-3 py-3',
                mode === 'emergency' ? 'border-red/50 bg-red-bg/40' : 'border-border bg-hover/50',
              )}
            >
              <p className="text-ink-2 m-0 text-[13px]">
                {t(
                  mode === 'emergency'
                    ? 'recordPrivacy.emergencyLead'
                    : 'recordPrivacy.requestLead',
                )}
              </p>
              <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
                {t(
                  mode === 'emergency'
                    ? 'recordPrivacy.emergencyReason'
                    : 'recordPrivacy.reasonLabel',
                )}
                <textarea
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t(
                    mode === 'emergency'
                      ? 'recordPrivacy.emergencyReasonPh'
                      : 'recordPrivacy.reasonPh',
                  )}
                  required
                  className="border-border bg-card text-ink focus:border-primary focus:ring-primary-tint rounded-md border px-3 py-2 text-[14px] font-normal outline-none focus:ring-[3px]"
                />
              </label>
              <span className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant={mode === 'emergency' ? 'danger' : 'primary'}
                  loading={busy}
                >
                  {t(mode === 'emergency' ? 'recordPrivacy.openNow' : 'recordPrivacy.send')}
                </Button>
                <Button variant="ghost" onClick={() => setMode(null)}>
                  {t('recordPrivacy.back')}
                </Button>
              </span>
            </form>
          </Reveal>
        )}
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
      </CardBody>
    </Card>
  )
}

/** Level 1: the safety fields are not shown (not "none"). */
export function SafetyHiddenNote({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <p
      className={cn(
        'bg-hover text-ink-2 m-0 flex items-start gap-2 rounded-md px-3 py-2 text-[13px]',
        className,
      )}
    >
      <Lock size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      {t('safetySummary.hidden')}
    </p>
  )
}

function Part({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-ink-3 inline-flex items-center gap-1.5 text-[12px] font-medium">
        {icon}
        {title}
      </span>
      {children}
    </div>
  )
}

/**
 * The safety summary (level 2): allergies, blood group, alerts, long-term conditions, the
 * medicines being taken and the last vital signs. For whoever treats the patient now.
 */
export function SafetySummaryCard({
  summary,
  patientName,
  className,
  collapseKey,
}: {
  summary: SafetySummary
  patientName: string
  className?: string
  /** On the visit page: the allergies stay in view, the rest folds; open the first time this
   *  patient is seen on this browser, closed after (remembered under this key). */
  collapseKey?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(() => !collapseKey || !seenBefore(collapseKey))
  useEffect(() => {
    if (collapseKey) markSeen(collapseKey)
  }, [collapseKey])
  const none = <span className="text-ink-3 text-[13px]">{t('safetySummary.none')}</span>
  return (
    <Card className={cn('anim-enter', className)}>
      <CardHeader hue="coral">
        <span className="inline-flex items-center gap-2">
          <ShieldAlert size={16} aria-hidden="true" />
          {t('safetySummary.title')}
        </span>
        <span className="inline-flex items-center gap-2">
          {summary.bloodGroup && (
            <Badge tone="grey" dot={false}>
              {t('file.fields.blood_group')} {summary.bloodGroup}
            </Badge>
          )}
          {collapseKey && (
            <Button size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {t(open ? 'safetySummary.less' : 'safetySummary.more')}
            </Button>
          )}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        {open && (
          <p className="text-ink-3 m-0 text-xs">{t('safetySummary.lead', { name: patientName })}</p>
        )}
        <div
          className={cn(
            'rounded-md px-3 py-2',
            summary.allergies ? 'bg-red-bg text-red' : 'bg-hover text-ink-2',
          )}
        >
          <span className="block text-[12px] font-medium">{t('file.fields.allergies')}</span>
          <span className="font-semibold">
            {summary.allergies ??
              (summary.allergiesNone ? t('safetySummary.noKnown') : t('safetySummary.notRecorded'))}
          </span>
        </div>
        {!open &&
          (summary.chronic.length > 0 || summary.medications.length > 0 || summary.alerts) && (
            <p className="text-ink-3 m-0 text-xs">
              {t('safetySummary.folded', {
                chronic: summary.chronic.length,
                medicines: summary.medications.length,
              })}
            </p>
          )}
        {open && summary.alerts && (
          <p className="bg-amber-bg/70 m-0 rounded-md px-3 py-2 text-[13px]">
            <b>{t('safetySummary.alerts')}:</b> {summary.alerts}
          </p>
        )}
        <div className={cn('grid grid-cols-1 gap-3 md:grid-cols-3', !open && 'hidden')}>
          <Part
            icon={<HeartPulse size={12} aria-hidden="true" />}
            title={t('safetySummary.chronic')}
          >
            {summary.chronic.length === 0
              ? none
              : summary.chronic.map((c, i) => (
                  <span key={i} className="text-[14px]">
                    <b>{c.text}</b>
                    {c.icd10 ? <span className="text-ink-3 ml-1.5 text-xs">{c.icd10}</span> : null}
                    <span className="text-ink-3 block text-xs">
                      {t('safetySummary.since', { date: formatDate(new Date(c.since)) })}
                    </span>
                  </span>
                ))}
          </Part>
          <Part icon={<Pill size={12} aria-hidden="true" />} title={t('safetySummary.medications')}>
            {summary.medications.length === 0
              ? none
              : summary.medications.map((m, i) => (
                  <span key={i} className="text-[14px]">
                    <b>{m.item}</b>
                    <span className="text-ink-2 block text-xs">
                      {[
                        m.dose,
                        m.frequency
                          ? t(`clinical.frequencies.${m.frequency}`, { defaultValue: m.frequency })
                          : null,
                        m.until
                          ? t('safetySummary.until', { date: formatDate(new Date(m.until)) })
                          : null,
                        m.by,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                ))}
          </Part>
          <Part
            icon={<Activity size={12} aria-hidden="true" />}
            title={t('safetySummary.lastVitals')}
          >
            {summary.lastVitals.length === 0 ? (
              none
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {summary.lastVitals.map((v) => (
                  <Chip key={v.code} title={[when(v.at), v.by].filter(Boolean).join(' · ')}>
                    {vitalName(v, t)}: <b className="ml-1 tabular-nums">{v.value ?? '—'}</b>
                    {v.unit ? `${NBSP}${v.unit}` : ''}
                  </Chip>
                ))}
              </span>
            )}
          </Part>
        </div>
      </CardBody>
    </Card>
  )
}

const SEEN_KEY = 'mmc.safetySummary.seen'
/** Was the safety summary of this patient opened here before (a per-browser convenience)? */
function seenBefore(key: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown
    return Array.isArray(seen) && seen.includes(key)
  } catch {
    return false
  }
}
function markSeen(key: string) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown
    const list = (Array.isArray(seen) ? seen : []).filter((k): k is string => typeof k === 'string')
    if (!list.includes(key))
      localStorage.setItem(SEEN_KEY, JSON.stringify([key, ...list].slice(0, 200)))
  } catch {
    // private window or blocked storage: the card simply opens each time
  }
}

/**
 * The safety summary on the visit page (for the people treating the patient): read from the
 * patient file, already cached when coming from it. Nothing when the level does not allow it.
 */
export function VisitSafetySummary({
  patientId,
  patientName,
  className,
}: {
  patientId: string
  patientName: string
  className?: string
}) {
  const { data } = usePatientFile(patientId)
  if (!data?.summary) return null
  return (
    <SafetySummaryCard
      summary={data.summary}
      patientName={patientName}
      className={className}
      collapseKey={patientId}
    />
  )
}

/** "Who looked": every opening of the patient's past records (manager, heads in charge). */
export function WhoLookedCard({ patientId, className }: { patientId: string; className?: string }) {
  const { t } = useTranslation()
  const { data: rows = [], isLoading } = usePatientAccessLog(patientId)
  return (
    <Card className={cn('anim-enter', className)}>
      <CardHeader hue="coral">
        <span className="inline-flex items-center gap-2">
          <Eye size={16} aria-hidden="true" />
          {t('whoLooked.title')}
        </span>
        <span className="text-ink-3 text-xs">{rows.length}</span>
      </CardHeader>
      <CardBody className="pb-1">
        <p className="text-ink-3 m-0 text-xs">{t('whoLooked.lead')}</p>
      </CardBody>
      {isLoading ? (
        <CardBody>
          <p className="text-ink-3 m-0 text-[13px]">…</p>
        </CardBody>
      ) : rows.length === 0 ? (
        <CardBody>
          <EmptyNote>{t('whoLooked.empty')}</EmptyNote>
        </CardBody>
      ) : (
        <ShownList items={rows} step={6} footerClassName="px-4 py-2">
          {(shown) => shown.map((r) => <LookedRow key={r.id} r={r} />)}
        </ShownList>
      )}
    </Card>
  )
}

function LookedRow({ r }: { r: AccessLogRow }) {
  const { t } = useTranslation()
  const role = r.actorRole ? t(`staff.roles.${r.actorRole}`, { defaultValue: r.actorRole }) : null
  return (
    <Row
      className={cn('flex-wrap items-start gap-x-3 gap-y-1 py-2', r.emergency && 'bg-red-bg/50')}
    >
      <span className="min-w-[min(200px,100%)] flex-1">
        <span className={cn('block font-semibold', r.emergency && 'text-red')}>
          {[r.actor ?? '—', role].filter(Boolean).join(' · ')}
        </span>
        <span className="text-ink-3 block text-xs tabular-nums">
          {[
            when(r.at),
            t(`whoLooked.what.${r.what}`),
            r.visitReference ? t('whoLooked.visitRef', { ref: r.visitReference }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {r.reason && (
          <span className="text-ink-2 block text-[13px]">
            {t('whoLooked.reason', { reason: r.reason })}
          </span>
        )}
        {r.emergency && (
          <span className="text-ink-3 block text-xs">
            {r.reviewed
              ? t('whoLooked.reviewed', { name: r.reviewedBy ?? '—' }) +
                (r.reviewNote ? ` · ${r.reviewNote}` : '')
              : t('whoLooked.toReview')}
          </span>
        )}
      </span>
      <Badge
        tone={r.emergency ? 'red' : r.via === 'request' ? 'orange' : 'grey'}
        dot={false}
        icon={r.emergency ? <Siren size={12} aria-hidden="true" /> : undefined}
      >
        {t(`whoLooked.via.${r.via}`)}
      </Badge>
    </Row>
  )
}

/** Sample mode: the sample visits whose record follows the privacy rules (Habimana Eric's). */
const SAMPLE_PAST: Record<string, string> = { 'e-8': 'p-2' }

/**
 * On the visit page: the visit's clinical record when it may be seen, otherwise the
 * "private" notice with what may be asked (visit_clinical's private / access).
 */
export function VisitRecordGate({
  encounterId,
  patientId,
  patientName,
  onMessage,
  children,
}: {
  encounterId: string
  patientId: string
  patientName: string
  onMessage?: (m: string) => void
  children: ReactNode
}) {
  const { data } = useVisitClinical(encounterId)
  const samplePatient = !supabase ? SAMPLE_PAST[encounterId] : undefined
  if (samplePatient)
    return (
      <SampleVisitGate encounterId={encounterId} patientId={samplePatient} onMessage={onMessage}>
        {children}
      </SampleVisitGate>
    )
  if (data?.private && data.access)
    return (
      <PrivacyNotice
        visit
        visitOpen={data.visit?.status === 'open'}
        patientId={patientId}
        patientName={patientName}
        access={data.access}
        onMessage={onMessage}
      />
    )
  if (data?.private) return <PrivateVisitPlain />
  return <>{children}</>
}

function PrivateVisitPlain() {
  const { t } = useTranslation()
  return (
    <p className="bg-violet-bg text-violet border-violet/30 m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-semibold">
      <Lock size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
      {t('recordPrivacy.visitTitle')}
    </p>
  )
}

/** Sample mode: the visit's privacy read from the sample patient file. */
function SampleVisitGate({
  encounterId,
  patientId,
  onMessage,
  children,
}: {
  encounterId: string
  patientId: string
  onMessage?: (m: string) => void
  children: ReactNode
}) {
  const { data: f } = usePatientFile(patientId)
  const v = f?.visits.find((x) => x.id === encounterId)
  if (!f || !v) return null
  if (!v.private || !f.access) return <>{children}</>
  return (
    <PrivacyNotice
      visit
      visitOpen={v.status === 'open'}
      patientId={patientId}
      patientName={`${f.patient.surname} ${f.patient.given_names}`}
      access={f.access}
      onMessage={onMessage}
    />
  )
}
