import { useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useBillingActions, type Charge, type ChargeCover, type CoverMode } from '@/lib/api/billing'

const MODES: CoverMode[] = ['insurer', 'not_covered', 'private', 'price', 'coverage']

/** What was changed on a line for this patient, why and by whom (0139). */
export function ChargeCoverBadge({ cover }: { cover: ChargeCover }) {
  const { t } = useTranslation()
  return (
    <span className="flex basis-full flex-wrap items-center gap-1.5 text-[13px]">
      <Badge tone="orange">{t(`visit.cover.mode.${cover.mode}`)}</Badge>
      <span className="text-ink-2">
        {[
          cover.reason,
          cover.by,
          cover.at ? `${formatDate(new Date(cover.at))} ${formatTime(new Date(cover.at))}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </span>
  )
}

/**
 * "Change for this patient" on one line of a visit under an insurer (0139): the line is charged as
 * the insurer covers it (its price, its coverage: the default), not covered (the patient pays it
 * all), as a private patient (the clinic's price, all by the patient), at another price (the
 * insurer's coverage on it) or with another coverage — with the reason. Allowed to whoever has
 * "Change a charge's cover" (the cashier and the manager at first). A new payer for the visit puts
 * every line back to its rule.
 */
export function ChargeCoverEditor({
  encounterId,
  charge,
  payerName,
  onClose,
  onDone,
}: {
  encounterId: string
  charge: Charge
  payerName: string
  onClose: () => void
  onDone: (text: string) => void
}) {
  const { t } = useTranslation()
  const actions = useBillingActions(encounterId)
  const [mode, setMode] = useState<CoverMode>(charge.cover?.mode ?? 'insurer')
  const [price, setPrice] = useState(String(charge.unitPrice))
  const [pct, setPct] = useState(String(charge.coveragePct))
  const [reason, setReason] = useState(charge.cover?.reason ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const value =
      mode === 'price'
        ? Number(price.replace(/[^\d]/g, ''))
        : mode === 'coverage'
          ? Number(pct)
          : null
    if (mode === 'price' && (!price.trim() || !Number.isFinite(value)))
      return setError(t('visit.cover.needPrice'))
    if (
      mode === 'coverage' &&
      (!pct.trim() || !Number.isFinite(value) || value! < 0 || value! > 100)
    )
      return setError(t('visit.cover.needPct'))
    if (mode !== 'insurer' && !reason.trim()) return setError(t('visit.cover.needReason'))
    try {
      await actions.changeCover.mutateAsync({ id: charge.id, mode, value, reason })
      onDone(
        t(mode === 'insurer' ? 'visit.cover.doneBack' : 'visit.cover.done', {
          line: charge.description,
          how: t(`visit.cover.mode.${mode}`, { payer: payerName }),
          payer: payerName,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      className="border-orange/30 bg-orange-bg/40 flex basis-full flex-col gap-2 rounded-md border px-3 py-2.5"
    >
      <span className="text-ink text-[14px] font-semibold">
        {t('visit.cover.title', { line: charge.description })}
      </span>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="sr-only">{t('visit.cover.how')}</legend>
        {MODES.map((m) => (
          <label key={m} className="flex items-start gap-2 text-[14px]">
            <input
              type="radio"
              name={`cover-${charge.id}`}
              className="accent-primary mt-0.5 size-[18px] flex-none"
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            <span>
              <span className="text-ink block font-medium">
                {t(`visit.cover.mode.${m}`, { payer: payerName })}
              </span>
              <span className="text-ink-3 block text-[13px]">
                {t(`visit.cover.hint.${m}`, { payer: payerName })}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-2">
        {mode === 'price' && (
          <Field
            label={t('visit.cover.price')}
            inputMode="numeric"
            value={price}
            wrapperClassName="w-[180px]"
            onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
          />
        )}
        {mode === 'price' && price && (
          <span className="text-ink-2 pb-2 text-[13px] tabular-nums">
            {formatRwf(Number(price))}
          </span>
        )}
        {mode === 'coverage' && (
          <Field
            label={t('visit.cover.pct', { payer: payerName })}
            inputMode="decimal"
            value={pct}
            wrapperClassName="w-[180px]"
            onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
          />
        )}
        {mode !== 'insurer' && (
          <Field
            label={t('visit.cover.reason')}
            value={reason}
            maxLength={300}
            wrapperClassName="min-w-[min(320px,100%)] flex-1"
            placeholder={t('visit.cover.reasonPh')}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="border-red/30 bg-red-bg text-red m-0 rounded-md border px-3 py-2 text-[14px] font-medium"
        >
          {error}
        </p>
      )}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" loading={actions.changeCover.isPending}>
          <Save size={14} aria-hidden="true" />
          {t('visit.cover.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('staff.form.cancel')}
        </Button>
      </span>
    </form>
  )
}
