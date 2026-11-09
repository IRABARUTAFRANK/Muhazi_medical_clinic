import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Activity,
  ArrowLeft,
  CalendarCheck,
  CalendarPlus,
  CheckCircle2,
  FolderOpen,
  Footprints,
  HandHelping,
  Lock,
  Plus,
  Printer,
  Receipt,
  ShieldCheck,
  Stethoscope,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Wallet,
} from 'lucide-react'
import { ChargeCoverBadge, ChargeCoverEditor } from './charge-cover'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { LeftButton } from '@/components/clinical/left-button'
import { NextPatientPanel } from '@/components/clinical/next-patient-panel'
import { OpenFileLink } from '@/components/clinical/file-panel'
import { EmptyNote } from '@/components/clinical/empty-note'
import { GlassPill, HeroHead } from '@/components/clinical/hero-head'
import { NurseTaskCard } from '@/components/clinical/nurse-task-card'
import { VitalsForm } from '@/components/clinical/vitals-form'
import { bmiOf, vitalName, vitalValue } from '@/lib/api/vitals'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { SearchSelect, type SearchOption } from '@/components/ui/search-select'
import { Select } from '@/components/ui/select'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  useBillingActions,
  useVisitBill,
  useVisitHeader,
  useVisitVitals,
  type Vital,
  type VisitBill,
} from '@/lib/api/billing'
import { treatmentName, useInsurers, useTreatments, type Treatment } from '@/lib/api/catalogue'
import { stationFor, useTakePatient, type Station } from '@/lib/api/visits'
import { useMyDepartments } from '@/lib/api/staff'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { resolveAdjust, type AdjustMode } from '@/lib/adjust'
import { AdjustField } from '@/components/ui/adjust-field'
import { Flash } from '@/components/ui/flash'
import { useVisitRouting } from '@/lib/api/referrals'
import { ClinicalCard } from './clinical-card'
import { WhereNextCard } from './where-next-card'
import { VisitTrack } from '@/components/clinical/visit-track'
import { useCan, useSwitchedOff } from '@/lib/api/permissions'
import { isDoctorUser } from '@/lib/roles'
import { NotAllowedNotice } from '@/components/clinical/perm-gate'
import { STATION_DESKS, TREATING_DESKS, useCanDesk, useMyDesks } from '@/lib/api/desks'
import { useVisitAccess } from '@/lib/api/calls'
import { HelpCard } from './help-card'
import { HandoverCard } from './handover-card'
import { PharmacyDesk } from '@/pages/stock/pharmacy-desk'
import { openReceipt } from '@/lib/receipt-doc'
import { useLetterhead } from '@/lib/report-parts'
import { useConfirm } from '@/lib/confirm'
import { stageOf, useVisitClinical } from '@/lib/api/patients'
import { useInsuranceEnabled } from '@/lib/api/settings'
import { payerLine, useInsurerTariff, usePayerLines } from '@/lib/api/insurers'
import {
  insurerLineRule,
  insurerLineText,
  insurerLineTone,
  insurerRuleSub,
} from '@/lib/insurer-price'
import { ApiError } from '@/lib/api/errors'
import { VisitRecordGate, VisitSafetySummary } from '@/components/clinical/record-privacy'
import { VisitFilesCard } from '@/components/clinical/supporting-files'
import { FollowUpForm } from '@/components/clinical/follow-up-form'
import { usePatientBookings } from '@/lib/api/follow-up'
import { Reveal } from '@/components/ui/reveal'

const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'

/**
 * One visit at a station: patient and triage, who pays, the treatments given (with the
 * discount the clinician may grant) and the patient / insurer split, then send the patient
 * to the cashier or another station. Every charge is recorded against the signed-in employee.
 */
/** The usual desks of each role (to find where this person meets the patient), kept while the
 *  person still has that desk; a department adds its own desks (below). */
const DESKS_OF: Record<string, Station[]> = {
  doctor: ['consultation', 'dental', 'theatre'],
  nurse: ['triage', 'nursing', 'beds'],
  lab_tech: ['laboratory'],
  sonographer: ['ultrasound'],
  pharmacist: ['pharmacy'],
  cashier: ['cashier'],
  receptionist: ['reception'],
}
/** The places where patients wait that a department's desk works at (not the counters). */
const DESK_STATIONS = (Object.keys(STATION_DESKS) as Station[]).filter(
  (s) => s !== 'reception' && s !== 'cashier' && (STATION_DESKS[s]?.length ?? 0) > 0,
)
const deskOf = (s: Station) => STATION_DESKS[s] ?? []

