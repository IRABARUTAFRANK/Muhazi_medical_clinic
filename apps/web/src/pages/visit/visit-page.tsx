import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, FolderOpen, Plus, Receipt, Send, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, type StaffUser } from '@mmc/shared'
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
  type VisitBill,
} from '@/lib/api/billing'
import { useInsurers, useTreatments, type Treatment } from '@/lib/api/catalogue'
import { TREATING_STATIONS, stationFor, type Station } from '@/lib/api/visits'
import { navForUser } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { ClinicalCard } from './clinical-card'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'

/**
 * One visit at a station: patient and triage, who pays, the treatments given (with the
 * discount the clinician may grant) and the patient / insurer split, then send the patient
 * to the cashier or another station. Every charge is recorded against the signed-in employee.
 */
export function VisitPage({ user, encounterId }: { user: StaffUser; encounterId: string }) {
  const { t } = useTranslation()
  const myStation = stationFor(user)
  const { data: header, isLoading, error } = useVisitHeader(encounterId)
  const { data: vitals = [] } = useVisitVitals(encounterId)
  const { data: bill } = useVisitBill(encounterId)
  const { data: treatments = [] } = useTreatments(true)
  const { data: insurers = [] } = useInsurers(true)
  const actions = useBillingActions(encounterId)
  const [member, setMember] = useState('')
  const [next, setNext] = useState<Station>('cashier')
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

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

  const sendOn = async (target: Station) => {
    setActionError(null)
    try {
      await actions.finishStation.mutateAsync({ station: myStation, next: target })
      setDone(t('visit.sent', { station: t(`register.stations.${target}`) }))
    } catch (e) {
      setActionError(describe(e))
    }
  }

  return (
    <StaffShell user={user} nav={navForUser(user)}>
      <main className="pc:px-6 pc:pb-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <Link
          to="/app"
          className="text-ink-2 inline-flex items-center gap-1 text-[13px] no-underline"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {t('visit.back')}
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
              {vitals.length > 0 && (
                <CardBody className="border-border flex-row flex-wrap gap-2 border-t">
                  {vitals.map((v) => (
                    <Chip key={v.code}>
                      {t(`triage.vitals.${v.code}`)}: <b className="ml-1 tabular-nums">{v.value}</b>
                      {v.unit ? ` ${v.unit}` : ''}
                    </Chip>
                  ))}
                </CardBody>
              )}
            </Card>

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

            <ClinicalCard
              encounterId={encounterId}
              user={user}
              onDone={(m) => {
                setActionError(null)
                setDone(m)
              }}
              onError={setActionError}
            />

            <div className="pc:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] grid grid-cols-1 gap-4">
              <div className="flex flex-col gap-4">
                {/* Who pays */}
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
                      {insurers.length === 0 ? t('visit.payer.noInsurers') : t('visit.payer.hint')}
                    </p>
                  </CardBody>
                </Card>

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
                      <b className="text-ink text-lg tabular-nums">{formatRwf(bill?.total ?? 0)}</b>
                    </span>
                    <span className="text-ink-2 text-[13px]">
                      {t('visit.charges.patientPays')}{' '}
                      <b className="text-ink tabular-nums">{formatRwf(bill?.patientShare ?? 0)}</b>
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
              </div>

              <div className="flex flex-col gap-4">
                {(user.role === 'cashier' || user.role === 'manager') && bill && (
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
                <AddChargeCard
                  treatments={treatments}
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

                {/* Send on */}
                <Card>
                  <CardHeader>
                    <span className="inline-flex items-center gap-2">
                      <Send size={16} aria-hidden="true" />
                      {t('visit.next.title')}
                    </span>
                  </CardHeader>
                  <CardBody className="gap-3">
                    <p className="text-ink-2 m-0 text-[13px]">
                      {t('visit.next.lead', { station: t(`register.stations.${myStation}`) })}
                    </p>
                    <Button
                      variant="primary"
                      disabled={actions.finishStation.isPending}
                      onClick={() => void sendOn('cashier')}
                    >
                      {t('visit.next.toCashier')}
                    </Button>
                    <div className="flex items-end gap-2">
                      <Select
                        label={t('visit.next.other')}
                        value={next}
                        onChange={(e) => setNext(e.target.value as Station)}
                        wrapperClassName="flex-1"
                      >
                        {[...TREATING_STATIONS, 'cashier' as Station].map((s) => (
                          <option key={s} value={s}>
                            {t(`register.stations.${s}`)}
                          </option>
                        ))}
                      </Select>
                      <Button
                        disabled={actions.finishStation.isPending}
                        onClick={() => void sendOn(next)}
                      >
                        {t('visit.next.send')}
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              </div>
            </div>
          </>
        )}
      </main>
    </StaffShell>
  )
}

