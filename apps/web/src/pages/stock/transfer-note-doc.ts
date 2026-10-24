import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  docDate,
  docDateTime,
  esc,
  documentHtml,
  letterheadFrom,
  letterheadHtml,
  makeDocLabels,
  openPrintWindow,
  signatureHtml,
  tableHtml,
  titleBlockHtml,
  runInHtml,
  type Letterhead,
  type ProfileLike,
  type HoursLike,
  type TFn,
} from '@/lib/doc-style'
import { useClinicInfo } from '@/lib/api/public'
import type { TransferNoteDetail } from '@/lib/api/rooms'
import { useSession } from '@/store/session'

/**
 * The printed transfer note (T-…) that goes with the medicines from the pharmacy to a room
 * store, or the return note (RT-…) that goes back: what was sent, batch by batch, with a column
 * for what really arrived and the signatures of who sent and who received. Uses the clinic's
 * shared document style (doc-style.ts).
 */
export function buildTransferNoteHtml(
  n: TransferNoteDetail,
  lh: Letterhead,
  t: TFn,
  o: { printedBy: string; lang: string },
): string {
  const labels = makeDocLabels(t)
  const k = (key: string, vars?: Record<string, unknown>) => t(`transferDoc.${key}`, vars)
  const title = n.direction === 'to_room' ? k('titleOut') : k('titleReturn')
  const status =
    n.status === 'received'
      ? k('statusReceived', { date: docDateTime(n.receivedAt), name: n.receivedBy ?? '' })
      : n.status === 'cancelled'
        ? k('statusCancelled', { reason: n.cancelReason ?? '' })
        : k('statusOnTheWay')
  const showCost = n.items.some((x) => x.unitCost != null)
  const rows = n.items.map((x, i) => [
    i + 1,
    x.item,
    x.batchNo ?? '',
    x.expiry ? docDate(x.expiry) : '',
    x.quantity,
    x.received == null ? { html: '<span class="sig-line short"></span>' } : x.received,
    x.differenceReason
      ? `${x.differenceAction === 'loss' ? k('loss') : k('backToSender')}: ${x.differenceReason}`
      : '',
    ...(showCost ? [x.value ?? null] : []),
  ])
  const units = n.items.reduce((s, x) => s + x.quantity, 0)
  const received = n.items.every((x) => x.received != null)
    ? n.items.reduce((s, x) => s + (x.received ?? 0), 0)
    : null
  const table = tableHtml(
    [
      { label: '#', num: true, width: '8mm' },
      { label: k('medicine') },
      { label: k('batch'), width: '24mm' },
      { label: k('expiry'), width: '22mm' },
      { label: k('sent'), num: true, width: '16mm' },
      { label: k('received'), num: true, width: '20mm' },
      { label: k('difference') },
      ...(showCost ? [{ label: k('value'), money: true, width: '22mm' }] : []),
    ],
    rows,
    {
      totals: [
        {
          grand: true,
          cells: [
            '',
            labels.total,
            '',
            '',
            units,
            received,
            '',
            ...(showCost ? [n.value ?? null] : []),
          ],
        },
      ],
    },
  )
  const body = [
    letterheadHtml(lh, labels, 'compact'),
    titleBlockHtml({
      title,
      scope: `${n.from} → ${n.to}`,
      meta: [
        [labels.docNo, n.number],
        [k('sentAt'), docDateTime(n.sentAt)],
        [k('request'), n.requestNumber],
        [k('status'), status],
      ],
    }),
    table,
    runInHtml(k('note'), n.note),
    runInHtml(k('receiveNote'), n.receiveNote),
    `<p class="runin">${esc(k('checkHint'))}</p>`,
    signatureHtml(
      [
        { heading: k('sentBy'), name: n.sentBy ?? '', date: docDateTime(n.sentAt) },
        {
          heading: k('receivedBy'),
          name: n.receivedBy ?? '',
          date: n.receivedAt ? docDateTime(n.receivedAt) : null,
        },
      ],
      labels,
      { clinicName: lh.legalName },
    ),
  ].join('')
  return documentHtml({
    base: {
      page: 'a4',
      title,
      docNo: n.number,
      clinicName: lh.legalName,
      printedBy: o.printedBy,
      labels,
    },
    body,
    lang: o.lang,
  })
}

/** Prints a transfer or return note; false when the browser blocked the window. */
export function useTransferNotePrint() {
  const { t, i18n } = useTranslation()
  const { data: info } = useClinicInfo()
  const printedBy = useSession((s) => s.user?.name ?? '')
  const lh = useMemo(() => {
    const tt = t as unknown as TFn
    const shortDays = t('days.short', { returnObjects: true }) as unknown
    return letterheadFrom((info?.profile ?? {}) as ProfileLike, makeDocLabels(tt), {
      logoUrl: `${window.location.origin}/logo.jpg`,
      hours: (info?.hours ?? null) as HoursLike | null,
      shortDays: Array.isArray(shortDays) ? (shortDays as string[]) : [],
    })
  }, [info, t])
  return (n: TransferNoteDetail): boolean =>
    openPrintWindow(
      buildTransferNoteHtml(n, lh, t as unknown as TFn, {
        printedBy,
        lang: i18n.language,
      }),
    )
}
