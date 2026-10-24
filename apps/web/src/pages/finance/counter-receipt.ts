import type { TFunction } from 'i18next'
import type { CounterSale } from '@/lib/api/counter-sales'
import { openReceipt, type ReceiptDoc } from '@/lib/receipt-doc'
import type { LetterheadWithLegacy } from '@/lib/report-parts'

/**
 * The receipt of a counter sale (a walk-in buyer without a visit): the buyer pays the whole total
 * at the cash price, so there is no insurer share. The sale number stands where a visit's bill
 * number would. Built from the sale; the receipt document itself is shared with the visits.
 */
export function counterReceiptDoc(
  sale: Pick<CounterSale, 'number' | 'buyer' | 'phone' | 'total' | 'lines'>,
  pay: {
    receipt: string | null
    method: string | null
    amount: number
    reference?: string | null
    at?: string | null
    cashier?: string | null
  },
  clinic: LetterheadWithLegacy,
  t: TFunction,
): ReceiptDoc {
  const lines =
    sale.lines.length > 0
      ? sale.lines.map((l) => ({
          description: l.item,
          quantity: l.quantity,
          amount: l.lineTotal,
          unitPrice: l.unitPrice,
          fullAmount: l.lineTotal,
        }))
      : // a sale whose lines could not be read: one line for the whole amount
        [
          {
            description: t('cashierDesk.counter.saleLine', { number: sale.number }),
            quantity: 1,
            amount: sale.total,
            unitPrice: sale.total,
            fullAmount: sale.total,
          },
        ]
  return {
    receiptNo: pay.receipt,
    invoiceNo: sale.number,
    at: pay.at ? new Date(pay.at) : new Date(),
    clinic,
    patient: {
      name: sale.buyer?.trim() || t('cashierDesk.counter.walkIn'),
      fileNumber: '',
      insurer: null,
    },
    lines,
    total: sale.total,
    insurer: null,
    payment: pay.method
      ? { method: pay.method, amount: pay.amount, reference: pay.reference ?? null }
      : null,
    paid: pay.amount,
    balance: Math.max(0, sale.total - pay.amount),
    cashier: pay.cashier ?? '',
  }
}

/** Opens the counter sale's receipt in a print window (false when the window is blocked). */
export function openCounterReceipt(
  sale: Parameters<typeof counterReceiptDoc>[0],
  pay: Parameters<typeof counterReceiptDoc>[1],
  clinic: LetterheadWithLegacy,
  t: TFunction,
  printedBy?: string | null,
): boolean {
  return openReceipt(counterReceiptDoc(sale, pay, clinic, t), undefined, {
    printedBy: printedBy ?? null,
  })
}