/* ---------------------------------------------------------------- cashier: take a payment */

const METHODS = ['cash', 'momo', 'airtel', 'card', 'bank'] as const
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
  office,
  payerId,
  coveragePct,
  isManager,
  disabled,
  onAdd,
}: {
  treatments: Treatment[]
  office: Station
  payerId: string | null
  coveragePct: number
  isManager: boolean
  disabled: boolean
  onAdd: (input: {
    encounterId: string
    office: Station
    serviceId: string
    description: string
    listPrice: number
    quantity: number
    discountPct: number
    discountReason?: string
    coveragePct: number
  }) => Promise<void>
}) {
  const { t } = useTranslation()
  const [serviceId, setServiceId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [discount, setDiscount] = useState('0')
  const [reason, setReason] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = treatments.find((x) => x.id === serviceId)
  const listPrice = selected
    ? payerId && selected.payerPrices[payerId] != null
      ? selected.payerPrices[payerId]!
      : (selected.cashPrice ?? 0)
    : 0
  const d = Number(discount) || 0
  const q = Number(quantity) || 1
  const unit = Math.round((listPrice * (100 - d)) / 100)
  const total = Math.round(unit * q)
  const insurer = Math.round((total * coveragePct) / 100)
  const maxDiscount = selected?.maxDiscountPct ?? 0
  const overMax = d > maxDiscount && !isManager
  const filtered = treatments.filter((x) =>
    query.trim() === ''
      ? true
      : `${x.nameEn} ${x.nameKin ?? ''} ${x.nameFr ?? ''} ${x.code}`
          .toLowerCase()
          .includes(query.toLowerCase()),
  )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!selected) return setError(t('visit.add.errors.pick'))
    if (d < 0 || d > 100) return setError(t('visit.add.errors.discount'))
    if (overMax) return setError(t('visit.add.errors.overMax', { pct: maxDiscount }))
    if (d > 0 && !reason.trim()) return setError(t('visit.add.errors.reason'))
    setBusy(true)
    try {
      await onAdd({
        encounterId: '',
        office,
        serviceId: selected.id,
        description: selected.nameEn,
        listPrice,
        quantity: q,
        discountPct: d,
        discountReason: reason,
        coveragePct,
      })
      setServiceId('')
      setDiscount('0')
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
            {filtered.map((x) => (
              <option key={x.id} value={x.id}>
                {x.nameEn} · {x.cashPrice == null ? '—' : formatRwf(x.cashPrice)}
              </option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('visit.add.quantity')}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
              disabled={disabled}
            />
            <Field
              label={t('visit.add.discount', { max: isManager ? 100 : maxDiscount })}
              inputMode="numeric"
              value={discount}
              onChange={(e) => setDiscount(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
              className={cn(overMax && 'border-red')}
              disabled={disabled || !selected}
            />
          </div>
          {d > 0 && (
            <Field
              label={t('visit.add.reason')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('visit.add.reasonPh')}
              disabled={disabled}
              required
            />
          )}
          {selected && (
            <p className="text-ink-2 m-0 text-[13px]">
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
          <Button type="submit" variant="primary" disabled={disabled || busy || !selected}>
            <Plus size={16} aria-hidden="true" />
            {busy ? t('visit.add.adding') : t('visit.add.submit')}
          </Button>
        </CardBody>
      </form>
    </Card>
  )
}
