import { useState } from 'react'
import { BedDouble, Check, Moon, Save, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { IconChip } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { useBedAdmin, useBedBoard, type BoardBed } from '@/lib/api/desk-ops'
import { cn } from '@/lib/utils'

const errorBox = 'bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-[13px] font-semibold'
const digits = (v: string) => v.replace(/[^0-9]/g, '')

/**
 * Manager: how many beds the clinic has and what one night costs (one price for all beds, or a
 * price per bed). Occupied beds are never removed; stays already billed keep their price.
 */
export function BedsCard() {
  const { t } = useTranslation()
  const { data: beds = [] } = useBedBoard()
  const admin = useBedAdmin()
  const [count, setCount] = useState<string | null>(null)
  const [price, setPrice] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const occupied = beds.filter((b) => b.state === 'occupied').length
  const prices = [...new Set(beds.map((b) => b.nightlyPrice))]
  const countValue = count ?? String(beds.length)
  const priceValue = price ?? (prices.length === 1 ? String(prices[0]) : '')

  const apply = async () => {
    setDone(false)
    await admin.setCount.mutateAsync({
      count: Number(countValue || 0),
      nightlyPrice: priceValue === '' ? null : Number(priceValue),
    })
    setCount(null)
    setPrice(null)
    setDone(true)
  }

  return (
    <Card>
      <CardHeader>
        <span className="flex items-center gap-2.5">
          <IconChip icon={BedDouble} tint="navy" />
          {t('settings.beds.title')}
        </span>
        <span className="text-ink-2 text-[13px] font-semibold tabular-nums">
          {t('settings.beds.summary', { count: beds.length, occupied })}
        </span>
      </CardHeader>
      <CardBody className="gap-4">
        <p className="text-ink-2 m-0 text-[14px]">{t('settings.beds.lead')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={t('settings.beds.count')}
            inputMode="numeric"
            value={countValue}
            onChange={(e) => {
              setCount(digits(e.target.value).slice(0, 3))
              setDone(false)
            }}
            wrapperClassName="w-40"
          />
          <Field
            label={t('settings.beds.price')}
            inputMode="numeric"
            value={priceValue}
            onChange={(e) => {
              setPrice(digits(e.target.value).slice(0, 9))
              setDone(false)
            }}
            wrapperClassName="w-56"
          />
          <Button
            variant="primary"
            loading={admin.setCount.isPending}
            disabled={count == null && price == null}
            onClick={() => void apply().catch(() => undefined)}
          >
            <Check size={16} aria-hidden="true" />
            {t('settings.beds.apply')}
          </Button>
          {done && !admin.setCount.isPending && (
            <span className="text-green text-[13px] font-semibold">{t('settings.beds.saved')}</span>
          )}
        </div>
        {prices.length > 1 && price == null && (
          <p className="text-ink-3 m-0 text-[13px]">{t('settings.beds.mixed')}</p>
        )}
        {admin.setCount.error && (
          <p role="alert" className={errorBox}>
            {admin.setCount.error.message}
          </p>
        )}

        {beds.length > 0 && (
          <div className="flex flex-col">
            <span className="text-ink-3 mb-1 text-[12px] font-bold tracking-[.06em] uppercase">
              {t('settings.beds.each')}
            </span>
            {beds.map((b) => (
              <BedRow key={`${b.id}-${b.name}-${b.nightlyPrice}`} bed={b} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function BedRow({ bed }: { bed: BoardBed }) {
  const { t } = useTranslation()
  const admin = useBedAdmin()
  const [name, setName] = useState(bed.name)
  const [price, setPrice] = useState(String(bed.nightlyPrice))
  const [error, setError] = useState<string | null>(null)
  const changed = name.trim() !== bed.name || Number(price || 0) !== bed.nightlyPrice
  const busy = admin.save.isPending || admin.remove.isPending
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="border-grid flex flex-wrap items-center gap-2 border-b py-2 last:border-b-0">
      <BedDouble size={16} aria-hidden="true" className="text-ink-3 flex-none" />
      <input
        aria-label={t('settings.beds.name')}
        className="border-border bg-card h-10 w-36 rounded-lg border px-2.5 text-[14px] font-semibold"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <span className="text-ink-3 inline-flex items-center gap-1 text-[13px]">
        <Moon size={13} aria-hidden="true" />
      </span>
      <input
        aria-label={t('settings.beds.price')}
        inputMode="numeric"
        className="border-border bg-card h-10 w-32 rounded-lg border px-2.5 text-[14px] tabular-nums"
        value={price}
        onChange={(e) => setPrice(digits(e.target.value).slice(0, 9))}
      />
      <span className="text-ink-3 text-[13px]">RWF</span>
      <span
        className={cn(
          'rounded-full px-2.5 py-0.5 text-[12px] font-bold',
          bed.state === 'occupied' ? 'bg-primary-tint text-primary' : 'bg-green-bg text-green',
        )}
      >
        {t(`desk.bedState.${bed.state}`)}
      </span>
      <span className="flex-1" />
      <Button
        size="sm"
        variant={changed ? 'primary' : 'default'}
        disabled={!changed || busy}
        onClick={() =>
          void run(() =>
            admin.save.mutateAsync({
              id: bed.id,
              name: name.trim(),
              nightlyPrice: Number(price || 0),
            }),
          )
        }
      >
        <Save size={14} aria-hidden="true" />
        {t('settings.beds.save')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={bed.state === 'occupied' || busy}
        title={bed.state === 'occupied' ? t('settings.beds.occupiedNoRemove') : undefined}
        onClick={() => {
          if (window.confirm(t('settings.beds.confirmRemove', { name: bed.name })))
            void run(() => admin.remove.mutateAsync(bed.id))
        }}
      >
        <Trash2 size={14} aria-hidden="true" />
        {t('settings.beds.remove')}
      </Button>
      {error && <p className={cn(errorBox, 'w-full')}>{error}</p>}
      {bed.state === 'occupied' && bed.patient && (
        <span className="text-ink-3 w-full pl-6 text-[12px]">
          {bed.patient} · {formatRwf(bed.nightlyPrice)}
        </span>
      )}
    </div>
  )
}
