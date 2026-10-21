import { useState, type CSSProperties } from 'react'
import { Ban, FolderOpen, PackageCheck, Pill } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Flash } from '@/components/ui/flash'
import { ShownList } from '@/components/ui/list-tools'
import { StaffLink } from '@/components/staff/staff-link'
import { usePharmacyQueue, useStockActions, type PharmacyLine } from '@/lib/api/stock'
import { cn } from '@/lib/utils'

/** Usual reasons a medicine is not handed over; the pharmacist may also type their own. */
const REASONS = ['outOfStock', 'boughtElsewhere', 'refused'] as const

/**
 * The pharmacy hand-over: prescriptions waiting, one card per patient (the doctor who prescribed,
 * what it costs, what is in the pharmacy store). Each medicine is handed over (taken from stock
 * and charged on the bill) or marked "not given" with the reason, which the doctor is told.
 * When the last medicine of a patient is done the patient goes on to the cashier.
 */
export function PharmacyDesk({ canDispense, step = 6 }: { canDispense: boolean; step?: number }) {
  const { t } = useTranslation()
  const { data: queue = [] } = usePharmacyQueue()
  const actions = useStockActions()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [refusing, setRefusing] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  // one card per visit, the longest waiting first
  const groups = [...new Set(queue.map((q) => q.encounterId))].map((enc) =>
    queue.filter((q) => q.encounterId === enc),
  )
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text })
      return true
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
      return false
    }
  }
  const give = (q: PharmacyLine) =>
    run(
      () => actions.dispense.mutateAsync(q.requestId),
      t(q.price == null ? 'stock.dispensedNoPrice' : 'stock.dispensedCharged', {
        patient: q.patient,
        item: q.item,
      }),
    )
  const giveAll = async (lines: PharmacyLine[]) => {
    for (const q of lines) if (!(await give(q))) return
    setMsg({ ok: true, text: t('pharmacy.allGiven', { patient: lines[0]!.patient }) })
  }
  const notGiven = async (q: PharmacyLine) => {
    const ok = await run(
      () => actions.notGiven.mutateAsync({ requestId: q.requestId, reason: reason.trim() }),
      t('pharmacy.notGivenDone', { item: q.item, doctor: q.prescriber ?? '' }),
    )
    if (ok) {
      setRefusing(null)
      setReason('')
    }
  }
  const busy = actions.dispense.isPending || actions.notGiven.isPending

  return (
    <Panel
      i={1}
      icon={Pill}
      tint="violet"
      title={t('stock.pharmacyTitle')}
      right={t('pharmacy.waitingCount', { lines: queue.length, patients: groups.length })}
    >
      {msg && (
        <Flash key={msg.text} tone={msg.ok ? 'success' : 'error'} onClose={() => setMsg(null)}>
          {msg.text}
        </Flash>
      )}
      {groups.length === 0 ? (
        <Empty icon={PackageCheck}>{t('stock.pharmacyEmpty')}</Empty>
      ) : (
        <ShownList items={groups} step={step}>
          {(shown) => (
            <div className="flex flex-col gap-3">
              {shown.map((lines, gi) => {
                const first = lines[0]!
                const total = lines.reduce((s, q) => s + (q.price ?? 0) * q.quantity, 0)
                const anyShort = lines.some((q) => q.onHandPharmacy < q.quantity)
                return (
                  <div
                    key={first.encounterId}
                    className="border-border anim-enter flex flex-col gap-2 rounded-xl border px-3 py-2.5"
                    style={{ '--i': gi } as CSSProperties}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Badge tone="blue">{first.ticket ?? '—'}</Badge>
                      <span className="min-w-[180px] flex-1">
                        <span className="block font-semibold">
                          {first.patient}{' '}
                          <span className="text-ink-3 font-normal">· {first.file}</span>
                        </span>
                        <span className="text-ink-3 block text-[12px]">
                          {[
                            first.prescriber &&
                              t('pharmacy.prescribedBy', { name: first.prescriber }),
                            formatTime(new Date(first.at)),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="text-[14px] font-bold tabular-nums">{formatRwf(total)}</span>
                      <StaffLink
                        to="/app/visit"
                        search={{ encounter: first.encounterId }}
                        className={buttonVariants({ size: 'sm', variant: 'ghost' })}
                        title={t('pharmacy.openVisit')}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                      </StaffLink>
                      {canDispense && lines.length > 1 && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || anyShort}
                          onClick={() => void giveAll(lines)}
                          title={anyShort ? t('pharmacy.someShort') : undefined}
                        >
                          <PackageCheck size={14} aria-hidden="true" />
                          {t('pharmacy.giveAll')}
                        </Button>
                      )}
                    </div>
                    {lines.map((q) => {
                      const short = q.onHandPharmacy < q.quantity
                      return (
                        <div
                          key={q.requestId}
                          className="bg-surface/70 flex flex-col gap-2 rounded-lg px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="min-w-[180px] flex-1">
                              <span className="text-ink block text-[14px]">
                                <b>{q.item}</b> × {q.quantity}
                                {q.unit ? ` ${q.unit}` : ''}
                              </span>
                              <span className="text-ink-3 block text-[12px]">
                                {[
                                  q.dose,
                                  q.frequency,
                                  q.days ? t('history.days', { count: q.days }) : null,
                                  q.instructions,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                            <span className="text-right text-[13px]">
                              <span className="block font-semibold tabular-nums">
                                {q.price == null
                                  ? t('prices.noPrice')
                                  : formatRwf(q.price * q.quantity)}
                              </span>
                              <span
                                className={cn(
                                  'block text-[12px]',
                                  short ? 'text-red font-semibold' : 'text-ink-3',
                                )}
                              >
                                {t('stock.inPharmacy', { count: q.onHandPharmacy })}
                              </span>
                            </span>
                            {canDispense && (
                              <span className="flex flex-wrap gap-1">
                                <Button
                                  size="sm"
                                  variant={lines.length > 1 ? 'default' : 'primary'}
                                  disabled={short || busy}
                                  loading={
                                    actions.dispense.isPending &&
                                    actions.dispense.variables === q.requestId
                                  }
                                  onClick={() => void give(q)}
                                  title={short ? t('pharmacy.shortHint') : undefined}
                                >
                                  <Pill size={14} aria-hidden="true" />
                                  {t('stock.handOver')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => {
                                    setRefusing(refusing === q.requestId ? null : q.requestId)
                                    setReason(short ? t('pharmacy.reasons.outOfStock') : '')
                                  }}
                                >
                                  <Ban size={14} aria-hidden="true" />
                                  {t('pharmacy.notGiven')}
                                </Button>
                              </span>
                            )}
                          </div>
                          {refusing === q.requestId && (
                            <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-2.5">
                              <span className="text-[13px] font-semibold">
                                {t('pharmacy.whyNot', { doctor: q.prescriber ?? '' })}
                              </span>
                              <span className="flex flex-wrap gap-1.5">
                                {REASONS.map((r) => (
                                  <button
                                    key={r}
                                    type="button"
                                    onClick={() => setReason(t(`pharmacy.reasons.${r}`))}
                                    className={cn(
                                      'rounded-full border px-2.5 py-1 text-[12px] font-semibold',
                                      reason === t(`pharmacy.reasons.${r}`)
                                        ? 'border-primary bg-primary text-white'
                                        : 'border-border text-ink-2 hover:bg-hover',
                                    )}
                                  >
                                    {t(`pharmacy.reasons.${r}`)}
                                  </button>
                                ))}
                              </span>
                              <input
                                className="border-border bg-card focus:border-primary h-10 rounded-lg border px-2.5 text-[14px] outline-none"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder={t('pharmacy.reasonPh')}
                                aria-label={t('pharmacy.reasonPh')}
                              />
                              <span className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  disabled={reason.trim().length < 2 || busy}
                                  onClick={() => void notGiven(q)}
                                >
                                  {t('pharmacy.confirmNotGiven')}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setRefusing(null)}>
                                  {t('staff.form.cancel')}
                                </Button>
                              </span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </ShownList>
      )}
      <p className="text-ink-3 m-0 text-[13px]">{t('pharmacy.hint')}</p>
    </Panel>
  )
}