export function VisitPage({
  user,
  encounterId,
  openReport = false,
}: {
  user: StaffUser
  encounterId: string
  /** Open the medical report panel (from the patient file's "Report"). */
  openReport?: boolean
}) {
  const { t } = useTranslation()
  // The desk this person works at for this patient: the one the patient was referred to them at
  // (or handed over to them, 0088); otherwise their own station.
  const { data: routing = [] } = useVisitRouting(encounterId)
  // The desks I work at: my role's usual ones I still have, and those my departments give
  // (a doctor of the Laboratory meets the patient at the laboratory).
  const canDesk = useCanDesk(user)
  const { data: deskInfo } = useMyDesks(user)
  const myDesks: Station[] = [
    ...(DESKS_OF[user.dbRole ?? user.role] ?? []).filter(
      (s) => s === 'reception' || s === 'cashier' || canDesk(deskOf(s)),
    ),
    ...DESK_STATIONS.filter((s) => deskOf(s).some((d) => deskInfo?.via[d] === 'department')),
  ]
  // reception, the cashier and the manager keep their own way of choosing the desk below
  const inSections = !['receptionist', 'cashier', 'manager'].includes(user.role)
  const assigned =
    routing.find((r) => r.assignedTo === user.id || r.takenBy === user.id) ??
    // a desk of a section I work in, waiting for anyone there (a nurse of Consultation, a doctor
    // of Nursing): the desk and the Take button follow the section, not the role. Not a desk
    // where I only wait for the patient to come back (my lab test, my ultrasound).
    (inSections
      ? routing.find(
          (r) =>
            r.canWork !== false &&
            !r.takenBy &&
            (!r.assignedTo || r.assignedTo === user.id) &&
            r.returnTo !== user.id &&
            r.station !== 'reception' &&
            r.station !== 'cashier',
        )
      : undefined) ??
    routing.find((r) => r.canWork !== false && myDesks.includes(r.station)) ??
    // reception and the manager send on a patient wherever they wait
    (user.role === 'receptionist' || user.role === 'manager'
      ? (routing.find((r) => !r.assignedTo && !r.takenBy && r.station !== 'cashier') ??
        (user.role === 'manager' ? routing.find((r) => r.station !== 'cashier') : undefined))
      : undefined)
  const myStation = assigned?.station ?? stationFor(user)
  // a patient waiting at my desk that nobody has taken yet (opened from a notice or the list)
  const take = useTakePatient()
  const takeable =
    user.role === 'receptionist' || user.role === 'cashier'
      ? undefined
      : routing.find(
          (r) =>
            r.station === myStation &&
            !r.takenBy &&
            r.canWork !== false &&
            (!r.assignedTo || r.assignedTo === user.id),
        )
  const { data: header, isLoading, error } = useVisitHeader(encounterId)
  const { data: vitals = [] } = useVisitVitals(encounterId)
  // 0088: a visit whose clinical record this person may not see (its vital signs come empty)
  const { data: clinical } = useVisitClinical(encounterId)
  const recordPrivate = clinical?.private === true
  // 0125: book the patient's next appointment from the visit ("Book a follow-up")
  const [booking, setBooking] = useState(false)
  // the next appointment: the one booked from this visit, else the patient's next one (the
  // cashier and reception read it from the patient's bookings: it goes on the receipt)
  const { data: patientBookings } = usePatientBookings(header?.patientId ?? null)
  const comingBooking = (patientBookings?.rows ?? [])
    .filter((b) => b.upcoming && (b.status === 'approved' || b.status === 'confirmed'))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
  const nextAppt =
    clinical?.visit?.nextAppointment ??
    (comingBooking
      ? {
          id: comingBooking.id,
          at: comingBooking.startsAt,
          status: comingBooking.status,
          with: comingBooking.with,
          title: comingBooking.title,
          reason: comingBooking.reason,
          fromThisVisit: comingBooking.fromEncounter === encounterId,
        }
      : null)
  // 0127: the definitive primary diagnosis (step 5), never a possible one
  const primaryDx = (clinical?.diagnoses ?? []).find(
    (d) => d.type === 'primary' && !d.removedAt && stageOf(d) === 'definitive',
  )
  const { data: bill } = useVisitBill(encounterId)
  const { data: treatments = [] } = useTreatments(true)
  const { data: myDepartments = [] } = useMyDepartments(user.id)
  const { data: insurers = [] } = useInsurers(true)
  // insurance on (Settings → Insurance): the Who pays card and the insurer's prices (0115)
  const insurance = useInsuranceEnabled()
  const actions = useBillingActions(encounterId)
  const [member, setMember] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  /** The line being charged otherwise for this patient (0139). */
  const [coverOf, setCoverOf] = useState<string | null>(null)
  // after Finish / send-on at a treating desk: the next patient to take or call (0114)
  const [offerNext, setOfferNext] = useState(false)
  // the payment just taken, for its receipt
  const [lastPayment, setLastPayment] = useState<{
    receipt: string | null
    method: string
    amount: number
    reference: string | null
  } | null>(null)
  const letterhead = useLetterhead()
  const isManagerNav = user.role === 'manager' || user.dashboard === 'manager'
  // Reception sends patients on and completes files; treatments and the bill are not theirs.
  const isReception = user.role === 'receptionist'
  // The cashier takes the payment; vitals, treatments and the clinical record are not theirs.
  const isCashier = user.role === 'cashier'
  // What the manager allows this person (Settings → Who may do what).
  const can = useCan(user)
  // …and what the role normally does but the manager has switched off: said, not hidden
  const switchedOff = useSwitchedOff(user)
  // The desks I have (the clinical record, the pharmacy, nurse tasks), not my bare role.
  const treats = canDesk(TREATING_DESKS)
  // who books a patient (book_follow_up): a treating desk, vital signs, reception, the manager
  const mayBook =
    !isCashier &&
    (user.role === 'manager' || treats || can('vitals.write') || can('appointment.approve'))
  // Vital signs: the manager's switch; a patient waiting at triage also needs the triage desk.
  const mayVitals =
    can('vitals.write') && (canDesk('triage') || !header?.stations.includes('triage'))
  const weight = vitals.find((v) => v.code === 'weight')
  // the body mass index from weight and height (0102): shown, never saved
  const bmi = bmiOf(weight?.value, vitals.find((v) => v.code === 'height')?.value)
  // the latest vital sign measured: who measured it and when, for the medical report
  const latestVital = vitals.reduce<Vital | null>((a, v) => (!a || v.at > a.at ? v : a), null)
  // A finished visit opens read-only (it stays in the patient file).
  const closed = !!header?.closed
  // The patient belongs to the desk, department or colleague they were sent to (migration 0055):
  // others see the visit read only.
  const { data: access } = useVisitAccess(encounterId)
  const locked = !closed && access?.canWork === false
  const routeLocked = !closed && access?.canRoute === false
  const [addingVitals, setAddingVitals] = useState(false)
  /** "Measured by Chantal at 09:12 · typed by Josiane" for the nurse's paper sheet case. */
  const vitalSource = (v: Vital) => {
    const time = formatTime(new Date(v.at))
    const base = v.measuredBy
      ? t('vitalsForm.measuredLine', { name: v.measuredBy, time })
      : t('vitalsForm.measuredAtLine', { time })
    return v.enteredBy && v.measuredBy && v.enteredBy !== v.measuredBy
      ? `${base} · ${t('vitalsForm.typedBy', { name: v.enteredBy })}`
      : base
  }

  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const currentInsurer = insurers.find((i) => i.id === bill?.payerId)
  const confirm = useConfirm()
  const patientName = header?.name || t('confirm.visit.thisPatient')

  const takePatient = async (queueId: string) => {
    if (
      !(await confirm({
        title: t('confirm.visit.take', { name: patientName }),
        body: t('confirm.visit.takeBody'),
        confirmLabel: t('confirm.visit.takeYes'),
      }))
    )
      return
    try {
      await take.mutateAsync(queueId)
      setActionError(null)
      setDone(t('visit.taken'))
    } catch (e) {
      setActionError(describe(e))
    }
  }

  /** memberOnly: the "Save member number" button (the payer stays the same). */
  const choosePayer = async (payerId: string, memberOnly = false) => {
    setActionError(null)
    const ins = insurers.find((i) => i.id === payerId)
    if (
      !(await confirm(
        memberOnly
          ? {
              title: t('confirm.visit.member', { name: patientName }),
              body: t('confirm.visit.memberBody', { number: member.trim() || '—' }),
              confirmLabel: t('confirm.visit.saveYes'),
            }
          : {
              title: t('confirm.visit.payer', {
                name: patientName,
                payer: ins?.name ?? t('visit.payer.cash'),
              }),
              body: t('confirm.visit.payerBody'),
              confirmLabel: t('confirm.visit.payerYes'),
            },
      ))
    )
      return
    try {
      await actions.setPayer.mutateAsync({
        payerId: payerId || null,
        memberNumber: member,
        payerName: ins?.name,
        coveragePct: ins?.coveragePct,
      })
    } catch (e) {
      setActionError(describe(e))
    }
  }

  const removeCharge = async (id: string, item: string) => {
    const r = await confirm({
      title: t('confirm.visit.removeCharge', { item, name: patientName }),
      body: t('confirm.visit.removeChargeBody'),
      input: { label: t('visit.removeReason'), required: true, multiline: true },
      confirmLabel: t('confirm.visit.removeChargeYes'),
      tone: 'danger',
    })
    if (!r.ok) return
    setActionError(null)
    try {
      await actions.voidCharge.mutateAsync({ id, reason: r.value })
    } catch (e) {
      setActionError(describe(e))
    }
  }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="visits">
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* Where am I: managers come here from "In the clinic", staff from their queue */}
        <Link
          to={isManagerNav ? '/app/visits' : '/app'}
          className="text-ink-2 inline-flex items-center gap-1 text-[13px] no-underline"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {t(isManagerNav ? 'visit.backToClinic' : 'visit.back')}
        </Link>

        {isLoading && <p className="text-ink-3 m-0">…</p>}
        {(error || (!isLoading && !header)) && (
          <p role="alert" className={errorBox}>
            {error ? error.message : t('visit.notFound')}
          </p>
        )}

        {header && (
          <>
            {/* Patient header */}
            <Card>
              {/* The patient's band: ticket, name and tags on the clinic's gradient; the
                  actions sit on the white row under it so they keep their colours. */}
              <HeroHead icon={Stethoscope}>
                <span className="text-[24px] leading-8 font-semibold tabular-nums">
                  {header.ticket}
                </span>
                <span className="min-w-[min(200px,100%)] flex-1">
                  <span className="block text-[24px] leading-8 font-semibold">{header.name}</span>
                  <span className="block text-[13px] text-white/80 tabular-nums">
                    {header.fileNumber} · {header.ageSex}
                  </span>
                </span>
                {header.triage && (
                  <Badge tone={header.triage}>{t(`home.triage.${header.triage}`)}</Badge>
                )}
                {header.stations.map((s) => (
                  <GlassPill key={s}>{t(`register.stations.${s}`)}</GlassPill>
                ))}
              </HeroHead>
              <CardBody className="flex-row flex-wrap items-center gap-2">
                {/* the file opens beside the visit (teal tint: an action); middle-click: the whole page */}
                <OpenFileLink
                  patientId={header.patientId}
                  className={buttonVariants({ size: 'sm', variant: 'tint-teal' })}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  {t('visit.patientFile')}
                </OpenFileLink>
                {takeable && (
                  <Button
                    size="sm"
                    variant="success"
                    loading={take.isPending}
                    onClick={() => void takePatient(takeable.queueId)}
                    title={t('visit.takeHint')}
                  >
                    <HandHelping size={14} aria-hidden="true" />
                    {t('visit.take')}
                  </Button>
                )}
                {mayBook && (
                  <Button
                    size="sm"
                    variant="tint-violet"
                    aria-expanded={booking}
                    onClick={() => setBooking((b) => !b)}
                  >
                    <CalendarPlus size={14} aria-hidden="true" />
                    {t('followUp.bookFollowUp')}
                  </Button>
                )}
                {nextAppt && (
                  <Chip
                    title={nextAppt.reason ?? undefined}
                    // the date, time and doctor wrap on a phone instead of running past the card (0146)
                    className="h-auto max-w-full py-1 whitespace-normal"
                  >
                    <CalendarCheck size={14} aria-hidden="true" className="text-violet mr-1" />
                    {t('followUp.nextLine', {
                      when: `${formatDate(new Date(nextAppt.at))} ${formatTime(new Date(nextAppt.at))}`,
                      who: nextAppt.with ?? '',
                    })}
                    {nextAppt.status === 'approved' && ` · ${t('followUp.waitingAccept')}`}
                  </Chip>
                )}
                {!closed && (
                  <LeftButton
                    encounterId={encounterId}
                    name={header.name}
                    user={user}
                    onDone={(m) => {
                      setActionError(null)
                      setDone(m)
                      setOfferNext(true)
                    }}
                  />
                )}
              </CardBody>
              <CardBody className="border-border flex-row flex-wrap items-center gap-2 border-t">
                {vitals.length === 0 ? (
                  <span className="text-ink-3 text-[13px]">
                    {t(recordPrivate ? 'recordPrivacy.vitalsPrivate' : 'vitalsForm.none')}
                  </span>
                ) : (
                  <Badge tone="green" icon={<CheckCircle2 size={12} strokeWidth={3} />}>
                    {t('vitalsForm.takenShort')}
                  </Badge>
                )}
                {vitals.map((v) => (
                  <Chip key={v.id} title={vitalSource(v)}>
                    {vitalName(v, t)}: <b className="ml-1 tabular-nums">{vitalValue(v)}</b>
                    {v.unit ? ` ${v.unit}` : ''}
                  </Chip>
                ))}
                {bmi != null && (
                  <Chip title={t('vitalsForm.bmiComputed')}>
                    {t('vitals.bmi')}: <b className="ml-1 tabular-nums">{bmi}</b> kg/m²
                  </Chip>
                )}
                <span className="flex-1" />
                {!addingVitals && !closed && mayVitals && (
                  <Button size="sm" onClick={() => setAddingVitals(true)}>
                    <Activity size={14} aria-hidden="true" />
                    {t(vitals.length ? 'vitalsForm.edit' : 'vitalsForm.add')}
                  </Button>
                )}
              </CardBody>
              {vitals[0] && (
                <CardBody className="text-ink-3 -mt-2 pt-0 text-xs">
                  {vitalSource(vitals[0])}
                </CardBody>
              )}
            </Card>

            {booking && mayBook && (
              <Reveal focus>
                <Card>
                  <CardHeader icon={CalendarPlus} hue="violet">
                    <span>{t('followUp.title', { name: header.name })}</span>
                  </CardHeader>
                  <CardBody>
                    <FollowUpForm
                      user={user}
                      patient={{
                        id: header.patientId,
                        name: header.name,
                        fileNumber: header.fileNumber,
                        phone: clinical?.patient?.phone ?? null,
                      }}
                      encounterId={encounterId}
                      reason={
                        primaryDx ? t('followUp.reasonFor', { diagnosis: primaryDx.text }) : ''
                      }
                      onDone={(m) => {
                        setBooking(false)
                        setActionError(null)
                        setDone(m)
                      }}
                      onCancel={() => setBooking(false)}
                    />
                  </CardBody>
                </Card>
              </Reveal>
            )}
            {!closed && switchedOff('vitals.write') && vitals.length === 0 && (
              <NotAllowedNotice feature="vitals.write" compact />
            )}
            {!closed && vitals.length === 0 && !addingVitals && mayVitals && !recordPrivate && (
              <p className="bg-amber-bg text-amber border-amber/30 m-0 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5 text-[14px] font-semibold">
                <Activity size={18} aria-hidden="true" />
                <span className="flex-1">{t('vitalsForm.notTakenBanner')}</span>
                <Button size="sm" variant="primary" onClick={() => setAddingVitals(true)}>
                  {t('vitalsForm.add')}
                </Button>
              </p>
            )}
            {/* where the patient is in the visit: start → each desk → treatment → payment → left */}
            <VisitTrack encounterId={encounterId} />
            {closed && (
              <p className="bg-green-bg text-green border-green/30 m-0 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5 text-[14px] font-semibold">
                <CheckCircle2 size={18} aria-hidden="true" />
                {t('visit.closedBanner', {
                  when: header.closedAt
                    ? `${formatDate(new Date(header.closedAt))} ${formatTime(new Date(header.closedAt))}`
                    : '',
                })}
                {header.leftReason && (
                  <span className="text-ink-2 basis-full text-[13px] font-normal">
                    {t('visit.leftWhy', { reason: header.leftReason })}
                  </span>
                )}
              </p>
            )}

            {/* 0088: a patient handed over to me (Take / Decline), or mine waiting for an answer */}
            {!closed && access?.handover && (
              <HandoverCard
                encounterId={encounterId}
                access={access}
                patientName={header.name}
                ticket={header.ticket}
                mayHandOver={false}
                role={user.role}
                onDone={(m) => {
                  setActionError(null)
                  setDone(m)
                }}
                onError={setActionError}
              />
            )}
            {locked && !access?.handover?.forMe && (
              <p className="bg-violet-bg text-violet border-violet/30 m-0 flex flex-wrap items-start gap-2 rounded-md border px-3 py-2.5 text-[14px]">
                <Lock size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <b className="block">
                    {t('access.lockedTitle', { holder: access?.holder ?? '' })}
                  </b>
                  {t('access.lockedHint')}
                </span>
              </p>
            )}
            {!closed && access?.helping && (
              <p className="bg-primary-tint text-primary border-primary/30 m-0 flex items-center gap-2 rounded-md border px-3 py-2.5 text-[14px] font-semibold">
                <HandHelping size={18} aria-hidden="true" />
                {t('access.helpingBanner')}
              </p>
            )}

            {addingVitals && (
              <VitalsForm
                user={user}
                encounterId={encounterId}
                title={t('vitalsForm.addTitle', { name: header.name })}
                mode="add"
                existing={vitals}
                onCancel={() => setAddingVitals(false)}
                onSaved={() => {
                  setAddingVitals(false)
                  setActionError(null)
                  setDone(t('vitalsForm.saved'))
                }}
              />
            )}

            {actionError && (
              <Flash key={actionError} tone="error" onClose={() => setActionError(null)}>
                {actionError}
              </Flash>
            )}
            {!actionError && done && (
              <Flash key={done} onClose={() => setDone(null)}>
                {done}
              </Flash>
            )}
            {/* the patient was sent on or has left: who is next for this desk (0114) */}
            {offerNext && treats && !isReception && !isCashier && (
              <NextPatientPanel station={myStation} onClose={() => setOfferNext(false)} />
            )}

            {/* the pharmacy desk hands this patient's medicines over here (read only to others
                at the pharmacy; the manager, who has every desk, when working at the pharmacy) */}
            {!closed &&
              ((user.role !== 'manager' && canDesk('pharmacy')) || myStation === 'pharmacy') && (
                <PharmacyDesk canDispense={canDesk('pharmacy')} encounterId={encounterId} />
              )}
            {/* the safety summary for the people treating the patient (the database decides) */}
            {!closed && !isReception && !isCashier && (
              <VisitSafetySummary patientId={header.patientId} patientName={header.name} />
            )}
            {!isReception && !isCashier && (
              <VisitRecordGate
                encounterId={encounterId}
                patientId={header.patientId}
                patientName={header.name}
                onMessage={(m) => {
                  setActionError(null)
                  setDone(m)
                }}
              >
                <ClinicalCard
                  encounterId={encounterId}
                  patientId={header.patientId}
                  user={user}
                  station={myStation}
                  patient={{
                    name: header.name,
                    fileNumber: header.fileNumber,
                    ageSex: header.ageSex,
                    weight: weight
                      ? `${weight.value}${weight.unit ? ` ${weight.unit}` : ''}`
                      : null,
                  }}
                  report={{
                    // the visit's date: its first vital sign when nothing clinical is written yet
                    since: vitals.map((v) => v.at).sort()[0],
                    // oldest first: the report keeps the latest value of each sign
                    vitals: [...vitals]
                      .sort((a, b) => a.at.localeCompare(b.at))
                      .map((v) => ({
                        label: vitalName(v, t),
                        value: `${vitalValue(v)}${v.unit ? ` ${v.unit}` : ''}`,
                        code: v.code,
                        unit: v.unit,
                      })),
                    vitalsBy: latestVital?.measuredBy ?? latestVital?.enteredBy ?? null,
                    vitalsAt: latestVital?.at ?? null,
                    treatments: (bill?.charges ?? []).map(
                      (c) => `${c.description}${c.quantity > 1 ? ` × ${c.quantity}` : ''}`,
                    ),
                  }}
                  openReport={openReport}
                  lockedNote={
                    locked ? t('access.lockedShort', { holder: access?.holder ?? '' }) : null
                  }
                  holder={access?.holder ?? null}
                  closed={closed}
                  onDone={(m) => {
                    setActionError(null)
                    setDone(m)
                  }}
                  onError={setActionError}
                />
              </VisitRecordGate>
            )}

            {/* Doctor → nurse: tasks on this visit appear on the nurses' dashboard. Giving one
                needs a desk that treats patients; the nurse works them at the nursing desk. */}
            {(isDoctorUser(user) || user.role === 'manager') &&
              treats &&
              can('clinical.write') &&
              !locked &&
              !recordPrivate &&
              !closed && <NurseTaskCard encounterId={encounterId} patientName={header.name} />}
            {user.role === 'nurse' && canDesk('nursing') && can('clinical.write') && !closed && (
              <NurseTaskCard encounterId={encounterId} patientName={header.name} nurse />
            )}

            {/* Ask a colleague for help on this patient (or end the help) */}
            {!closed &&
              !locked &&
              !recordPrivate &&
              access &&
              can('clinical.write') &&
              treats &&
              ['doctor', 'nurse', 'manager'].includes(user.role) && (
                <HelpCard
                  encounterId={encounterId}
                  user={user}
                  access={access}
                  patientName={header.name}
                />
              )}
            {/* 0088: hand the patient over to a colleague of this desk ("Cover for me" is gone) */}
            {!closed &&
              !locked &&
              access &&
              !access.handover &&
              !isReception &&
              !isCashier &&
              treats &&
              can('clinical.write') && (
                <HandoverCard
                  encounterId={encounterId}
                  access={access}
                  patientName={header.name}
                  ticket={header.ticket}
                  mayHandOver
                  role={user.role}
                  onDone={(m) => {
                    setActionError(null)
                    setDone(m)
                  }}
                  onError={setActionError}
                />
              )}

            {/* Supporting files (0089): photos, scans and PDFs of this visit; the database
                decides who sees them and who may add one */}
            {!isReception && !isCashier && (
              <VisitFilesCard
                encounterId={encounterId}
                patientId={header.patientId}
                patientName={header.name}
                closed={closed}
              />
            )}

            <div
              className={cn(
                'grid grid-cols-1 gap-4',
                !isReception && 'pc:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]',
              )}
            >
              {!isReception && (
                <div className="flex flex-col gap-4">
                  {/* Who pays: only once the clinic works with insurers */}
                  {insurance && (
                    <Card>
                      <CardHeader icon={ShieldCheck} hue="mint">
                        <span>{t('visit.payer.title')}</span>
                        {currentInsurer && (
                          <Chip>
                            {t('prices.insurers.covers', { pct: currentInsurer.coveragePct })}
                          </Chip>
                        )}
                      </CardHeader>
                      <CardBody className="gap-3">
                        {/* the payer on its own line, the member number and its Save button under it (0142) */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:[&>:first-child]:col-span-full">
                          <Select
                            label={t('visit.payer.label')}
                            value={bill?.payerId ?? ''}
                            onChange={(e) => void choosePayer(e.target.value)}
                            disabled={bill?.status !== 'draft' && bill?.status !== null}
                          >
                            <option value="">{t('visit.payer.cash')}</option>
                            {insurers.map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.name}
                              </option>
                            ))}
                          </Select>
                          <Field
                            label={t('visit.payer.member')}
                            value={member}
                            onChange={(e) => setMember(e.target.value)}
                            placeholder={t('visit.payer.memberPh')}
                            disabled={!bill?.payerId}
                          />
                          <Button
                            type="button"
                            className="self-end"
                            disabled={!bill?.payerId || actions.setPayer.isPending}
                            onClick={() => void choosePayer(bill?.payerId ?? '', true)}
                          >
                            {t('visit.payer.saveMember')}
                          </Button>
                        </div>
                        <p className="text-ink-3 m-0 text-xs">
                          {insurers.length === 0
                            ? t('visit.payer.noInsurers')
                            : t('visit.payer.hint')}
                        </p>
                      </CardBody>
                    </Card>
                  )}

                  {/* Charges */}
                  <Card>
                    <CardHeader hue="mint">
                      <span className="inline-flex items-center gap-2">
                        <Receipt size={16} aria-hidden="true" />
                        {t('visit.charges.title')}
                      </span>
                      {bill && bill.total > 0 && <PaidMark bill={bill} />}
                    </CardHeader>
                    {(bill?.charges.length ?? 0) === 0 ? (
                      <CardBody>
                        <EmptyNote>{t('visit.charges.empty')}</EmptyNote>
                      </CardBody>
                    ) : (
                      bill!.charges.map((c) => (
                        <Row key={c.id} className="flex-wrap gap-x-4 gap-y-1 py-2">
                          <span className="min-w-[180px] flex-1">
                            <span className="block font-semibold">{c.description}</span>
                            <span className="text-ink-3 text-xs">
                              {t(`register.stations.${c.office}`)}
                              {c.enteredBy ? ` · ${c.enteredBy}` : ''}
                              {c.discountPct > 0
                                ? ` · ${t('visit.charges.discounted', { pct: c.discountPct, reason: c.discountReason ?? '' })}`
                                : ''}
                            </span>
                          </span>
                          <span className="text-ink-2 text-[13px] tabular-nums">
                            {c.quantity} × {formatRwf(c.unitPrice)}
                            {c.discountPct > 0 && (
                              <s className="text-ink-3 ml-1">{formatRwf(c.listPrice)}</s>
                            )}
                          </span>
                          {/* priced at the insurer's price: the cash price beside it (0115) */}
                          {c.cashPrice != null && c.cashPrice !== c.listPrice && (
                            <span className="text-ink-3 text-xs tabular-nums">
                              {t('visit.charges.cashPrice', { price: formatRwf(c.cashPrice) })}
                            </span>
                          )}
                          <span className="font-semibold tabular-nums">
                            {formatRwf(Math.round(c.unitPrice * c.quantity))}
                          </span>
                          {c.coveragePct > 0 && (
                            <Chip>
                              {t('visit.charges.split', {
                                patient: formatRwf(c.patientShare),
                                insurer: formatRwf(c.insurerShare),
                              })}
                            </Chip>
                          )}
                          {/* an insured visit: this line charged otherwise for this patient (0139) */}
                          {bill?.status === 'draft' && bill.payerId && can('charge.override') && (
                            <Button
                              size="sm"
                              variant={coverOf === c.id ? 'tint-amber' : 'ghost'}
                              aria-label={t('visit.cover.open')}
                              title={t('visit.cover.open')}
                              aria-expanded={coverOf === c.id}
                              onClick={() => setCoverOf(coverOf === c.id ? null : c.id)}
                            >
                              <SlidersHorizontal size={16} aria-hidden="true" />
                            </Button>
                          )}
                          {/* not on a visit held by someone else or already over (the
                              database refuses it; lines from orders: the manager) */}
                          {bill?.status === 'draft' &&
                            can('charge.write') &&
                            !locked &&
                            !closed && (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t('visit.charges.remove')}
                                onClick={() => void removeCharge(c.id, c.description)}
                              >
                                <Trash2 size={16} aria-hidden="true" />
                              </Button>
                            )}
                          {c.cover && <ChargeCoverBadge cover={c.cover} />}
                          {coverOf === c.id && bill && (
                            <ChargeCoverEditor
                              encounterId={encounterId}
                              charge={c}
                              payerName={bill.payerName ?? ''}
                              onClose={() => setCoverOf(null)}
                              onDone={(text) => {
                                setCoverOf(null)
                                setDone(text)
                              }}
                            />
                          )}
                        </Row>
                      ))
                    )}
                    <CardBody className="border-border flex-row flex-wrap items-center gap-x-6 gap-y-1 border-t">
                      <span className="text-ink-2 text-[13px]">
                        {t('visit.charges.total')}{' '}
                        <b className="text-ink text-[16px] tabular-nums">
                          {formatRwf(bill?.total ?? 0)}
                        </b>
                      </span>
                      <span className="text-ink-2 text-[13px]">
                        {t('visit.charges.patientPays')}{' '}
                        <b className="text-ink tabular-nums">
                          {formatRwf(bill?.patientShare ?? 0)}
                        </b>
                      </span>
                      {(bill?.insurerShare ?? 0) > 0 && (
                        <span className="text-ink-2 text-[13px]">
                          {t('visit.charges.insurerPays', { name: bill?.payerName ?? '' })}{' '}
                          <b className="text-ink tabular-nums">
                            {formatRwf(bill?.insurerShare ?? 0)}
                          </b>
                        </span>
                      )}
                    </CardBody>
                  </Card>
                  <WhereNextCard
                    encounterId={encounterId}
                    patientName={header.name}
                    myStation={myStation}
                    isReception={isReception}
                    closed={closed || locked}
                    onBook={mayBook ? () => setBooking(true) : undefined}
                    onDone={(m) => {
                      setActionError(null)
                      setDone(m)
                      setOfferNext(true)
                    }}
                    onError={setActionError}
                  />
                </div>
              )}

              <div className="flex flex-col gap-4">
                {/* a finished visit still owing money can be paid later (debt) */}
                {switchedOff('payment.take') && bill && (!closed || bill.balance !== 0) && (
                  <NotAllowedNotice feature="payment.take" compact />
                )}
                {/* the manager gives money back without the "Take payments" switch (as the database allows) */}
                {bill &&
                  (can('payment.take') || (user.role === 'manager' && bill.balance < 0)) &&
                  (!closed || bill.balance !== 0) && (
                    <PaymentCard
                      bill={bill}
                      open={!closed}
                      patientName={patientName}
                      onRefund={async (input) => {
                        setActionError(null)
                        try {
                          await actions.refund.mutateAsync(input)
                          setDone(t('visit.refund.done', { amount: formatRwf(input.amount) }))
                        } catch (e) {
                          setActionError(describe(e))
                          throw e
                        }
                      }}
                      onPay={async (input) => {
                        setActionError(null)
                        try {
                          const r = await actions.takePayment.mutateAsync(input)
                          setLastPayment({
                            receipt: r.receipt,
                            // the code: the receipt writes it in the reader's language
                            method: input.method,
                            amount: input.amount,
                            reference: input.reference?.trim() || null,
                          })
                          setDone(
                            r.balance > 0
                              ? t('visit.payment.partial', { balance: formatRwf(r.balance) })
                              : // a debt paid after the visit was finished: nothing goes on
                                closed
                                ? t('visit.payment.settledDebt', { receipt: r.receipt ?? '' })
                                : r.closed
                                  ? t('visit.payment.settledClosed', { receipt: r.receipt ?? '' })
                                  : t('visit.payment.settledOpen', { receipt: r.receipt ?? '' }),
                          )
                        } catch (e) {
                          setActionError(describe(e))
                          throw e
                        }
                      }}
                    />
                  )}
                {bill && header && (bill.paid > 0 || lastPayment) && (
                  <Button
                    className="self-start"
                    onClick={() => {
                      // the payment just taken, else the bill's last one (a reprint, 0084)
                      const saved = bill.lastPayment ?? null
                      const payment = lastPayment
                        ? {
                            receiptNo: lastPayment.receipt,
                            method: lastPayment.method,
                            amount: lastPayment.amount,
                            reference: lastPayment.reference,
                            at: null as string | null,
                            cashier: user.name as string | null,
                          }
                        : saved
                          ? {
                              receiptNo: saved.receiptNo,
                              method: saved.method ?? '',
                              amount: saved.amount,
                              reference: saved.reference,
                              at: saved.at,
                              cashier: saved.cashier,
                            }
                          : null
                      const ok = openReceipt(
                        {
                          receiptNo: payment?.receiptNo ?? null,
                          invoiceNo: bill.invoiceNo ?? null,
                          at: payment?.at ? new Date(payment.at) : new Date(),
                          clinic: letterhead,
                          patient: {
                            name: header.name,
                            fileNumber: header.fileNumber,
                            insurer: bill.payerName,
                            memberNo: bill.memberNo ?? null,
                          },
                          nextAppointment: nextAppt
                            ? {
                                label: t('followUp.nextLabel'),
                                text: t('followUp.nextLine', {
                                  when: `${formatDate(new Date(nextAppt.at))} ${formatTime(new Date(nextAppt.at))}`,
                                  who: nextAppt.with ?? '',
                                }),
                              }
                            : null,
                          lines: bill.charges.map((c) => ({
                            description: c.description,
                            quantity: c.quantity,
                            unitPrice: c.unitPrice,
                            cashPrice: c.cashPrice ?? undefined,
                            fullAmount: Math.round(c.unitPrice * c.quantity),
                            amount: c.patientShare,
                          })),
                          total: bill.patientShare,
                          insurer:
                            bill.insurerShare > 0
                              ? {
                                  name: bill.payerName ?? '',
                                  amount: bill.insurerShare,
                                  pct: bill.coveragePct ?? null,
                                }
                              : null,
                          // the method code: the receipt writes it in the reader's language
                          payment: payment
                            ? {
                                method: payment.method,
                                amount: payment.amount,
                                reference: payment.reference,
                              }
                            : null,
                          paid: bill.paid,
                          balance: bill.balance,
                          cashier: payment?.cashier || user.name,
                        },
                        undefined,
                        { printedBy: user.name },
                      )
                      if (!ok) setActionError(t('report.popupBlocked'))
                    }}
                    title={t('receipt.hint')}
                  >
                    <Printer size={16} aria-hidden="true" />
                    {t(
                      lastPayment || bill.lastPayment ? 'receipt.print' : 'receipt.printStatement',
                    )}
                  </Button>
                )}
                {isCashier && !closed && (
                  <p className="text-ink-3 m-0 text-[13px]">{t('visit.cashierNote')}</p>
                )}
                {!closed && !locked && switchedOff('charge.write') && (
                  <NotAllowedNotice feature="charge.write" compact />
                )}
                {!closed && !locked && can('charge.write') && (
                  <AddChargeCard
                    patientName={patientName}
                    // tests and desk work are ordered (Orders), bed nights come from the beds board
                    treatments={treatments.filter((x) => !x.orderStation && x.code !== 'BED-STAY')}
                    myDepartments={isManagerNav ? [] : myDepartments}
                    office={myStation}
                    payerId={insurance ? (bill?.payerId ?? null) : null}
                    coveragePct={currentInsurer?.coveragePct ?? 0}
                    insurerName={currentInsurer?.name ?? bill?.payerName ?? null}
                    isManager={user.role === 'manager'}
                    // only a finished bill closes the form (not one still loading or unreadable)
                    disabled={!!bill && bill.status !== null && bill.status !== 'draft'}
                    onAdd={async (input) => {
                      setActionError(null)
                      try {
                        await actions.addCharge.mutateAsync(input)
                      } catch (e) {
                        setActionError(describe(e))
                        throw e
                      }
                    }}
                  />
                )}

                {/* reception sends the patient on while the patient is with reception; once
                    sent to a desk, reception follows the visit (the track above) */}
                {isReception && !closed && routeLocked && (
                  <p className="bg-primary-tint text-primary border-primary/30 m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px]">
                    <Footprints size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
                    {t('track.followOnly')}
                  </p>
                )}
                {isReception && !routeLocked && (
                  <WhereNextCard
                    encounterId={encounterId}
                    patientName={header.name}
                    myStation={myStation}
                    isReception={isReception}
                    closed={closed}
                    onDone={(m) => {
                      setActionError(null)
                      setDone(m)
                    }}
                    onError={setActionError}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- cashier: take a payment */

/** The clinic takes cash, MTN MoMo and Airtel Money only (no card, no bank transfer). */
const METHODS = ['cash', 'momo', 'airtel'] as const
type Method = (typeof METHODS)[number]

/** Yellow while money is due; green with a tick once paid, saying who recorded it and when. */
function PaidMark({ bill }: { bill: VisitBill }) {
  const { t } = useTranslation()
  if (bill.status === 'credited') return <Badge tone="grey">{t('visit.status.credited')}</Badge>
  if (bill.balance > 0)
    return (
      <Badge tone="yellow">{t('visit.pay.pending', { amount: formatRwf(bill.balance) })}</Badge>
    )
  return (
    <Badge
      tone="green"
      icon={<CheckCircle2 size={12} strokeWidth={3} />}
      // the name and time wrap inside the card instead of running past its edge (0144)
      className="h-auto max-w-full py-1 text-left whitespace-normal"
    >
      {bill.settledBy
        ? t('visit.pay.paidBy', {
            name: bill.settledBy,
            time: bill.settledAt ? formatTime(new Date(bill.settledAt)) : '',
          })
        : t('visit.pay.paid')}
    </Badge>
  )
}

function PaymentCard({
  bill,
  open = false,
  patientName,
  onPay,
  onRefund,
}: {
  bill: VisitBill
  /** 0144: the visit is still open — what is paid is "so far", later desks add to the bill. */
  open?: boolean
  /** For the question asked before money is taken or given back. */
  patientName: string
  onPay: (input: {
    method: Method
    amount: number
    reference?: string
    phone?: string
  }) => Promise<void>
  /** An overpaid bill (a paid charge removed): give the difference back. */
  onRefund: (input: {
    method: Method
    amount: number
    reason: string
    reference?: string
  }) => Promise<void>
}) {
  const { t } = useTranslation()
  const [method, setMethod] = useState<Method>('cash')
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settled = bill.balance <= 0 && bill.total > 0
  const needsRef = method !== 'cash'
  const overpaid = bill.balance < 0 ? -bill.balance : 0
  const [reason, setReason] = useState('')
  const confirm = useConfirm()

  const giveBack = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const n = Number(amount || overpaid)
    if (!Number.isFinite(n) || n <= 0 || n > overpaid + 0.5)
      return setError(t('visit.refund.errors.amount', { amount: formatRwf(overpaid) }))
    if (reason.trim().length < 3) return setError(t('visit.refund.errors.reason'))
    if (needsRef && !reference.trim()) return setError(t('visit.payment.errors.reference'))
    if (
      !(await confirm({
        title: t('confirm.visit.refund', {
          amount: formatRwf(Math.round(n)),
          name: patientName,
          method: t(`visit.payment.methods.${method}`),
        }),
        body: t('confirm.visit.refundBody'),
        confirmLabel: t('confirm.visit.refundYes'),
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    try {
      await onRefund({ method, amount: Math.round(n), reason: reason.trim(), reference })
      setAmount('')
      setReason('')
      setReference('')
    } catch {
      /* shown by the page */
    } finally {
      setBusy(false)
    }
  }

  if (overpaid > 0)
    return (
      <Card className="border-amber">
        <CardHeader icon={Undo2} hue="amber">
          <span>{t('visit.refund.title')}</span>
          <span className="text-ink-2 text-[13px] tabular-nums">
            {t('visit.refund.owed')} <b className="text-ink">{formatRwf(overpaid)}</b>
          </span>
        </CardHeader>
        <form onSubmit={giveBack}>
          <CardBody className="gap-3">
            <p className="text-ink-2 m-0 text-[13px]">{t('visit.refund.lead')}</p>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label={t('visit.refund.method')}
                value={method}
                onChange={(e) => setMethod(e.target.value as Method)}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`visit.payment.methods.${m}`)}
                  </option>
                ))}
              </Select>
              <Field
                label={t('visit.payment.amount')}
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={String(overpaid)}
              />
            </div>
            <Field
              label={t('visit.refund.reason')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('visit.refund.reasonPh')}
              required
            />
            {needsRef && (
              <Field
                label={t('visit.payment.reference')}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                required
              />
            )}
            {error && (
              <p role="alert" className={errorBox}>
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="self-start" disabled={busy}>
              {t('visit.refund.give', { amount: formatRwf(Number(amount || overpaid) || 0) })}
            </Button>
          </CardBody>
        </form>
      </Card>
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const n = Number(amount || bill.balance)
    if (!Number.isFinite(n) || n <= 0) return setError(t('visit.payment.errors.amount'))
    if (n > bill.balance + 0.5)
      return setError(t('visit.payment.errors.tooMuch', { balance: formatRwf(bill.balance) }))
    if (needsRef && !reference.trim()) return setError(t('visit.payment.errors.reference'))
    if (
      !(await confirm({
        title: t('confirm.visit.pay', {
          amount: formatRwf(Math.round(n)),
          name: patientName,
          method: t(`visit.payment.methods.${method}`),
        }),
        body: t('confirm.visit.payBody'),
        confirmLabel: t('confirm.visit.payYes'),
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    try {
      await onPay({ method, amount: Math.round(n), reference, phone })
      setAmount('')
      setReference('')
    } catch {
      /* shown by the page */
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={cn(settled ? 'border-green' : 'border-primary')}>
      <CardHeader icon={Wallet} hue="mint">
        <span>{t('visit.payment.title')}</span>
        {settled ? (
          <PaidMark bill={bill} />
        ) : (
          <span className="text-ink-2 text-[13px] tabular-nums">
            {t('visit.payment.due')} <b className="text-ink">{formatRwf(bill.balance)}</b>
          </span>
        )}
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          {bill.paid > 0 && (
            <p className="text-ink-2 m-0 text-[13px]">
              {t('visit.payment.alreadyPaid', { amount: formatRwf(bill.paid) })}
              {open && settled && (
                <span className="text-ink-3 block">{t('visit.payment.paidSoFarNote')}</span>
              )}
            </p>
          )}
          {bill.total === 0 && <EmptyNote>{t('visit.payment.nothingYet')}</EmptyNote>}
          {!settled && bill.total > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label={t('visit.payment.method')}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as Method)}
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`visit.payment.methods.${m}`)}
                    </option>
                  ))}
                </Select>
                <Field
                  label={t('visit.payment.amount')}
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder={String(bill.balance)}
                />
              </div>
              {needsRef && (
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label={t('visit.payment.reference')}
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    required
                  />
                  <Field
                    label={t('visit.payment.phone')}
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="07xx xxx xxx"
                  />
                </div>
              )}
              {error && (
                <p role="alert" className={errorBox}>
                  {error}
                </p>
              )}
              <Button
                type="submit"
                variant="success"
                size="lg"
                className="self-start"
                disabled={busy}
              >
                {busy
                  ? t('visit.payment.taking')
                  : t('visit.payment.take', {
                      amount: formatRwf(Number(amount || bill.balance) || 0),
                    })}
              </Button>
            </>
          )}
        </CardBody>
      </form>
    </Card>
  )
}

