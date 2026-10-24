import { Link } from '@tanstack/react-router'
import { ArrowRightLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Panel } from '@/components/dash/kit'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { useRefillRequests, useTransferNotes } from '@/lib/api/rooms'
import { cn } from '@/lib/utils'

/**
 * What the room stores wait for from the pharmacy, at a glance: open refill requests, return
 * notes to confirm and transfer notes still on the way. The work itself (sending, confirming,
 * printing the note) is done in one place: Stock → Room stores.
 */
export function RoomStoresSummary() {
  const { t } = useTranslation()
  const { data: requests = [] } = useRefillRequests('open')
  const { data: onTheWay = [] } = useTransferNotes({ status: 'in_transit' })
  const returns = onTheWay.filter((n) => n.direction === 'to_pharmacy').length
  const sent = onTheWay.filter((n) => n.direction === 'to_room').length
  const nothing = requests.length === 0 && returns === 0 && sent === 0

  const tiles: { key: string; count: number; label: string; tone: 'orange' | 'blue' }[] = [
    {
      key: 'requests',
      count: requests.length,
      label: t('deskRooms.requests', { count: requests.length }),
      tone: 'orange',
    },
    {
      key: 'returns',
      count: returns,
      label: t('deskRooms.returns', { count: returns }),
      tone: 'orange',
    },
    {
      key: 'sent',
      count: sent,
      label: t('deskRooms.onTheWay', { count: sent }),
      tone: 'blue',
    },
  ]

  return (
    <Panel
      i={3}
      icon={ArrowRightLeft}
      tint="navy"
      title={t('deskRooms.title')}
      right={
        <Link
          to="/app/stock"
          search={{ tab: 'rooms' }}
          className={cn(buttonVariants({ size: 'sm' }))}
        >
          {t('deskRooms.open')}
        </Link>
      }
    >
      {nothing ? (
        <p className="text-ink-2 m-0 text-[13px]">{t('deskRooms.nothing')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {tiles
            .filter((x) => x.count > 0)
            .map((x) => (
              <li key={x.key}>
                <Badge tone={x.tone}>{x.label}</Badge>
              </li>
            ))}
        </ul>
      )}
    </Panel>
  )
}
