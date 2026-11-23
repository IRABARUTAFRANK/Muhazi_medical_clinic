import { ClipboardList } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Empty, Panel } from '@/components/dash/kit'
import { ShownList } from '@/components/ui/list-tools'
import { useDeskOrders } from '@/lib/api/lab'
import type { Station } from '@/lib/api/visits'
import { useNow } from '@/lib/hooks'
import { visitBlocks } from '@/lib/visit-blocks'
import { LabVisitBlock } from '../lab/lab-visit-block'

/**
 * Orders sent to a desk that is not the laboratory (Nursing, Dental, Minor surgery,
 * Consultation…): the desk sees what waits for it, starts it, writes the result or says it
 * could not be done. With `hideEmpty`, nothing shows while no order waits.
 */
export function DeskOrdersPanel({
  station,
  title,
  empty,
  hideEmpty = false,
}: {
  station: Station
  title: string
  empty?: string
  hideEmpty?: boolean
}) {
  const { t } = useTranslation()
  const now = useNow()
  const { data: orders = [] } = useDeskOrders(station)
  if (hideEmpty && orders.length === 0) return null
  return (
    <Panel
      i={2}
      icon={ClipboardList}
      tint="violet"
      title={title}
      right={t('lab.openCount', { count: orders.length })}
    >
      {orders.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        // several orders for one patient's visit stand together, the patient named once
        <ShownList items={visitBlocks(orders)} step={5}>
          {(shown) => (
            <div className="flex flex-col">
              {shown.map((b, i) => (
                <LabVisitBlock key={b.key} block={b} i={i} now={now} desk />
              ))}
            </div>
          )}
        </ShownList>
      )}
    </Panel>
  )
}
