import { useState, type FormEvent } from 'react'
import { PackagePlus, Save, ShoppingCart, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber, formatRwf } from '@mmc/shared'
import { Empty, Panel } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { SearchSelect } from '@/components/ui/search-select'
import { useReorderSuggestions, useStockActions, type StockItem } from '@/lib/api/stock'
import { useConfirm } from '@/lib/confirm'
import { MsgFlash } from './stock-shared'
import { errText, itemName, packsText, type Msg } from './stock-util'

/**
 * The low-stock level ("show as low at") and the level to order up to, for one medicine. Used
 * on the "To order" tab and from the stock table.
 */
export function LevelEditor({
  item,
  onDone,
}: {
  item: Pick<StockItem, 'id' | 'name' | 'strength' | 'reorderLevel' | 'maxLevel'>
  onDone?: () => void
}) {
  const { t } = useTranslation()
  const actions = useStockActions()
  const confirm = useConfirm()
  const [level, setLevel] = useState(String(item.reorderLevel ?? 0))
  const [max, setMax] = useState(item.maxLevel ? String(item.maxLevel) : '')
  const [msg, setMsg] = useState<Msg | null>(null)
  const name = itemName(item)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    const lv = Number(level)
    const mx = max.trim() === '' ? 0 : Number(max)
    if (level === '' || !Number.isInteger(lv) || lv < 0)
      return setMsg({ ok: false, text: t('stock.reorderBad') })
    if (!Number.isInteger(mx) || mx < 0) return setMsg({ ok: false, text: t('stock.reorderBad') })
    if (mx > 0 && mx <= lv) return setMsg({ ok: false, text: t('stockReorder.errors.maxAbove') })
    if (
      !(await confirm({
        title: t('confirm.stock.levelTitle', { item: name, level: lv }),
        body: mx > 0 ? t('stockReorder.levelBodyMax', { max: mx }) : t('confirm.stock.levelBody'),
        confirmLabel: t('confirm.stock.saveYes'),
      }))
    )
      return
    try {
      await actions.setReorderLevel.mutateAsync({ itemId: item.id, level: lv, maxLevel: mx })
      setMsg({ ok: true, text: t('stockReorder.levelSaved', { item: name }) })
      onDone?.()
    } catch (err) {
      setMsg({ ok: false, text: errText(err) })
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[120px_120px_auto]"
    >
      <Field
        label={t('stockReorder.level')}
        inputMode="numeric"
        value={level}
        onChange={(e) => setLevel(e.target.value.replace(/[^\d]/g, ''))}
      />
      <Field
        label={t('stockReorder.max')}
        inputMode="numeric"
        value={max}
        placeholder="—"
        onChange={(e) => setMax(e.target.value.replace(/[^\d]/g, ''))}
      />
      <Button
        type="submit"
        variant="primary"
        className="col-span-2 sm:col-span-1"
        loading={actions.setReorderLevel.isPending}
      >
        {!actions.setReorderLevel.isPending && <Save size={16} aria-hidden="true" />}
        {t('prices.form.save')}
      </Button>
      <div className="col-span-2 sm:col-span-3">
        <MsgFlash msg={msg} onClose={() => setMsg(null)} />
      </div>
    </form>
  )
}

/**
 * What to order: the medicines at or below their low-stock level in the pharmacy (unexpired
 * units), with the quantity to order up to the maximum, what the room stores hold, the average
 * use per month (90 days), the last supplier and price, and the estimated cost.
 */
