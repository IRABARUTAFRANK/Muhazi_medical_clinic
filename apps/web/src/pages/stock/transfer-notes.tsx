import { useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCheck,
  ListChecks,
  Printer,
  Truck,
  X,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf, formatTime } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import {
  expandedSection,
  selectedRow,
  tableCell,
  tableFirstCell,
  tableHead,
  tableRow,
} from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { controlClass, Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { Pager } from '@/components/ui/list-tools'
import {
  useRoomStoreActions,
  useTransferNote,
  useTransferNotes,
  type ReceiptLineInput,
  type TransferNote,
  type TransferNoteDetail,
  type TransferStatus,
} from '@/lib/api/rooms'
import { useConfirm } from '@/lib/confirm'
import { usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { ExpiryMark, MsgFlash } from './stock-shared'
import { errText, type Msg } from './stock-util'
import { useTransferNotePrint } from './transfer-note-doc'

/** The state of a note as a badge. */
export function NoteStatus({ n }: { n: Pick<TransferNote, 'status' | 'hasDifference'> }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge
        tone={n.status === 'in_transit' ? 'yellow' : n.status === 'received' ? 'green' : 'grey'}
        icon={
          n.status === 'in_transit' ? (
            <Truck size={12} aria-hidden="true" />
          ) : n.status === 'received' ? (
            <CheckCheck size={12} aria-hidden="true" />
          ) : (
            <Ban size={12} aria-hidden="true" />
          )
        }
      >
        {t(`roomStores.noteStatus.${n.status}`)}
      </Badge>
      {n.hasDifference && (
        <Badge tone="orange" icon={<AlertTriangle size={12} aria-hidden="true" />}>
          {t('roomStores.withDifference')}
        </Badge>
      )}
    </span>
  )
}

/**
 * Transfer notes (T-…, pharmacy to a room store) and return notes (RT-…, back to the pharmacy):
 * a list by state, each opening its detail (receive, cancel, print).
 */
export function TransferNotesList({
  locationId = null,
  initialStatus = 'in_transit',
  openId,
  onOpen,
  title,
  i = 2,
  canAct = true,
}: {
  locationId?: string | null
  initialStatus?: TransferStatus | 'all'
  openId: string | null
  onOpen: (id: string | null) => void
  title?: string
  i?: number
  /** false: "Manage stock" is switched off for the reader; a note opens read-only. */
  canAct?: boolean
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<TransferStatus | 'all'>(initialStatus)
  const { data: notes = [], isLoading } = useTransferNotes({
    status: status === 'all' ? null : status,
    locationId,
  })
  const paged = usePaged(notes, 10, `${status}|${locationId}`)
  return (
    <Panel
      i={i}
      icon={Truck}
      tint="teal"
      title={title ?? t('roomStores.notesTitle')}
      right={String(notes.length)}
    >
      <Select
        label={t('roomStores.noteFilter')}
        value={status}
        onChange={(e) => setStatus(e.target.value as TransferStatus | 'all')}
        wrapperClassName="sm:max-w-xs"
      >
        {(['in_transit', 'received', 'cancelled', 'all'] as const).map((s) => (
          <option key={s} value={s}>
            {s === 'all' ? t('roomStores.allNotes') : t(`roomStores.noteStatus.${s}`)}
          </option>
        ))}
      </Select>
      {isLoading ? null : paged.total === 0 ? (
        <Empty icon={Truck}>{t('roomStores.noNotes')}</Empty>
      ) : (
        <div className="flex flex-col">
          {paged.slice.map((n) => (
            <div key={n.id} className="border-grid border-b last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(openId === n.id ? null : n.id)}
                aria-expanded={openId === n.id}
                className={cn(
                  'hover:bg-hover flex min-h-10 w-full flex-wrap items-center gap-3 rounded-md px-2 py-1.5 text-left text-[14px] transition-colors duration-120',
                  openId === n.id && selectedRow,
                )}
              >
                <span className="w-28 font-semibold tabular-nums">{n.number}</span>
                <span className="min-w-[180px] flex-1">
                  <span className="flex items-center gap-1 font-semibold">
                    {n.from} <ArrowRight size={13} aria-hidden="true" /> {n.to}
                  </span>
                  <span className="text-ink-3 block text-[12px]">
                    {[
                      `${formatDate(new Date(n.sentAt))} ${formatTime(new Date(n.sentAt))}`,
                      n.sentBy,
                      n.units != null ? t('roomStores.unitsCount', { count: n.units }) : null,
                      n.requestNumber,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <NoteStatus n={n} />
                {(n.canReceive || n.canCancel) && n.status === 'in_transit' && (
                  <Badge tone="blue">{t('roomStores.waitsForYou')}</Badge>
                )}
              </button>
              {openId === n.id && (
                <div className="pb-3">
                  <TransferNoteView id={n.id} onClose={() => onOpen(null)} canAct={canAct} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
    </Panel>
  )
}

interface LineDraft {
  received: string
  reason: string
  action: 'returned' | 'loss'
}

/**
 * One note: its lines batch by batch, and what the reader may do with it now. The receiver
 * confirms everything at once or line by line (the quantity that arrived and why it differs:
 * back to the sender or a loss); the sender may cancel it before receipt (the units go back).
 */
export function TransferNoteView({
  id,
  onClose,
  canAct = true,
}: {
  id: string
  onClose?: () => void
  /** false: the sender's "Cancel the note" stays hidden ("Manage stock" switched off). */
  canAct?: boolean
}) {
  const { t } = useTranslation()
  const { data: n, error } = useTransferNote(id)
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const print = useTransferNotePrint()
  const [msg, setMsg] = useState<Msg | null>(null)
  const [byLine, setByLine] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({})
  const [note, setNote] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  if (error) return <p className="text-red m-0 text-[14px]">{error.message}</p>
  if (!n) return null
  const open = n.status === 'in_transit'
  const showCost = n.items.some((x) => x.unitCost != null)
  const draftOf = (lineId: string, sent: number): LineDraft =>
    drafts[lineId] ?? { received: String(sent), reason: '', action: 'returned' }
  const setDraft = (lineId: string, sent: number, patch: Partial<LineDraft>) =>
    setDrafts((d) => ({ ...d, [lineId]: { ...draftOf(lineId, sent), ...patch } }))

  const receive = async (all: boolean) => {
    setMsg(null)
    let lines: ReceiptLineInput[] | null = null
    if (!all) {
      lines = []
      for (const x of n.items) {
        const d = draftOf(x.lineId, x.quantity)
        const r = Number(d.received)
        if (d.received === '' || !Number.isInteger(r) || r < 0 || r > x.quantity)
          return setMsg({ ok: false, text: t('roomStores.errors.received', { item: x.item }) })
        if (r !== x.quantity && d.reason.trim().length < 3)
          return setMsg({ ok: false, text: t('roomStores.errors.differenceWhy', { item: x.item }) })
        lines.push({
          lineId: x.lineId,
          received: r,
          reason: r !== x.quantity ? d.reason.trim() : undefined,
          action: r !== x.quantity ? d.action : undefined,
        })
      }
    }
    const short = lines ? lines.reduce((s, l, k) => s + (n.items[k]!.quantity - l.received), 0) : 0
    if (
      !(await confirm({
        title: t(
          n.direction === 'to_room'
            ? 'confirm.rooms.receiveTitle'
            : 'confirm.rooms.receiveReturnTitle',
          { number: n.number, store: n.to },
        ),
        body:
          short > 0
            ? t('confirm.rooms.receiveShortBody', { count: short })
            : t('confirm.rooms.receiveBody', { store: n.to }),
        confirmLabel: t('confirm.rooms.receiveYes'),
      }))
    )
      return
    try {
      const r = await actions.confirmReceipt.mutateAsync({
        transferId: n.id,
        lines,
        note: note.trim() || undefined,
      })
      setMsg({
        ok: true,
        text: t('roomStores.received', {
          number: r.number,
          received: r.received,
          returned: r.returned,
          lost: r.lost,
        }),
      })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }

  const cancel = async () => {
    setMsg(null)
    if (cancelReason.trim().length < 3)
      return setMsg({ ok: false, text: t('roomStores.errors.cancelWhy') })
    if (
      !(await confirm({
        title: t('confirm.rooms.cancelNoteTitle', { number: n.number, store: n.to }),
        body: t('confirm.rooms.cancelNoteBody', { store: n.from }),
        confirmLabel: t('confirm.rooms.cancelNoteYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await actions.cancelTransfer.mutateAsync({ transferId: n.id, reason: cancelReason.trim() })
      setCancelling(false)
      setMsg({ ok: true, text: t('roomStores.cancelled', { number: n.number }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }

  return (
    <div className={cn(expandedSection, 'border-border flex flex-col gap-3 rounded-md border p-3')}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="min-w-[200px] flex-1">
          <span className="flex items-center gap-2 text-[16px] font-semibold">
            <Truck size={16} aria-hidden="true" className="text-primary flex-none" />
            {t(n.direction === 'to_room' ? 'roomStores.noteOut' : 'roomStores.noteReturn', {
              number: n.number,
            })}
          </span>
          <span className="text-ink-2 block text-[14px]">
            {n.from} → {n.to}
          </span>
          <span className="text-ink-3 block text-[12px]">
            {[
              t('roomStores.sentAtBy', {
                date: `${formatDate(new Date(n.sentAt))} ${formatTime(new Date(n.sentAt))}`,
                name: n.sentBy ?? '—',
              }),
              n.receivedAt
                ? t('roomStores.receivedAtBy', {
                    date: `${formatDate(new Date(n.receivedAt))} ${formatTime(new Date(n.receivedAt))}`,
                    name: n.receivedBy ?? '—',
                  })
                : null,
              n.cancelledAt
                ? t('roomStores.cancelledAtBy', {
                    date: formatDate(new Date(n.cancelledAt)),
                    name: n.cancelledBy ?? '—',
                    reason: n.cancelReason ?? '',
                  })
                : null,
              n.requestNumber ? t('roomStores.forRequest', { number: n.requestNumber }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {n.note && <span className="text-ink-2 block text-[14px]">“{n.note}”</span>}
          {n.receiveNote && (
            <span className="text-ink-2 block text-[14px]">
              {t('roomStores.receiveNoteSaid', { note: n.receiveNote })}
            </span>
          )}
        </span>
        <NoteStatus n={n} />
        <Button
          size="sm"
          variant="tint-grey"
          onClick={() => {
            if (!print(n as TransferNoteDetail))
              setMsg({ ok: false, text: t('roomStores.printBlocked') })
          }}
        >
          <Printer size={14} aria-hidden="true" />
          {t('roomStores.print')}
        </Button>
        {onClose && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="border-border border-b">
              <th className={tableHead}>{t('stock.cols.item')}</th>
              <th className={tableHead}>{t('stock.batchNo')}</th>
              <th className={tableHead}>{t('stock.expiry')}</th>
              <th className={cn(tableHead, 'text-right')}>{t('roomStores.sent')}</th>
              <th className={cn(tableHead, 'text-right')}>{t('roomStores.receivedCol')}</th>
              {showCost && (
                <th className={cn(tableHead, 'hidden text-right sm:table-cell')}>
                  {t('stock.cols.value')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {n.items.map((x) => {
              const d = draftOf(x.lineId, x.quantity)
              const differs = byLine && Number(d.received) !== x.quantity
              return (
                <tr key={x.lineId} className={cn(tableRow, 'h-auto align-top')}>
                  <td className={tableFirstCell}>
                    {x.item}
                    {x.differenceReason && (
                      <span className="text-amber block text-[12px] font-normal">
                        {t(
                          x.differenceAction === 'loss'
                            ? 'roomStores.diffLoss'
                            : 'roomStores.diffReturned',
                          { count: x.quantity - (x.received ?? x.quantity) },
                        )}
                        : {x.differenceReason}
                      </span>
                    )}
                    {differs && (
                      <span className="mt-2 grid grid-cols-1 gap-2 font-normal sm:grid-cols-2">
                        <Field
                          label={t('roomStores.differenceWhy')}
                          value={d.reason}
                          placeholder={t('roomStores.differenceWhyPh')}
                          onChange={(e) =>
                            setDraft(x.lineId, x.quantity, { reason: e.target.value })
                          }
                        />
                        <Select
                          label={t('roomStores.differenceGoes')}
                          value={d.action}
                          onChange={(e) =>
                            setDraft(x.lineId, x.quantity, {
                              action: e.target.value as LineDraft['action'],
                            })
                          }
                        >
                          <option value="returned">{t('roomStores.diffActions.returned')}</option>
                          <option value="loss">{t('roomStores.diffActions.loss')}</option>
                        </Select>
                      </span>
                    )}
                  </td>
                  <td className={cn(tableCell, 'tabular-nums')}>{x.batchNo ?? '—'}</td>
                  <td className={tableCell}>
                    <ExpiryMark date={x.expiry} />
                  </td>
                  <td className={cn(tableCell, 'text-right font-semibold tabular-nums')}>
                    {formatNumber(x.quantity)}
                  </td>
                  <td className={cn(tableCell, 'text-right tabular-nums')}>
                    {byLine && open && n.canReceive ? (
                      <input
                        inputMode="numeric"
                        aria-label={t('roomStores.receivedOf', { item: x.item })}
                        value={d.received}
                        onChange={(e) =>
                          setDraft(x.lineId, x.quantity, {
                            received: e.target.value.replace(/[^\d]/g, ''),
                          })
                        }
                        className={cn(
                          controlClass,
                          'h-9 w-20 px-2 text-right',
                          differs && 'border-amber',
                        )}
                      />
                    ) : x.received == null ? (
                      '—'
                    ) : (
                      <span className={cn(x.received !== x.quantity && 'text-amber font-semibold')}>
                        {formatNumber(x.received)}
                      </span>
                    )}
                  </td>
                  {showCost && (
                    <td className={cn(tableCell, 'hidden text-right tabular-nums sm:table-cell')}>
                      {x.value == null ? '—' : formatRwf(Math.round(x.value))}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {showCost && n.value != null && (
        <p className="text-ink-2 m-0 text-[14px]">
          {t('roomStores.noteValue', { value: formatRwf(Math.round(n.value)) })}
        </p>
      )}

      {open && n.canReceive && (
        <div className="flex flex-col gap-2">
          <p className="text-ink-2 m-0 text-[14px]">
            {t(
              n.direction === 'to_room' ? 'roomStores.receiveLead' : 'roomStores.receiveReturnLead',
            )}
          </p>
          <Field
            label={t('roomStores.receiveNote')}
            value={note}
            placeholder={t('roomStores.receiveNotePh')}
            onChange={(e) => setNote(e.target.value)}
            wrapperClassName="sm:max-w-md"
          />
          <div className="flex flex-wrap gap-2">
            {!byLine ? (
              <>
                <Button
                  variant="success"
                  loading={actions.confirmReceipt.isPending}
                  onClick={() => void receive(true)}
                >
                  <CheckCheck size={16} aria-hidden="true" />
                  {t('roomStores.receiveAll')}
                </Button>
                <Button variant="tint-mint" onClick={() => setByLine(true)}>
                  <ListChecks size={16} aria-hidden="true" />
                  {t('roomStores.receiveByLine')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="success"
                  loading={actions.confirmReceipt.isPending}
                  onClick={() => void receive(false)}
                >
                  <CheckCheck size={16} aria-hidden="true" />
                  {t('roomStores.receiveCounted')}
                </Button>
                <Button variant="tint-grey" onClick={() => setByLine(false)}>
                  {t('staff.form.cancel')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {open && n.canCancel && canAct && (
        <div className="flex flex-col gap-2">
          {cancelling ? (
            <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <Field
                label={t('roomStores.cancelWhy')}
                value={cancelReason}
                placeholder={t('roomStores.cancelWhyPh')}
                onChange={(e) => setCancelReason(e.target.value)}
              />
              <Button
                variant="danger-solid"
                loading={actions.cancelTransfer.isPending}
                onClick={() => void cancel()}
              >
                {!actions.cancelTransfer.isPending && <XCircle size={16} aria-hidden="true" />}
                {t('roomStores.cancelNote')}
              </Button>
              <Button variant="tint-grey" onClick={() => setCancelling(false)}>
                {t('staff.form.cancel')}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="tint-coral"
              className="self-start"
              onClick={() => setCancelling(true)}
            >
              <XCircle size={14} aria-hidden="true" />
              {t('roomStores.cancelNote')}
            </Button>
          )}
        </div>
      )}
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
    </div>
  )
}
