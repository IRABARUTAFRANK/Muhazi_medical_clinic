import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  FolderOpen,
  Footprints,
  HandHelping,
  Lock,
  Plus,
  Printer,
  Receipt,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FEATURES, formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { LeftButton } from '@/components/clinical/left-button'
import { NurseTaskCard } from '@/components/clinical/nurse-task-card'
import { VitalsForm } from '@/components/clinical/vitals-form'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
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
import { useMyCover } from '@/lib/api/cover'
import { useVisitRouting } from '@/lib/api/referrals'
import { ClinicalCard } from './clinical-card'
import { WhereNextCard } from './where-next-card'
import { VisitTrack } from '@/components/clinical/visit-track'
import { useCan } from '@/lib/api/permissions'
import { useVisitAccess } from '@/lib/api/calls'
import { HelpCard } from './help-card'
import { openReceipt } from '@/lib/receipt-doc'
import { useLetterhead } from '@/lib/report-parts'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/**
 * One visit at a station: patient and triage, who pays, the treatments given (with the
 * discount the clinician may grant) and the patient / insurer split, then send the patient
 * to the cashier or another station. Every charge is recorded against the signed-in employee.
 */
/** The desks each role works at (to find where this person meets the patient). */
const DESKS_OF: Record<string, Station[]> = {
  doctor: ['consultation', 'dental', 'theatre'],
  nurse: ['triage', 'nursing', 'beds'],
  lab_tech: ['laboratory'],
  sonographer: ['ultrasound'],
  pharmacist: ['pharmacy'],
  cashier: ['cashier'],
  receptionist: ['reception'],
}

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
  // The desk this person works at for this patient: the one the patient was referred to them at,
  // or the covered doctor's desk while covering; otherwise their own station.
  const { data: routing = [] } = useVisitRouting(encounterId)
  const { data: cover } = useMyCover()
  const coverDesks = (cover?.covering ?? []).map((c) =>
    stationFor({ ...user, role: 'doctor', station: c.station ?? undefined }),
  )
  // the desks of my role (database role: a sonographer works at Ultrasound)
  const myDesks = DESKS_OF[user.dbRole ?? user.role] ?? []
  const assigned =
    routing.find((r) => r.assignedTo === user.id || r.takenBy === user.id) ??
    routing.find((r) => coverDesks.includes(r.station)) ??
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
  const { data: bill } = useVisitBill(encounterId)
  const { data: treatments = [] } = useTreatments(true)
  const { data: myDepartments = [] } = useMyDepartments(user.id)
  const { data: insurers = [] } = useInsurers(true)
  const actions = useBillingActions(encounterId)
  const [member, setMember] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
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
  const weight = vitals.find((v) => v.code === 'weight')
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

  const choosePayer = async (payerId: string) => {
    setActionError(null)
    const ins = insurers.find((i) => i.id === payerId)
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

  const removeCharge = async (id: string) => {
    const reason = window.prompt(t('visit.removeReason'))
    if (!reason) return
    setActionError(null)
    try {
      await actions.voidCharge.mutateAsync({ id, reason })
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
              <CardBody className="flex-row flex-wrap items-center gap-x-5 gap-y-2">
                <span className="text-primary text-2xl font-bold tabular-nums">
                  {header.ticket}
                </span>
                <span className="min-w-[200px] flex-1">
                  <span className="block text-lg font-bold">{header.name}</span>
                  <span className="text-ink-3 text-xs tabular-nums">
                    {header.fileNumber} · {header.ageSex}
                  </span>
                </span>
                {header.triage && (
                  <Badge tone={header.triage}>{t(`home.triage.${header.triage}`)}</Badge>
                )}
                {header.stations.map((s) => (
                  <Chip key={s}>{t(`register.stations.${s}`)}</Chip>
                ))}
                <StaffLink
                  to="/app/patient"
                  search={{ id: header.patientId }}
                  className={buttonVariants({ size: 'sm' })}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  {t('visit.patientFile')}
                </StaffLink>
                {takeable && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={take.isPending}
                    onClick={() =>
                      void take
                        .mutateAsync(takeable.queueId)
                        .then(() => {
                          setActionError(null)
                          setDone(t('visit.taken'))
                        })
                        .catch((e: unknown) => setActionError(describe(e)))
                    }
                    title={t('visit.takeHint')}
                  >
                    <HandHelping size={14} aria-hidden="true" />
                    {t('visit.take')}
                  </Button>
                )}
                {!closed && (
                  <LeftButton
                    encounterId={encounterId}
                    name={header.name}
                    user={user}
                    onDone={(m) => {
                      setActionError(null)
                      setDone(m)
                    }}
                  />
                )}
              </CardBody>
              <CardBody className="border-border flex-row flex-wrap items-center gap-2 border-t">
                {vitals.length === 0 ? (
                  <span className="text-ink-3 text-[13px]">{t('vitalsForm.none')}</span>
                ) : (
                  <Badge tone="green" icon={<CheckCircle2 size={12} strokeWidth={3} />}>
                    {t('vitalsForm.takenShort')}
                  </Badge>
                )}
                {vitals.map((v) => (
                  <Chip key={v.code} title={vitalSource(v)}>
                    {t(`triage.vitals.${v.code}`)}: <b className="ml-1 tabular-nums">{v.value}</b>
                    {v.unit ? ` ${v.unit}` : ''}
                  </Chip>
                ))}
                <span className="flex-1" />
                {!addingVitals && !closed && !isCashier && can('vitals.write') && (
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

            {!closed &&
              vitals.length === 0 &&
              !addingVitals &&
              !isCashier &&
              can('vitals.write') && (
                <p className="bg-amber-bg text-amber m-0 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-[14px] font-semibold">
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
              <p className="bg-green-bg text-green m-0 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-[14px] font-semibold">
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

            {locked && (
              <p className="bg-violet-bg text-violet m-0 flex flex-wrap items-start gap-2 rounded-xl px-3 py-2.5 text-[14px]">
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
              <p className="bg-primary-tint text-primary m-0 flex items-center gap-2 rounded-xl px-3 py-2.5 text-[14px] font-semibold">
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

            {!isReception && !isCashier && (
              <ClinicalCard
                encounterId={encounterId}
                user={user}
                station={myStation}
                patient={{
                  name: header.name,
                  fileNumber: header.fileNumber,
                  ageSex: header.ageSex,
                  weight: weight ? `${weight.value}${weight.unit ? ` ${weight.unit}` : ''}` : null,
                }}
                report={{
                  // the visit's date: its first vital sign when nothing clinical is written yet
                  since: vitals.map((v) => v.at).sort()[0],
                  vitals: vitals.map((v) => ({
                    label: t(`triage.vitals.${v.code}`),
                    value: `${v.value}${v.unit ? ` ${v.unit}` : ''}`,
                  })),
                  treatments: (bill?.charges ?? []).map(
                    (c) => `${c.description}${c.quantity > 1 ? ` × ${c.quantity}` : ''}`,
                  ),
                }}
                openReport={openReport}
                lockedNote={
                  locked ? t('access.lockedShort', { holder: access?.holder ?? '' }) : null
                }
                closed={closed}
                onDone={(m) => {
                  setActionError(null)
                  setDone(m)
                }}
                onError={setActionError}
              />
            )}

            {/* Doctor → nurse: tasks on this visit appear on the nurses' dashboard. */}
            {(user.role === 'doctor' || user.role === 'manager') && !locked && !closed && (
              <NurseTaskCard encounterId={encounterId} />
            )}
            {user.role === 'nurse' && !closed && <NurseTaskCard encounterId={encounterId} nurse />}

            {/* Ask a colleague for help on this patient (or end the help) */}
            {!closed &&
              !locked &&
              access &&
              can('clinical.write') &&
              ['doctor', 'nurse', 'manager'].includes(user.role) && (
                <HelpCard encounterId={encounterId} user={user} access={access} />
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
                  {FEATURES.insurance && (
                    <Card>
                      <CardHeader>
                        <span>{t('visit.payer.title')}</span>
                        {currentInsurer && (
                          <Chip>
                            {t('prices.insurers.covers', { pct: currentInsurer.coveragePct })}
                          </Chip>
                        )}
                      </CardHeader>
                      <CardBody className="gap-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
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
                            onClick={() => void choosePayer(bill?.payerId ?? '')}
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
                    <CardHeader>
                      <span className="inline-flex items-center gap-2">
                        <Receipt size={16} aria-hidden="true" />
                        {t('visit.charges.title')}
                      </span>
                      {bill && bill.total > 0 && <PaidMark bill={bill} />}
                    </CardHeader>
                    {(bill?.charges.length ?? 0) === 0 ? (
                      <CardBody>
                        <p className="text-ink-3 m-0 text-[13px]">{t('visit.charges.empty')}</p>
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
                          <span className="font-bold tabular-nums">
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
                          {/* not on a visit held by someone else or already over (the
                              database refuses it; lines from orders: the manager) */}
                          {bill?.status === 'draft' && !isCashier && !locked && !closed && (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={t('visit.charges.remove')}
                              onClick={() => void removeCharge(c.id)}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </Button>
                          )}
                        </Row>
                      ))
                    )}
                    <CardBody className="border-border flex-row flex-wrap items-center gap-x-6 gap-y-1 border-t">
                      <span className="text-ink-2 text-[13px]">
                        {t('visit.charges.total')}{' '}
                        <b className="text-ink text-lg tabular-nums">
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
                    myStation={myStation}
                    isReception={isReception}
                    closed={closed || locked}
                    onDone={(m) => {
                      setActionError(null)
                      setDone(m)
                    }}
                    onError={setActionError}
                  />
                </div>
              )}

              <div className="flex flex-col gap-4">
                {/* a finished visit still owing money can be paid later (debt) */}
                {can('payment.take') && bill && (!closed || bill.balance !== 0) && (
                  <PaymentCard
                    bill={bill}
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
                          method: t(`visit.payment.methods.${input.method}`),
                          amount: input.amount,
                          reference: input.reference?.trim() || null,
                        })
                        setDone(
                          r.balance > 0
                            ? t('visit.payment.partial', { balance: formatRwf(r.balance) })
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
                      const ok = openReceipt(
                        {
                          receiptNo: lastPayment?.receipt ?? null,
                          invoiceNo: null,
                          at: new Date(),
                          clinic: letterhead,
                          patient: { name: header.name, fileNumber: header.fileNumber },
                          lines: bill.charges.map((c) => ({
                            description: c.description,
                            quantity: c.quantity,
                            amount: c.patientShare,
                          })),
                          total: bill.patientShare,
                          insurer:
                            bill.insurerShare > 0
                              ? { name: bill.payerName ?? '', amount: bill.insurerShare }
                              : null,
                          payment: lastPayment
                            ? {
                                method: lastPayment.method,
                                amount: lastPayment.amount,
                                reference: lastPayment.reference,
                              }
                            : null,
                          paid: bill.paid,
                          balance: bill.balance,
                          cashier: user.name,
                        },
                        {
                          title: t('receipt.title'),
                          statement: t('receipt.statement'),
                          receiptNo: t('receipt.receiptNo'),
                          invoiceNo: t('receipt.invoiceNo'),
                          patient: t('rxDoc.patient'),
                          file: t('rxDoc.file'),
                          item: t('receipt.item'),
                          amount: t('receipt.amount'),
                          total: t('receipt.total'),
                          insurerPays: (name) => t('receipt.insurerPays', { name }),
                          patientPays: t('receipt.patientPays'),
                          paidNow: t('receipt.paidNow'),
                          reference: t('visit.payment.reference'),
                          paidSoFar: t('receipt.paidSoFar'),
                          balance: t('receipt.balance'),
                          settled: t('receipt.settled'),
                          cashier: t('receipt.cashier'),
                          thanks: t('receipt.thanks'),
                        },
                      )
                      if (!ok) setActionError(t('report.popupBlocked'))
                    }}
                    title={t('receipt.hint')}
                  >
                    <Printer size={16} aria-hidden="true" />
                    {t(lastPayment ? 'receipt.print' : 'receipt.printStatement')}
                  </Button>
                )}
                {isCashier && !closed && (
                  <p className="text-ink-3 m-0 text-[13px]">{t('visit.cashierNote')}</p>
                )}
                {!isReception && !isCashier && !closed && !locked && can('charge.write') && (
                  <AddChargeCard
                    // tests and desk work are ordered (Orders), bed nights come from the beds board
                    treatments={treatments.filter((x) => !x.orderStation && x.code !== 'BED-STAY')}
                    myDepartments={isManagerNav ? [] : myDepartments}
                    office={myStation}
                    payerId={bill?.payerId ?? null}
                    coveragePct={currentInsurer?.coveragePct ?? 0}
                    isManager={user.role === 'manager'}
                    disabled={bill?.status !== null && bill?.status !== 'draft'}
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
                  <p className="bg-primary-tint text-primary m-0 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[14px]">
                    <Footprints size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
                    {t('track.followOnly')}
                  </p>
                )}
                {isReception && !routeLocked && (
                  <WhereNextCard
                    encounterId={encounterId}
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
    <Badge tone="green" icon={<CheckCircle2 size={12} strokeWidth={3} />}>
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
  onPay,
  onRefund,
}: {
  bill: VisitBill
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

  const giveBack = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const n = Number(amount || overpaid)
    if (!Number.isFinite(n) || n <= 0 || n > overpaid + 0.5)
      return setError(t('visit.refund.errors.amount', { amount: formatRwf(overpaid) }))
    if (reason.trim().length < 3) return setError(t('visit.refund.errors.reason'))
    if (needsRef && !reference.trim()) return setError(t('visit.payment.errors.reference'))
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
        <CardHeader>
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
                onChange={(e) => setAmount(e.target.value.replace(/[^d]/g, ''))}
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
      <CardHeader>
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
            </p>
          )}
          {bill.total === 0 && (
            <p className="text-ink-3 m-0 text-[13px]">{t('visit.payment.nothingYet')}</p>
          )}
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
                variant="primary"
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
  treatments,
  myDepartments,
  office,
  payerId,
  coveragePct,
  isManager,
  disabled,
  onAdd,
}: {
  treatments: Treatment[]
  /** The employee's departments: their treatments (and those of no department) come first; the
   *  others only after "Show other departments". Empty = everything (manager, no department). */
  myDepartments: { id: string; name: string }[]
  office: Station
  payerId: string | null
  coveragePct: number
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
  }) => Promise<void>
}) {
  const { t, i18n } = useTranslation()
  const [serviceId, setServiceId] = useState('')
  const [showOthers, setShowOthers] = useState(false)
  const myIds = myDepartments.map((d) => d.id)
  const myNames = myDepartments.map((d) => d.name).join(', ')
  const isMine = (x: Treatment) =>
    myIds.length === 0 ||
    x.departmentIds.length === 0 ||
    x.departmentIds.some((id) => myIds.includes(id))
  const [quantity, setQuantity] = useState('1')
  const [discount, setDiscount] = useState('')
  const [mode, setMode] = useState<AdjustMode>('pct')
  const [reason, setReason] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = treatments.find((x) => x.id === serviceId)
  const picked = selected
  const listPrice = selected
    ? payerId && selected.payerPrices[payerId] != null
      ? selected.payerPrices[payerId]!
      : (selected.cashPrice ?? 0)
    : 0
  const adj = resolveAdjust(mode, discount, listPrice)
  const d = adj.discountPct
  const manual = adj.manualPrice
  const q = Number(quantity) || 1
  const unit = adj.unit
  const total = Math.round(unit * q)
  const insurer = Math.round((total * coveragePct) / 100)
  const maxDiscount = selected?.maxDiscountPct ?? 0
  const overMax = d > maxDiscount && !isManager
  const mayTypePrice = isManager || !!selected?.allowManualPrice
  const manualRefused = manual != null && !mayTypePrice
  const modes: AdjustMode[] = mayTypePrice ? ['pct', 'rwf', 'x', 'price'] : ['pct', 'rwf', 'x']
  const changed = d > 0 || manual != null
  const matching = treatments.filter((x) =>
    query.trim() === ''
      ? true
      : `${x.nameEn} ${x.nameKin ?? ''} ${x.nameFr ?? ''} ${x.code}`
          .toLowerCase()
          .includes(query.toLowerCase()),
  )
  const mine = matching.filter(isMine)
  const others = myIds.length ? matching.filter((x) => !isMine(x)) : []
  const option = (x: Treatment) => (
    <option key={x.id} value={x.id}>
      {treatmentName(x, i18n.language)} · {x.cashPrice == null ? '—' : formatRwf(x.cashPrice)}
    </option>
  )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!picked) return setError(t('visit.add.errors.pick'))
    if (adj.error) return setError(t(`adjust.errors.${adj.error}`))
    if (manualRefused) return setError(t('visit.add.errors.noManual'))
    if (overMax) return setError(t('visit.add.errors.overMax', { pct: maxDiscount }))
    if (changed && !reason.trim()) return setError(t('visit.add.errors.reason'))
    setBusy(true)
    try {
      await onAdd({
        encounterId: '',
        office,
        serviceId: selected?.id,
        description: selected?.nameEn ?? '',
        listPrice,
        quantity: q,
        discountPct: d,
        discountReason: reason,
        manualPrice: manual,
        coveragePct,
      })
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
          <Field
            label={t('visit.add.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('visit.add.searchPh')}
            disabled={disabled}
          />
          <Select
            label={t('visit.add.treatment')}
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            disabled={disabled}
            required
          >
            <option value="">{t('visit.add.pick')}</option>
            {showOthers && others.length > 0 ? (
              <>
                <optgroup label={t('visit.add.myDept', { name: myNames })}>
                  {mine.map(option)}
                </optgroup>
                <optgroup label={t('visit.add.otherDepts')}>{others.map(option)}</optgroup>
              </>
            ) : (
              mine.map(option)
            )}
          </Select>
          {myIds.length > 0 && others.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-3 text-xs">
                {showOthers ? t('visit.add.allShown') : t('visit.add.onlyMine', { name: myNames })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (showOthers && others.some((x) => x.id === serviceId)) setServiceId('')
                  setShowOthers(!showOthers)
                }}
              >
                {showOthers
                  ? t('visit.add.hideOthers')
                  : t('visit.add.showOthers', { count: others.length })}
              </Button>
            </div>
          )}
          {myIds.length > 0 && showOthers && others.some((x) => x.id === serviceId) && (
            <p className="bg-amber-bg text-amber m-0 rounded-lg px-3 py-2 text-[13px] font-semibold">
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
              {coveragePct > 0 &&
                ` · ${t('visit.charges.split', { patient: formatRwf(total - insurer), insurer: formatRwf(insurer) })}`}
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
