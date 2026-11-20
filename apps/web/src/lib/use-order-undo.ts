import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import type { VisitBill } from '@/lib/api/billing'
import { useConfirm } from '@/lib/confirm'
import {
  givenDoses,
  undoEndsOrder,
  useNurseOrderActions,
  type NurseOrder,
} from '@/lib/api/nurse-orders'
import { undoBody, undoMessage } from '@/lib/order-words'

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * Undo on an order of step 6 (0193), the same on the order and on its bill line: the question says
 * who gave it and when, what goes back to the stock, what leaves the bill (or the credit note when
 * the bill is closed) and what becomes of the order; the reason is typed in the box. Answers the
 * message to show, or null when the person went back.
 */
export function useOrderUndo() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const actions = useNurseOrderActions()
  const undo = async (
    o: NurseOrder,
    c: {
      myId: string | null | undefined
      isManager: boolean
      patientName: string
      visitOver?: boolean
      /** Unknown: read from the bill already loaded for the visit, if any. */
      billClosed?: boolean
    },
  ): Promise<string | null> => {
    const given = givenDoses(o)
    const last = given[given.length - 1]
    const bill = qc.getQueryData<VisitBill>(['visit', o.encounterId, 'bill'])
    const billClosed = c.billClosed ?? (!!bill?.status && bill.status !== 'draft')
    const r = await confirm({
      title: t('nurseOrders.undoQ', { what: o.text, name: c.patientName }),
      body: undoBody(t, o, {
        endsOrder: undoEndsOrder(o, c.myId, c.isManager),
        visitOver: !!c.visitOver,
        billClosed,
        by: last?.by ?? null,
        when: last ? when(last.at) : null,
      }),
      input: { label: t('nurseOrders.undoWhy'), required: true, multiline: true },
      confirmLabel: t('nurseOrders.undoYes'),
      tone: 'danger',
    })
    if (!r.ok) return null
    const res = await actions.undo.mutateAsync({ id: o.id, reason: r.value })
    return undoMessage(t, o, res)
  }
  return { undo, pending: actions.undo.isPending }
}
