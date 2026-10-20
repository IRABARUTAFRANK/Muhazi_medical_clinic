import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Activity, ArrowLeft, CheckCircle2, FolderOpen, Plus, Receipt, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FEATURES, formatDate, formatRwf, formatTime, type StaffUser } from '@mmc/shared'
import { NurseTaskCard } from '@/components/clinical/nurse-task-card'
import { VitalsForm } from '@/components/clinical/vitals-form'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { Card, CardBody, CardHeader, Row } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { Field } from '@/components/ui/field'
import { Seg } from '@/components/ui/seg'
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
import { stationFor, type Station } from '@/lib/api/visits'
import { useItems, type Item } from '@/lib/api/patients'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { resolveAdjust, type AdjustMode } from '@/lib/adjust'
import { AdjustField } from '@/components/ui/adjust-field'
import { useMyCover } from '@/lib/api/cover'
import { useVisitRouting } from '@/lib/api/referrals'
import { ClinicalCard } from './clinical-card'
import { WhereNextCard } from './where-next-card'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/**
 * One visit at a station: patient and triage, who pays, the treatments given (with the
 * discount the clinician may grant) and the patient / insurer split, then send the patient
 * to the cashier or another station. Every charge is recorded against the signed-in employee.
 */
export function VisitPage({ user, encounterId }: { user: StaffUser; encounterId: string }) {
  const { t } = useTranslation()
  // The desk this person works at for this patient: the one the patient was referred to them at,
  // or the covered doctor's desk while covering; otherwise their own station.
  const { data: routing = [] } = useVisitRouting(encounterId)
  const { data: cover } = useMyCover()
  const coverDesks = (cover?.covering ?? []).map((c) =>
    stationFor({ ...user, role: 'doctor', station: c.station ?? undefined }),
  )
  const assigned =
    routing.find((r) => r.assignedTo === user.id) ??
    routing.find((r) => coverDesks.includes(r.station))
  const myStation = assigned?.station ?? stationFor(user)
  const { data: header, isLoading, error } = useVisitHeader(encounterId)
  const { data: vitals = [] } = useVisitVitals(encounterId)
  const { data: items = [] } = useItems()
  const { data: bill } = useVisitBill(encounterId)
  const { data: treatments = [] } = useTreatments(true)
  const { data: insurers = [] } = useInsurers(true)
  const actions = useBillingActions(encounterId)
  const [member, setMember] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const isManagerNav = user.role === 'manager' || user.dashboard === 'manager'
  // Reception sends patients on and completes files; treatments and the bill are not theirs.
  const isReception = user.role === 'receptionist'
  // A finished visit opens read-only (it stays in the patient file).
  const closed = !!header?.closed
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
                {!addingVitals && !closed && (
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

            {closed && (
              <p className="bg-green-bg text-green m-0 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-[14px] font-semibold">
                <CheckCircle2 size={18} aria-hidden="true" />
                {t('visit.closedBanner', {
                  when: header.closedAt
                    ? `${formatDate(new Date(header.closedAt))} ${formatTime(new Date(header.closedAt))}`
                    : '',
                })}
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

            {(actionError || done) && (
              <p
                role={actionError ? 'alert' : 'status'}
                className={
                  actionError
                    ? errorBox
                    : 'bg-green-bg text-green m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
                }
              >
                {actionError ?? done}
              </p>
            )}

            {!isReception && (
              <ClinicalCard
                encounterId={encounterId}
                user={user}
                closed={closed}
                onDone={(m) => {
                  setActionError(null)
                  setDone(m)
                }}
                onError={setActionError}
              />
            )}

            {/* Doctor → nurse: tasks on this visit appear on the nurses' dashboard. */}
            {(user.role === 'doctor' || user.role === 'manager') && (
              <NurseTaskCard encounterId={encounterId} />
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
                      {bill?.status && bill.status !== 'draft' && (
                        <Badge tone="blue">{t(`visit.status.${bill.status}`)}</Badge>
                      )}
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
                          {bill?.status === 'draft' && (
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
                    closed={closed}
                    onDone={(m) => {
                      setActionError(null)
                      setDone(m)
                    }}
                    onError={setActionError}
                  />
                </div>
              )}

              <div className="flex flex-col gap-4">
                {(user.role === 'cashier' || user.role === 'manager') && bill && !closed && (
                  <PaymentCard
                    bill={bill}
                    onPay={async (input) => {
                      setActionError(null)
                      try {
                        const r = await actions.takePayment.mutateAsync(input)
                        setDone(
                          r.balance <= 0
                            ? t('visit.payment.settled', { number: r.number ?? '' })
                            : t('visit.payment.partial', { balance: formatRwf(r.balance) }),
                        )
                      } catch (e) {
                        setActionError(describe(e))
                        throw e
                      }
                    }}
                  />
                )}
                {!isReception && !closed && (
                  <AddChargeCard
                    treatments={treatments}
                    items={items}
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

                {isReception && (
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

function PaymentCard({
  bill,
  onPay,
}: {
  bill: VisitBill
  onPay: (input: {
    method: Method
    amount: number
    reference?: string
    phone?: string
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
          <Badge tone="green">{t('visit.payment.paidBadge')}</Badge>
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
  items,
  office,
  payerId,
  coveragePct,
  isManager,
  disabled,
  onAdd,
}: {
  treatments: Treatment[]
  items: Item[]
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
  const [kind, setKind] = useState<'service' | 'item'>('service')
  const [serviceId, setServiceId] = useState('')
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [discount, setDiscount] = useState('')
  const [mode, setMode] = useState<AdjustMode>('pct')
  const [reason, setReason] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = kind === 'service' ? treatments.find((x) => x.id === serviceId) : undefined
  const selectedItem = kind === 'item' ? items.find((x) => x.id === itemId) : undefined
  const picked = selected ?? selectedItem
  const listPrice = selected
    ? payerId && selected.payerPrices[payerId] != null
      ? selected.payerPrices[payerId]!
      : (selected.cashPrice ?? 0)
    : (selectedItem?.cashPrice ?? 0)
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
  const filtered = treatments.filter((x) =>
    query.trim() === ''
      ? true
      : `${x.nameEn} ${x.nameKin ?? ''} ${x.nameFr ?? ''} ${x.code}`
          .toLowerCase()
          .includes(query.toLowerCase()),
  )
  const filteredItems = items.filter((x) =>
    query.trim() === ''
      ? true
      : `${x.name} ${x.strength ?? ''} ${x.form ?? ''} ${x.code}`
          .toLowerCase()
          .includes(query.toLowerCase()),
  )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!picked)
      return setError(t(kind === 'item' ? 'visit.add.errors.pickItem' : 'visit.add.errors.pick'))
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
        itemId: selectedItem?.id,
        description: selected
          ? selected.nameEn
          : `${selectedItem?.name ?? ''}${selectedItem?.strength ? ` ${selectedItem.strength}` : ''}`,
        listPrice,
        quantity: q,
        discountPct: d,
        discountReason: reason,
        manualPrice: manual,
        coveragePct,
      })
      setServiceId('')
      setItemId('')
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
          <Seg
            label={t('visit.add.kind')}
            value={kind}
            onChange={(k) => {
              setKind(k)
              setServiceId('')
              setItemId('')
              setDiscount('')
            }}
            options={[
              { value: 'service', label: t('visit.add.kindTreatment') },
              { value: 'item', label: t('visit.add.kindMedicine') },
            ]}
          />
          <Field
            label={t('visit.add.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(kind === 'item' ? 'visit.add.searchItemPh' : 'visit.add.searchPh')}
            disabled={disabled}
          />
          {kind === 'service' ? (
            <Select
              label={t('visit.add.treatment')}
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              disabled={disabled}
              required
            >
              <option value="">{t('visit.add.pick')}</option>
              {filtered.map((x) => (
                <option key={x.id} value={x.id}>
                  {treatmentName(x, i18n.language)} ·{' '}
                  {x.cashPrice == null ? '—' : formatRwf(x.cashPrice)}
                </option>
              ))}
            </Select>
          ) : (
            <Select
              label={t('visit.add.medicine')}
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              disabled={disabled}
              required
            >
              <option value="">{t('visit.add.pickItem')}</option>
              {filteredItems.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.strength ? ` ${x.strength}` : ''} ·{' '}
                  {x.cashPrice == null ? '—' : formatRwf(x.cashPrice)}
                  {x.unit ? ` / ${x.unit}` : ''}
                </option>
              ))}
            </Select>
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
