import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  chipHtml,
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
import { formatRwf } from '@mmc/shared'
import type { TFunction } from 'i18next'
import {
  packCountText,
  packsText,
  packWord,
  pieceWord,
  saleModeText,
  unitsText,
} from './stock-util'

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
  // newer words, in English until the translations are merged
  const kd = (key: string, en: string) => {
    const v = t(`transferDoc.${key}`, { defaultValue: en })
    return v && v !== `transferDoc.${key}` ? v : en
  }
  // the state at a glance under the title: Received / On the way / Cancelled, and a difference
  const badges = [
    n.status === 'received'
      ? chipHtml(kd('chipReceived', 'Received'), 'ok')
      : n.status === 'cancelled'
        ? chipHtml(kd('chipCancelled', 'Cancelled'), 'alert')
        : chipHtml(k('statusOnTheWay'), 'info'),
    n.hasDifference || n.items.some((x) => x.received != null && x.received !== x.quantity)
      ? chipHtml(kd('chipDifference', 'Difference on arrival'), 'warn')
      : '',
  ].join('')
  const showCost = n.items.some((x) => x.unitCost != null)
  // 0107: the value at selling price of each line, as it was when the note was written
  const showSell = n.items.some((x) => x.sellValue != null)
  const tt = t as unknown as TFunction
  /** "box of 8 · sold by the pack or by the piece · 1,500 a box · 200 a tablet". */
  const packageLine = (x: (typeof n.items)[number]): string =>
    [
      x.packSize ? packCountText(tt, 1, x.packSize, x.packUnit) : null,
      x.packSize
        ? saleModeText(tt, { packSize: x.packSize, saleMode: x.saleMode, packPrice: x.packPrice })
        : null,
      x.packPrice != null && x.packSize && x.saleMode !== 'piece'
        ? `${formatRwf(x.packPrice)} / ${packWord(tt, x.packUnit)}`
        : null,
      x.unitPrice != null ? `${formatRwf(x.unitPrice)} / ${pieceWord(tt, x.unit)}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  /** "32 tablet" and, under it, "4 boxes of 8" (typed in packs) or the packs it makes. */
  const sentCell = (x: (typeof n.items)[number]) => {
    const packs = x.packSize ? packsText(tt, x.quantity, x.packSize, x.packUnit) : null
    return packs
      ? {
          html: `<strong>${esc(unitsText(x.quantity, x.unit))}</strong><br><span class="small">${esc(packs)}</span>`,
        }
      : unitsText(x.quantity, x.unit)
  }
  const rows = n.items.map((x, i) => [
    i + 1,
    {
      html: `<strong>${esc(x.item)}</strong>${
        packageLine(x) ? `<br><span class="small">${esc(packageLine(x))}</span>` : ''
      }`,
    },
    x.batchNo ?? '',
    x.expiry ? docDate(x.expiry) : '',
    sentCell(x),
    x.received == null
      ? { html: '<span class="sig-line short"></span>' }
      : x.received !== x.quantity
        ? { html: `<strong>${esc(String(x.received))}</strong>` }
        : x.received,
    x.differenceReason
      ? {
          html: chipHtml(
            `${x.differenceAction === 'loss' ? k('loss') : k('backToSender')}: ${x.differenceReason}`,
            'warn',
          ),
        }
      : '',
    ...(showCost ? [x.value ?? null] : []),
    ...(showSell ? [x.sellValue ?? null] : []),
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
      { label: k('sent'), num: true, width: '24mm' },
      { label: k('received'), num: true, width: '20mm' },
      { label: k('difference') },
      ...(showCost
        ? [
            {
              label: kd('costValue', 'Cost (RWF)'),
              money: true,
              width: '22mm',
            },
          ]
        : []),
      ...(showSell
        ? [
            {
              label: kd('sellValue', 'At selling price (RWF)'),
              money: true,
              width: '24mm',
            },
          ]
        : []),
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
            ...(showSell
              ? [n.sellValue ?? n.items.reduce((s, x) => s + (x.sellValue ?? 0), 0)]
              : []),
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
      badges,
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
    css: '.dt td .chip { white-space: normal; }',
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
