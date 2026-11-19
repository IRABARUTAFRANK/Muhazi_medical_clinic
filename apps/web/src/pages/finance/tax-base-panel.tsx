import { Fragment, useState, type ReactNode } from 'react'
import { Calculator } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf } from '@mmc/shared'
import { Panel } from '@/components/dash/kit'
import { tableCell, tableFirstCell, tableRow } from '@/components/dash/kit-style'
import { Field } from '@/components/ui/field'
import { TAX_KINDS, type Tax, type TaxKind, type TaxOverview } from '@/lib/api/accounts'
import { cn } from '@/lib/utils'

/**
 * The tax base of the year (0187, grouped 0188): what the system knows — the money in, the
 * expenses, the result before tax — and the taxes in their groups so every figure can be
 * traced: the income tax (estimated at the rate typed, less the credits withheld at source and
 * what was paid on the taxes of kind "on the profit"), the other taxes paid by kind with their
 * totals, then all taxes and the result after taxes paid. Information for the accountant, who
 * types the declared amount on the tax itself; nothing here is booked.
 *
 * Every repeated row carries its own key: two rows with one key made React keep stale copies on
 * each refresh (the "total" line repeated).
 */
export function TaxBasePanel({ i, o }: { i: number; o: TaxOverview }) {
  const { t } = useTranslation()
  const [rate, setRate] = useState('28')
  const b = o.base
  const r = Number(rate) || 0
  const estimate = Math.max(0, Math.round((b.resultBeforeTax * r) / 100))
  const byKind = (k: TaxKind): Tax[] => o.taxes.filter((x) => x.kind === k && x.paidThisYear > 0)
  const paidOf = (list: Tax[]) => list.reduce((s, x) => s + x.paidThisYear, 0)
  const withheldTaxes = byKind('withheld')
  const profitTaxes = byKind('profit')
  const withheld = paidOf(withheldTaxes)
  const paidOnProfit = paidOf(profitTaxes)
  const stillToPay = Math.max(0, estimate - withheld - paidOnProfit)
  // the other kinds, with their taxes; the one-off taxes recorded on the expenses tab are the
  // rest of the taxes paid (every expense of the kind Taxes) once the periods are taken out
  const otherKinds = TAX_KINDS.filter((k) => k !== 'profit' && k !== 'withheld')
  const periodsPaid = o.taxes
    .filter((x) => x.kind !== 'withheld')
    .reduce((s, x) => s + x.paidThisYear, 0)
  const oneOff = Math.max(0, b.taxesPaid - periodsPaid)
  const otherTotal = otherKinds.reduce((s, k) => s + paidOf(byKind(k)), 0) + oneOff
  const kindWord = (k: TaxKind) => t(`accounts.taxes.kinds.${k}`)
  const resultTone = (v: number) => (v >= 0 ? 'text-green' : 'text-red')
  return (
    <Panel
      i={i}
      icon={Calculator}
      tint="violet"
      title={t('accounts.taxBase.title', { year: o.year })}
    >
      <div className="flex flex-col gap-4">
        <p className="text-ink-3 m-0 text-[13px]">{t('accounts.taxBase.lead')}</p>
        <div className="pc:grid-cols-2 grid grid-cols-1 gap-4">
          <Group title={t('accounts.taxBase.yearFigures')}>
            <Row label={t('accounts.money.revenue')} value={b.netRevenue} />
            <Row label={t('accounts.money.otherIncome')} value={b.otherIncome} />
            <Row label={t('accounts.taxBase.moneyIn')} value={b.moneyIn} strong />
            <Row
              label={t('accounts.money.staffCost')}
              value={b.salaries + b.statutory + b.remittances}
            />
            <Row label={t('accounts.money.other')} value={b.otherExpenses} />
            <Row label={t('accounts.money.stock')} value={b.stockBought} />
            <Row label={t('accounts.taxBase.expenses')} value={b.expenses} strong />
            <Row
              label={t('accounts.money.net')}
              value={b.resultBeforeTax}
              strong
              tone={resultTone(b.resultBeforeTax)}
            />
          </Group>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field
                wrapperClassName="w-28"
                label={t('accounts.taxBase.rate')}
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
              />
              <p className="text-ink-3 m-0 pb-2 text-[13px]">{t('accounts.taxBase.rateHint')}</p>
            </div>
            <Group title={t('accounts.taxBase.incomeTax')}>
              <Row label={t('accounts.taxBase.estimate', { rate: r })} value={estimate} strong />
              <Row label={t('accounts.taxBase.withheld')} value={withheld} />
              {withheldTaxes.map((x) => (
                <Row key={`w-${x.id}`} label={x.name} value={x.paidThisYear} sub />
              ))}
              <Row label={t('accounts.taxBase.paidOnProfit')} value={paidOnProfit} />
              {profitTaxes.map((x) => (
                <Row key={`p-${x.id}`} label={x.name} value={x.paidThisYear} sub />
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
                    <Row key={`t-${x.id}`} label={x.name} value={x.paidThisYear} sub />
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
            <Row label={t('accounts.taxBase.taxesPaid')} value={b.taxesPaid} strong />
            <Row
              label={t('accounts.money.afterTax')}
              value={b.resultBeforeTax - b.taxesPaid}
              strong
              tone={resultTone(b.resultBeforeTax - b.taxesPaid)}
            />
          </Group>
        </div>
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
      <td className={cn(tableFirstCell, strong && 'font-semibold', sub && 'text-ink-2 pl-6')}>
        {label}
      </td>
      <td
        className={cn(
          tableCell,
          'text-right whitespace-nowrap tabular-nums',
          strong && 'font-semibold',
          sub && 'text-ink-2',
          tone,
        )}
      >
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

/** A bordered group with its heading: the year's figures, the income tax, the other taxes, all. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-border bg-card flex flex-col rounded-md border p-3">
      <h4 className="text-violet m-0 mb-1 text-[11px] font-semibold tracking-wide uppercase">
        {title}
      </h4>
      <table className="w-full border-collapse text-[14px]">
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