/* ---------------------------------------------------------------- add a treatment */

function AddChargeCard({
  patientName,
  treatments,
  myDepartments,
  office,
  payerId,
  coveragePct,
  insurerName,
  isManager,
  disabled,
  onAdd,
}: {
  /** For the question asked before the treatment is charged. */
  patientName: string
  treatments: Treatment[]
  /** The employee's departments: their treatments (and those of no department) come first; the
   *  others only after "Show other departments". Empty = everything (manager, no department). */
  myDepartments: { id: string; name: string }[]
  office: Station
  payerId: string | null
  coveragePct: number
  insurerName: string | null
  isManager: boolean
  disabled: boolean
  onAdd: (input: {
    encounterId: string
    office: Station
    serviceId?: string
    itemId?: string
    description: string
    listPrice: number
    quantity: number
    discountPct: number
    discountReason?: string
    manualPrice?: number | null
    coveragePct: number
    cashPrice?: number | null
    /** The cash price was confirmed with the insurer (the 'ask' rule). */
    confirm?: boolean
  }) => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const [serviceId, setServiceId] = useState('')
  const myIds = myDepartments.map((d) => d.id)
  const [quantity, setQuantity] = useState('1')
  const [discount, setDiscount] = useState('')
  const [mode, setMode] = useState<AdjustMode>('pct')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()

  const selected = treatments.find((x) => x.id === serviceId)
  const picked = selected
  // the insurer's line (0115): its price, where it comes from and its coverage; else as before
  // the insurer's line for the treatment chosen (0140): its price, where it comes from, the split
  const { data: payerRows } = usePayerLines(payerId, selected ? [selected.id] : [])
  const row = payerId && selected ? payerLine(payerRows, { serviceId: selected.id }) : undefined
  const listPrice = selected
    ? (row?.price ??
      (payerId && selected.payerPrices[payerId] != null
        ? selected.payerPrices[payerId]!
        : (selected.cashPrice ?? 0)))
    : 0
  const linePct = row ? row.coveragePct : coveragePct
  const adj = resolveAdjust(mode, discount, listPrice)
  const d = adj.discountPct
  const manual = adj.manualPrice
  const q = Number(quantity) || 1
  const unit = adj.unit
  const total = Math.round(unit * q)
  const insurer = Math.round((total * linePct) / 100)
  const insurerNote = payerId && row ? insurerLineText(t, row, insurerName ?? '', q) : null
  const noteTone = insurerLineTone(row)
  const maxDiscount = selected?.maxDiscountPct ?? 0
  const overMax = d > maxDiscount && !isManager
  const mayTypePrice = isManager || !!selected?.allowManualPrice
  const manualRefused = manual != null && !mayTypePrice
  const modes: AdjustMode[] = mayTypePrice ? ['pct', 'rwf', 'x', 'price'] : ['pct', 'rwf', 'x']
  const changed = d > 0 || manual != null
  // 0143: one searchable list of every treatment: the person's departments first (each its own
  // group), then "Other"; on an insurer, its price on the right, its rule as a second line, and
  // what it does not cover in a last group (the patient pays). A treatment given by no department
  // is under Other.
  const { data: tariff } = useInsurerTariff(payerId)
  const ruleOf = (id: string) =>
    payerId ? insurerLineRule(tariff?.rows.find((r) => r.kind === 'service' && r.id === id)) : null
  const priceOf = (x: Treatment) => {
    const row = payerId
      ? tariff?.rows.find((r) => r.kind === 'service' && r.id === x.id)
      : undefined
    return (
      row?.price ??
      (payerId && x.payerPrices[payerId] != null ? x.payerPrices[payerId]! : x.cashPrice)
    )
  }
  const sorted = [...treatments].sort((a, b) =>
    treatmentName(a, i18n.language).localeCompare(treatmentName(b, i18n.language)),
  )
  const groupOf = (x: Treatment, rule: ReturnType<typeof insurerLineRule>) => {
    if (rule === 'out') return t('visit.add.notCoveredGroup', { insurer: insurerName ?? '' })
    const dept = myDepartments.find((d) => x.departmentIds.includes(d.id))
    return dept ? dept.name : t('visit.add.otherGroup')
  }
  const groupRank = (g: string) =>
    g === t('visit.add.notCoveredGroup', { insurer: insurerName ?? '' })
      ? myDepartments.length + 1
      : g === t('visit.add.otherGroup')
        ? myDepartments.length
        : myDepartments.findIndex((d) => d.name === g)
  const treatmentOptions: SearchOption[] = sorted
    .map((x) => {
      const rule = ruleOf(x.id)
      const price = priceOf(x)
      return {
        value: x.id,
        label: treatmentName(x, i18n.language),
        group: groupOf(x, rule),
        hint: price == null ? '—' : formatRwf(price),
        sub: insurerRuleSub(t, rule, insurerName ?? ''),
        keywords: [x.code, x.nameEn, x.nameFr, x.nameKin].filter(Boolean).join(' '),
      }
    })
    .sort((a, b) => groupRank(a.group!) - groupRank(b.group!))
  const fromAnotherDept =
    !!picked &&
    myIds.length > 0 &&
    picked.departmentIds.length > 0 &&
    !picked.departmentIds.some((id) => myIds.includes(id))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!picked) return setError(t('visit.add.errors.pick'))
    if (adj.error) return setError(t(`adjust.errors.${adj.error}`))
    if (manualRefused) return setError(t('visit.add.errors.noManual'))
    if (overMax) return setError(t('visit.add.errors.overMax', { pct: maxDiscount }))
    if (changed && !reason.trim()) return setError(t('visit.add.errors.reason'))
    if (
      !(await confirm({
        title: t('confirm.visit.addCharge', {
          item: treatmentName(picked, i18n.language),
          name: patientName,
        }),
        body: t('confirm.visit.addChargeBody', {
          quantity: q,
          total: formatRwf(total),
        }),
        confirmLabel: t('confirm.visit.addChargeYes'),
      }))
    )
      return
    // not on the insurer's list and the insurer wants to be asked, or the insurer covers it only
    // with its approval (0134): confirm before it is charged
    const askInsurer = async (preauth = !!row?.preauth) =>
      preauth
        ? confirm({
            title: t('confirm.visit.preauth', {
              item: treatmentName(picked, i18n.language),
              insurer: insurerName ?? '',
            }),
            body: t('confirm.visit.preauthBody', { insurer: insurerName ?? '' }),
            confirmLabel: t('confirm.visit.preauthYes'),
          })
        : confirm({
            title: t('confirm.visit.askInsurer', {
              item: treatmentName(picked, i18n.language),
              insurer: insurerName ?? '',
            }),
            body: t('confirm.visit.askInsurerBody', { price: formatRwf(total) }),
            confirmLabel: t('confirm.visit.askInsurerYes'),
          })
    let confirmed = false
    if (row?.ask || row?.preauth) {
      if (!(await askInsurer())) return
      confirmed = true
    }
    setBusy(true)
    const input = {
      encounterId: '',
      office,
      serviceId: selected?.id,
      description: selected?.nameEn ?? '',
      listPrice,
      quantity: q,
      discountPct: d,
      discountReason: reason,
      manualPrice: manual,
      coveragePct: linePct,
      cashPrice: selected?.cashPrice ?? null,
      confirm: confirmed,
    }
    try {
      try {
        await onAdd(input)
      } catch (e) {
        // the database asks (the tariff on screen was older): confirm, then once more
        const asked =
          e instanceof ApiError && (e.hint === 'ask_insurer' || e.hint === 'insurer_preauth')
        if (!asked || !(await askInsurer(e.hint === 'insurer_preauth'))) throw e
        await onAdd({ ...input, confirm: true })
      }
      setServiceId('')
      setDiscount('')
      setReason('')
      setQuantity('1')
    } catch {
      /* shown by the page */
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <Plus size={16} aria-hidden="true" />
          {t('visit.add.title')}
        </span>
      </CardHeader>
      <form onSubmit={submit}>
        <CardBody className="gap-3">
          <p className="text-ink-3 m-0 text-xs">{t('visit.add.medicinesElsewhere')}</p>
          <SearchSelect
            label={t('visit.add.treatment')}
            value={serviceId}
            onChange={setServiceId}
            emptyLabel={t('visit.add.pick')}
            options={treatmentOptions}
            disabled={disabled}
            required
          />
          <p className="text-ink-3 m-0 text-xs">
            {payerId
              ? t('visit.add.listHintInsured', { insurer: insurerName ?? '' })
              : t('visit.add.listHint')}
          </p>
          {fromAnotherDept && (
            <p className="bg-amber-bg text-amber border-amber/30 m-0 rounded-md border px-3 py-2 text-[13px] font-semibold">
              {t('visit.add.otherWarning')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('visit.add.quantity')}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
              disabled={disabled}
            />
          </div>
          <AdjustField
            label={t('visit.add.adjust', { max: isManager ? 100 : maxDiscount })}
            mode={mode}
            modes={modes}
            value={discount}
            onMode={setMode}
            onChange={setDiscount}
            disabled={disabled || !picked}
            invalid={overMax || manualRefused || adj.error != null}
            hint={
              picked
                ? manual != null
                  ? t('visit.add.newPrice', { price: formatRwf(manual) })
                  : d > 0
                    ? t('visit.add.off', { pct: d, amount: formatRwf(listPrice - unit) })
                    : t('visit.add.adjustHint')
                : undefined
            }
          />
          {changed && (
            <Field
              label={manual != null ? t('visit.add.manualReason') : t('visit.add.reason')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('visit.add.reasonPh')}
              disabled={disabled}
              required
            />
          )}
          {picked && (
            <p className="text-ink-2 m-0 text-[13px]">
              {changed && (
                <span className="text-ink-3 mr-1 line-through">{formatRwf(listPrice)}</span>
              )}
              {t('visit.add.preview', { unit: formatRwf(unit), total: formatRwf(total) })}
              {linePct > 0 &&
                ` · ${t('visit.charges.split', { patient: formatRwf(total - insurer), insurer: formatRwf(insurer) })}`}
            </p>
          )}
          {/* the insurer's price and where it comes from (0115) */}
          {picked && insurerNote && (
            <p
              className={cn(
                'm-0 text-[13px] font-semibold',
                noteTone === 'teal' ? 'text-teal' : noteTone === 'red' ? 'text-red' : 'text-amber',
              )}
            >
              {insurerNote}
            </p>
          )}
          {error && (
            <p role="alert" className={errorBox}>
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={disabled || busy || !picked}>
            <Plus size={16} aria-hidden="true" />
            {busy ? t('visit.add.adding') : t('visit.add.submit')}
          </Button>
        </CardBody>
      </form>
    </Card>
  )
}
