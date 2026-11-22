import { Fragment, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Calculator } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { tableRow } from '@/components/dash/kit-style'
import { PeriodCustom, PeriodSeg } from '@/components/dash/period-filter'
import { Field } from '@/components/ui/field'
import {
  TAX_KINDS,
  cleanPercent,
  fetchTaxOverview,
  useFinanceSummary,
  useTaxOverview,
  type TaxKind,
} from '@/lib/api/accounts'
import { kigaliToday } from '@/lib/clock'
import { usePeriod } from '@/lib/period'
import { cn } from '@/lib/utils'
import { figureAmount, figureLabel } from './accounts-tabs'

/**
 * The tax base (0187, grouped 0188, its own period 0189): what the system knows for the period
 * chosen — the money in, the expenses, the result before tax — and the taxes in their groups so
 * every figure can be traced: the income tax (estimated at the rate typed, less the credits
 * withheld at source and what was paid on the taxes of kind "on the profit" in the period), the
 * other taxes paid by kind with their totals, then all taxes and the result after taxes paid.
 * Information for the accountant, who types the declared amount on the tax itself; nothing
 * here is booked. 0194: the rate starts from the percentage saved on the income tax.
 */

/** A tax's payments within the period: from the overviews of the years the period spans. */
interface PaidTax {
  id: string
  name: string
  kind: TaxKind
  paid: number
}
async function fetchTaxesPaid(from: string, to: string): Promise<PaidTax[]> {
  const first = Number(from.slice(0, 4))
  const last = Number(to.slice(0, 4))
  const years: number[] = []
  for (let y = Math.max(first, last - 3); y <= last; y++) years.push(y)
  const overviews = await Promise.all(years.map((y) => fetchTaxOverview(y)))
  const byId = new Map<string, PaidTax>()
  for (const o of overviews)
    for (const x of o.taxes)
      for (const p of x.periods) {
        if (p.status !== 'paid' || !p.paidOn || p.paidOn < from || p.paidOn > to) continue
        const cur = byId.get(x.id) ?? { id: x.id, name: x.name, kind: x.kind, paid: 0 }
        cur.paid += p.paidAmount ?? p.amount ?? 0
        byId.set(x.id, cur)
      }
  return [...byId.values()].sort(
    (a, b) => TAX_KINDS.indexOf(a.kind) - TAX_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name),
  )
}

