import { CircleAlert, Info, ReceiptText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { summaryWords, type OrderSummary as Summary } from '@/lib/order-summary'
import { cn } from '@/lib/utils'

const TONE: Record<Summary['tone'], string> = {
  ok: 'border-green/40 bg-green-bg/60 text-ink',
  short: 'border-red bg-red-bg text-red',
  wholePacks: 'border-amber/50 bg-amber-bg text-amber',
  noPrice: 'border-amber/50 bg-amber-bg text-amber',
  typed: 'border-border bg-hover/60 text-ink-2',
}

/**
 * Step 6 (0193): above the Send button, what the order will do when it is marked given or done —
 * what leaves the clinic's stock and what goes on the bill, at the cash price. Red when the stock
 * is short, amber when a box-only medicine is not asked in whole boxes or no price is set, grey for
 * an act written by hand (not billed). Read aloud as it changes.
 */
export function OrderSummary({
  summary: s,
  kind,
  hand = false,
  unit,
  act,
  actCount,
  packUnit,
  partText,
  home,
}: {
  summary: Summary
  kind: 'act' | 'drug'
  /** A medicine all to take home: its button is “Handed over”. */
  hand?: boolean
  /** The medicine's piece (tab, cap…). */
  unit: string
  /** The act's name. */
  act: string
  actCount: number
  packUnit: string | null
  /** 0198: the part of a piece in words ("½ tab", "5 ml"). */
  partText?: string | null
  /** 0198: a repeated order: the pieces to take home (its own order). */
  home?: number
}) {
  const { t } = useTranslation()
  // nothing asked yet: nothing to say
  if (kind === 'drug' ? s.pieces <= 0 && s.part <= 0 && !home : !act.trim()) return null
  const Icon = s.tone === 'ok' ? ReceiptText : s.tone === 'typed' ? Info : CircleAlert
  return (
    <p
      aria-live="polite"
      className={cn(
        'm-0 flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]',
        TONE[s.tone],
      )}
    >
      <Icon size={16} aria-hidden="true" className="mt-0.5 flex-none" />
      <span className="min-w-0">
        <b className="font-semibold">
          {t(
            kind === 'act'
              ? 'nurseOrders.summaryDone'
              : hand
                ? 'nurseOrders.summaryHand'
                : 'nurseOrders.summaryGive',
          )}
        </b>{' '}
        {summaryWords(t, s, { kind, unit, act, actCount, packUnit, partText, home })}
      </span>
    </p>
  )
}
