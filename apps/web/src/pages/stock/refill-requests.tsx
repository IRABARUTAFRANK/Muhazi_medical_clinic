import { createElement, useState } from 'react'
import {
  Ban,
  CheckCheck,
  ClipboardList,
  Hourglass,
  Send,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatTime } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { card, selectedRow } from '@/components/dash/kit-style'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { Pager } from '@/components/ui/list-tools'
import {
  useRefillRequests,
  useRoomStoreActions,
  type RefillRequest,
  type RefillStatus,
} from '@/lib/api/rooms'
import { useConfirm } from '@/lib/confirm'
import { usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'
import { MsgFlash } from './stock-shared'
import { errText, packsText, type Msg } from './stock-util'

const TONE: Record<RefillStatus, 'yellow' | 'green' | 'red' | 'grey'> = {
  open: 'yellow',
  fulfilled: 'green',
  declined: 'red',
  cancelled: 'grey',
}
/** Colour is never the only signal: each state has its symbol. */
const STATUS_ICON: Record<RefillStatus, LucideIcon> = {
  open: Hourglass,
  fulfilled: CheckCheck,
  declined: XCircle,
  cancelled: Ban,
}

/**
 * Refill requests (RQ-…): the pharmacy sees every store's and prepares the transfer note from
 * one ("Prepare the note") or declines it with a reason; a holder sees their store's and may
 * withdraw their own while it is open.
 */
export function RefillRequestsList({
  locationId = null,
  pharmacy,
  canAct = true,
  focusId,
  onPrepare,
  i = 2,
}: {
  locationId?: string | null
  /** The pharmacy or the manager: prepare a note from a request, decline it. */
  pharmacy: boolean
  /** false: "Manage stock" is switched off for the reader; the list stays, the buttons go. */
  canAct?: boolean
  focusId?: string | null
  onPrepare?: (r: RefillRequest) => void
  i?: number
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<RefillStatus | 'all'>('open')
  const { data: list = [], isLoading } = useRefillRequests(
    status === 'all' ? null : status,
    locationId,
  )
  const actions = useRoomStoreActions()
  const confirm = useConfirm()
  const [msg, setMsg] = useState<Msg | null>(null)
  const [declining, setDeclining] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  // the request a notification points to comes first
  const sorted = focusId
    ? [...list].sort((a, b) => Number(b.id === focusId) - Number(a.id === focusId))
    : list
  const paged = usePaged(sorted, 8, `${status}|${locationId}`)

  const decline = async (r: RefillRequest) => {
    setMsg(null)
    if (reason.trim().length < 3)
      return setMsg({ ok: false, text: t('roomStores.errors.declineWhy') })
    if (
      !(await confirm({
        title: t('confirm.rooms.declineTitle', { number: r.number, store: r.store }),
        body: t('confirm.rooms.declineBody', { reason: reason.trim() }),
        confirmLabel: t('confirm.rooms.declineYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await actions.declineRefill.mutateAsync({ requestId: r.id, reason: reason.trim() })
      setDeclining(null)
      setMsg({ ok: true, text: t('roomStores.declined', { number: r.number }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }
  const withdraw = async (r: RefillRequest) => {
    setMsg(null)
    if (
      !(await confirm({
        title: t('confirm.rooms.withdrawTitle', { number: r.number }),
        body: t('confirm.rooms.withdrawBody'),
        confirmLabel: t('confirm.rooms.withdrawYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      await actions.cancelRefill.mutateAsync(r.id)
      setMsg({ ok: true, text: t('roomStores.withdrawn', { number: r.number }) })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    }
  }

  return (
    <Panel
      i={i}
      icon={ClipboardList}
      tint="amber"
      title={t(pharmacy ? 'roomStores.requestsTitle' : 'myStore.requestsTitle')}
      right={String(list.length)}
    >
      <Select
        label={t('roomStores.requestFilter')}
        value={status}
        onChange={(e) => setStatus(e.target.value as RefillStatus | 'all')}
        wrapperClassName="sm:max-w-xs"
      >
        {(['open', 'fulfilled', 'declined', 'cancelled', 'all'] as const).map((s) => (
          <option key={s} value={s}>
            {s === 'all' ? t('roomStores.allRequests') : t(`roomStores.requestStatus.${s}`)}
          </option>
        ))}
      </Select>
      {isLoading ? null : paged.total === 0 ? (
        <Empty icon={ClipboardList}>{t('roomStores.noRequests')}</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {paged.slice.map((r) => (
            <div
              key={r.id}
              className={cn(
                card,
                'gap-2 p-3',
                r.id === focusId && cn('border-primary', selectedRow),
              )}
            >
              <div className="flex flex-wrap items-start gap-2">
                <span className="min-w-[min(200px,100%)] flex-1">
                  <span className="block font-semibold">
                    {r.number} · {r.store}
                  </span>
                  <span className="text-ink-3 block text-[12px]">
                    {[
                      `${formatDate(new Date(r.at))} ${formatTime(new Date(r.at))}`,
                      r.by,
                      r.transferNumber
                        ? t('roomStores.sentAsNote', { number: r.transferNumber })
                        : null,
                      r.declineReason
                        ? t('roomStores.declinedBecause', { reason: r.declineReason })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {r.note && <span className="text-ink-2 block text-[14px]">“{r.note}”</span>}
                </span>
                <Badge
                  tone={TONE[r.status]}
                  icon={createElement(STATUS_ICON[r.status], { size: 12, 'aria-hidden': true })}
                >
                  {t(`roomStores.requestStatus.${r.status}`)}
                </Badge>
              </div>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[14px]">
                {r.lines.map((l) => (
                  <li key={l.itemId} className="flex flex-wrap gap-x-3">
                    <span className="min-w-[160px] flex-1 font-semibold">
                      {l.item} × {formatNumber(l.quantity)}
                      {l.unit ? ` ${l.unit}` : ''}
                      {/* asked in packs (0107): the packs beside the pieces */}
                      {packsText(t, l.quantity, l.packSize, l.packUnit) && (
                        <span className="text-ink-3 font-normal">
                          {' '}
                          ({packsText(t, l.quantity, l.packSize, l.packUnit)})
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        'text-[12px] tabular-nums',
                        pharmacy && l.inPharmacy < l.quantity
                          ? 'text-red font-semibold'
                          : 'text-ink-3',
                      )}
                    >
                      {[
                        pharmacy ? t('roomStores.inPharmacy', { count: l.inPharmacy }) : null,
                        t('roomStores.inStore', { count: l.inStore }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
              {r.status === 'open' && (
                <div className="flex flex-wrap gap-2">
                  {pharmacy && canAct && onPrepare && (
                    <Button size="sm" variant="primary" onClick={() => onPrepare(r)}>
                      <Send size={14} aria-hidden="true" />
                      {t('roomStores.prepareNote')}
                    </Button>
                  )}
                  {pharmacy && canAct && declining !== r.id && (
                    <Button
                      size="sm"
                      variant="tint-coral"
                      onClick={() => {
                        setDeclining(r.id)
                        setReason('')
                      }}
                    >
                      <XCircle size={14} aria-hidden="true" />
                      {t('roomStores.decline')}
                    </Button>
                  )}
                  {!pharmacy && r.mine && (
                    <Button
                      size="sm"
                      variant="tint-coral"
                      loading={actions.cancelRefill.isPending}
                      onClick={() => void withdraw(r)}
                    >
                      <XCircle size={14} aria-hidden="true" />
                      {t('roomStores.withdraw')}
                    </Button>
                  )}
                </div>
              )}
              {declining === r.id && (
                <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <Field
                    label={t('roomStores.declineWhy')}
                    value={reason}
                    placeholder={t('roomStores.declineWhyPh')}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    variant="danger-solid"
                    loading={actions.declineRefill.isPending}
                    onClick={() => void decline(r)}
                  >
                    {!actions.declineRefill.isPending && <XCircle size={16} aria-hidden="true" />}
                    {t('roomStores.decline')}
                  </Button>
                  <Button variant="tint-grey" onClick={() => setDeclining(null)}>
                    {t('staff.form.cancel')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Pager {...paged} onPage={paged.setPage} />
      <MsgFlash msg={msg} onClose={() => setMsg(null)} />
    </Panel>
  )
}