export function ReorderTab({
  items,
  onReceive,
  canSetLevel,
}: {
  items: StockItem[]
  onReceive: (itemId: string) => void
  /** The levels are changed with "Manage stock" (the same right as the On-hand table). */
  canSetLevel: boolean
}) {
  const { t } = useTranslation()
  const { data: list = [], isLoading, error } = useReorderSuggestions(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [levelItem, setLevelItem] = useState('')
  const total = list.reduce((s, x) => s + x.estimatedCost, 0)
  const chosen = items.find((i) => i.id === levelItem)
  return (
    <div className="flex flex-col gap-4">
      <Panel
        i={1}
        icon={ShoppingCart}
        tint="amber"
        title={t('stockReorder.title')}
        right={
          list.length
            ? t('stockReorder.right', { count: list.length, value: formatRwf(Math.round(total)) })
            : null
        }
      >
        <p className="text-ink-2 m-0 text-[14px]">{t('stockReorder.lead')}</p>
        {error && <p className="text-red m-0 text-[14px]">{error.message}</p>}
        {isLoading ? null : list.length === 0 ? (
          <Empty icon={ShoppingCart}>{t('stockReorder.none')}</Empty>
        ) : (
          <div className="flex flex-col">
            {list.map((x) => {
              const it = items.find((i) => i.id === x.itemId)
              return (
                <div
                  key={x.itemId}
                  className="border-grid flex flex-col gap-2 border-b py-2.5 last:border-b-0"
                >
                  <div className="flex flex-wrap items-start gap-3 text-[14px]">
                    <span className="min-w-[min(200px,100%)] flex-1">
                      <span className="block font-semibold">{x.item}</span>
                      <span className="text-ink-3 block text-[12px]">
                        {[
                          x.code,
                          t('stockReorder.levels', {
                            level: x.level,
                            max: x.maxLevel ?? '—',
                          }),
                          x.inRooms > 0 ? t('stockReorder.inRooms', { count: x.inRooms }) : null,
                          t('stockReorder.monthly', { count: Math.round(x.monthlyUse) }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <span className="text-ink-3 block text-[12px]">
                        {x.lastSupplier
                          ? t('stockReorder.last', {
                              supplier: x.lastSupplier,
                              cost: x.lastCost == null ? '—' : formatRwf(x.lastCost),
                              date: x.lastReceivedAt ? formatDate(new Date(x.lastReceivedAt)) : '—',
                            })
                          : t('stockReorder.neverReceived')}
                      </span>
                    </span>
                    <span className="text-right tabular-nums">
                      <span className="text-red block font-semibold">
                        {[
                          t('stockReorder.onHand', { count: x.onHand }),
                          packsText(
                            t,
                            x.onHand,
                            x.packSize,
                            items.find((i) => i.id === x.itemId)?.packUnit,
                          ),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <span className="block text-[14px] font-semibold">
                        {x.suggestedBoxes != null && x.packSize
                          ? t('stockReorder.orderBoxes', {
                              count: x.suggestedBoxes,
                              size: x.packSize,
                              units: formatNumber(x.suggested),
                            })
                          : t('stockReorder.orderUnits', { count: x.suggested })}
                      </span>
                      {x.estimatedCost > 0 && (
                        <span className="text-ink-3 block text-[12px]">
                          {t('stockReorder.estimate', {
                            value: formatRwf(Math.round(x.estimatedCost)),
                          })}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="success" onClick={() => onReceive(x.itemId)}>
                      <PackagePlus size={14} aria-hidden="true" />
                      {t('stockReorder.receive')}
                    </Button>
                    {canSetLevel && (
                      <Button
                        size="sm"
                        onClick={() => setEditing(editing === x.itemId ? null : x.itemId)}
                      >
                        <SlidersHorizontal size={14} aria-hidden="true" />
                        {t('stockReorder.setLevels')}
                      </Button>
                    )}
                  </div>
                  {canSetLevel && editing === x.itemId && (
                    <LevelEditor
                      item={
                        it ?? {
                          id: x.itemId,
                          name: x.item,
                          strength: null,
                          reorderLevel: x.level,
                          maxLevel: x.maxLevel,
                        }
                      }
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Panel>
      {canSetLevel && (
        <Panel i={2} icon={SlidersHorizontal} tint="navy" title={t('stockReorder.anyTitle')}>
          <p className="text-ink-2 m-0 text-[14px]">{t('stockReorder.anyLead')}</p>
          <SearchSelect
            label={t('stock.cols.item')}
            value={levelItem}
            onChange={setLevelItem}
            emptyLabel={t('visit.add.pickItem')}
            wrapperClassName="sm:max-w-xl"
            options={items
              .filter((i) => i.active)
              .map((i) => ({
                value: i.id,
                label: `${itemName(i)} · ${
                  i.reorderLevel > 0
                    ? t('stock.reorderAt', { count: i.reorderLevel })
                    : t('stock.reorderNone')
                }`,
              }))}
          />
          {chosen && <LevelEditor key={chosen.id} item={chosen} />}
        </Panel>
      )}
    </div>
  )
}
