import i18n from 'i18next'
import { formatRwf } from '@mmc/shared'
import { receiptDocOf, type ReceiptRow } from '@/lib/api/analytics-receipts'
import { docDate, makeDocLabels, openPrintWindow, type TFn } from '@/lib/doc-style'
import { buildReceiptsBatchHtml, receiptText, type ReceiptsBatchCover } from '@/lib/receipt-doc'
import type { LetterheadWithLegacy } from '@/lib/report-parts'

/**
 * "Print all receipts" (0102): the receipts of a period in one document, each as the cash desk
 * printed it, with a cover line "N receipts · RWF total · period · printed by". Pure except for
 * the print window.
 */

const tx = (t: TFn, key: string, en: string, vars?: Record<string, unknown>) => {
  const v = t(key, { defaultValue: en, ...(vars ?? {}) })
  return v && v !== key ? v : en
}

export interface ReceiptsBatchInput {
  rows: ReceiptRow[]
  from: string
  to: string
  clinic: LetterheadWithLegacy
  printedBy: string
  /** The filters in words (left out when not filtered). */
  cashier?: string | null
  method?: string | null
}

/** The whole document's HTML (for a preview, a test, or the print window). */
export function receiptsBatchHtml(
  input: ReceiptsBatchInput,
  t: TFn,
  opts: { lang?: string; autoPrint?: boolean; now?: Date } = {},
): string {
  const dl = makeDocLabels(t)
  const rt = receiptText(t)
  const docs = input.rows.map((r) => receiptDocOf(r, input.clinic))
  const total = input.rows.reduce((s, r) => s + r.amount, 0)
  const periodLabel =
    input.from === input.to
      ? docDate(input.from)
      : t('report.range', { from: docDate(input.from), to: docDate(input.to) })
  const methodWord = input.method ? dl.method(input.method) : null
  const cover: ReceiptsBatchCover = {
    title: tx(t, 'receipts.reportTitle', 'Receipts of the period'),
    periodWord: t('report.period'),
    periodLabel,
    countLabel: tx(t, 'receipts.count', 'Receipts'),
    totalLabel: t('report.fig.collected'),
    cashier: input.cashier ?? null,
    method: methodWord,
    cashierLabel: t('report.cols.cashier'),
    methodLabel: t('report.cols.method'),
    columns: {
      no: t('report.cols.receiptNo'),
      time: t('report.cols.dateTime'),
      patient: t('finance.cols.patient'),
      file: t('report.cols.file'),
      method: t('report.cols.method'),
      cashier: t('report.cols.cashier'),
      amount: t('report.cols.amount'),
    },
    summary: tx(
      t,
      'receipts.coverLine',
      '{{count}} receipts · {{amount}} · {{period}} · printed by {{name}}',
      {
        count: input.rows.length,
        amount: formatRwf(total),
        period: periodLabel,
        name: input.printedBy,
      },
    ),
  }
  return buildReceiptsBatchHtml(docs, rt, dl, cover, {
    lang: opts.lang,
    autoPrint: opts.autoPrint,
    printedBy: input.printedBy,
    printedAt: opts.now,
  })
}

/** Opens the document in a print window (false when the window is blocked, or nothing to print). */
export function openReceiptsBatch(input: ReceiptsBatchInput): boolean {
  if (input.rows.length === 0) return false
  const t: TFn = (key, vars) => i18n.t(key, { ...(vars ?? {}) }) as string
  return openPrintWindow(receiptsBatchHtml(input, t, { lang: i18n.language }))
}
