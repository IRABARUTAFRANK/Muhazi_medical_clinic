import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime, type SyncState } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'

/** Synced / Syncing… / Offline since hh:mm · n pending. Never colour alone. */
export function SyncBadge({ state }: { state: SyncState }) {
  const { t } = useTranslation()
  switch (state.status) {
    case 'synced':
      return (
        <Badge tone="green" icon={<Check size={12} strokeWidth={3} aria-hidden="true" />}>
          {t('sync.synced')}
        </Badge>
      )
    case 'syncing':
      return <Badge tone="blue">{t('sync.syncing')}</Badge>
    case 'offline':
      return (
        <Badge tone="orange" className="tabular-nums">
          {t('sync.offline', { time: formatTime(state.since), count: state.pending })}
        </Badge>
      )
  }
}