export function TaxBasePanel({ i }: { i: number }) {
  const { t } = useTranslation()
  const period = usePeriod('year')
  const { data: s, error } = useFinanceSummary(period.from, period.to)
  const { data: taxes = [] } = useQuery({
    queryKey: ['accounts', 'tax-base', period.from, period.to],
    queryFn: () => fetchTaxesPaid(period.from, period.to),
  })
  // 0194: the rate starts from the one saved on the income tax (Percentage of the result before
  // tax), so the system holds one 28%; a rate typed here is for this estimate only
  const { data: overview } = useTaxOverview(Number(kigaliToday().slice(0, 4)))
  const saved = (overview?.taxes ?? []).find(
    (x) => x.kind === 'profit' && x.rateBase === 'result' && x.rate != null,
  )
  const [typed, setTyped] = useState<string | null>(null)
  const rate = typed ?? (saved?.rate != null ? String(saved.rate) : '28')
  const r = Number(rate) || 0
  const result = s?.net ?? 0
  const estimate = Math.max(0, Math.round((result * r) / 100))
  const byKind = (k: TaxKind) => taxes.filter((x) => x.kind === k && x.paid > 0)
  const paidOf = (list: PaidTax[]) => list.reduce((a, x) => a + x.paid, 0)
  const withheldTaxes = byKind('withheld')
  const profitTaxes = byKind('profit')
  const withheld = paidOf(withheldTaxes)
  const paidOnProfit = paidOf(profitTaxes)
  const stillToPay = Math.max(0, estimate - withheld - paidOnProfit)
  // the other kinds, with their taxes; the one-off taxes recorded on the expenses tab are the
  // rest of the taxes paid (every expense of the kind Taxes) once the periods are taken out
  const otherKinds = TAX_KINDS.filter((k) => k !== 'profit' && k !== 'withheld')
  const periodsPaid = taxes.filter((x) => x.kind !== 'withheld').reduce((a, x) => a + x.paid, 0)
  const taxesPaid = s?.taxes ?? 0
  const oneOff = Math.max(0, taxesPaid - periodsPaid)
  const otherTotal = otherKinds.reduce((a, k) => a + paidOf(byKind(k)), 0) + oneOff
  const kindWord = (k: TaxKind) => t(`accounts.taxes.kinds.${k}`)
  const resultTone = (v: number) => (v >= 0 ? 'text-green' : 'text-red')
  return (
    <Panel i={i} icon={Calculator} tint="violet" title={t('accounts.taxBase.title2')}>
      <div className="flex flex-col gap-4">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.lead')}</p>
        <PeriodSeg period={period} className="max-w-full flex-wrap" />
        <PeriodCustom period={period} />
        <p className="text-ink-2 m-0 text-[13px] font-semibold">{period.label}</p>
        {error && <p className="text-red m-0 text-[14px] font-medium">{error.message}</p>}
        {s && (
          <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
            <Group title={t('accounts.taxBase.periodFigures')}>
              <Row label={t('accounts.money.revenue')} value={s.netRevenue} />
              <Row label={t('accounts.money.otherIncome')} value={s.otherIncome} />
              <Row label={t('accounts.taxBase.moneyIn')} value={s.moneyIn} strong />
              <Row
                label={t('accounts.money.staffCost')}
                value={s.salaries + s.statutory + s.remittances}
              />
              <Row label={t('accounts.money.other')} value={s.otherExpenses} />
              <Row label={t('accounts.money.stock')} value={s.stockBought} />
              <Row label={t('accounts.taxBase.expenses')} value={s.expenses} strong />
              <Row label={t('accounts.money.net')} value={s.net} strong tone={resultTone(s.net)} />
            </Group>
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field
                  wrapperClassName="w-28"
                  label={t('accounts.taxBase.rate')}
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setTyped(cleanPercent(e.target.value))}
                />
                <p className="text-ink-3 m-0 min-w-0 flex-[1_1_10rem] pb-2 text-[13px]">
                  {saved && typed == null
                    ? t('accounts.taxBase.rateFrom', { name: saved.name })
                    : t('accounts.taxBase.rateHint')}
                </p>
              </div>
              <Group title={t('accounts.taxBase.incomeTax')}>
                <Row label={t('accounts.taxBase.estimate', { rate: r })} value={estimate} strong />
                <Row label={t('accounts.taxBase.withheld')} value={withheld} />
                {withheldTaxes.map((x) => (
                  <Row key={`w-${x.id}`} label={x.name} value={x.paid} sub />
                ))}
                <Row label={t('accounts.taxBase.paidOnProfit')} value={paidOnProfit} />
                {profitTaxes.map((x) => (
                  <Row key={`p-${x.id}`} label={x.name} value={x.paid} sub />
                ))}
                {profitTaxes.length === 0 && <Note>{t('accounts.taxBase.noneOnProfit')}</Note>}
                <Row
                  label={t('accounts.taxBase.stillToPay')}
                  value={stillToPay}
                  strong
                  tone="text-amber"
                />
              </Group>
            </div>
            <Group title={t('accounts.taxBase.otherTaxes')}>
              {otherKinds.map((k) => {
                const list = byKind(k)
                return list.length === 0 ? null : (
                  <Fragment key={`k-${k}`}>
                    <Row label={kindWord(k)} value={paidOf(list)} />
                    {list.map((x) => (
                      <Row key={`t-${x.id}`} label={x.name} value={x.paid} sub />
                    ))}
                  </Fragment>
                )
              })}
              {oneOff > 0 && <Row label={t('accounts.taxBase.oneOff')} value={oneOff} />}
              {otherTotal === 0 && <Note>{t('accounts.taxBase.noneOther')}</Note>}
              <Row label={t('accounts.taxBase.otherTotal')} value={otherTotal} strong />
            </Group>
            <Group title={t('accounts.taxBase.allTaxes')}>
              <Row label={t('accounts.taxBase.incomeTaxPaid')} value={paidOnProfit} sub />
              <Row label={t('accounts.taxBase.otherTotal')} value={otherTotal} sub />
              <Row label={t('accounts.taxBase.taxesPaid2')} value={taxesPaid} strong />
              <Row
                label={t('accounts.money.afterTax')}
                value={s.net - taxesPaid}
                strong
                tone={resultTone(s.net - taxesPaid)}
              />
            </Group>
          </div>
        )}
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.hint')}</p>
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.kindRule')}</p>
      </div>
    </Panel>
  )
}

/** One figure of the base: a label and an amount; sub rows are the taxes under a group line. */
function Row({
  label,
  value,
  strong,
  tone,
  sub,
}: {
  label: string
  value: number
  strong?: boolean
  tone?: string
  sub?: boolean
}) {
  return (
    <tr className={tableRow}>
      <td className={cn(figureLabel, strong && 'font-semibold', sub && 'text-ink-2 pl-6')}>
        {label}
      </td>
      <td className={cn(figureAmount, strong && 'font-semibold', sub && 'text-ink-2', tone)}>
        {formatRwf(Math.round(value))}
      </td>
    </tr>
  )
}

function Note({ children }: { children: ReactNode }) {
  return (
    <tr>
      <td colSpan={2} className="text-ink-3 pb-2 pl-6 text-[12px]">
        {children}
      </td>
    </tr>
  )
}

/** A bordered group with its heading. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-border bg-card flex min-w-0 flex-col rounded-md border p-3">
      <h4 className="text-violet m-0 mb-1 text-[11px] font-semibold tracking-wide uppercase">
        {title}
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  )
}
