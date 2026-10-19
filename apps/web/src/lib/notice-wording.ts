import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import type { Notice } from '@/lib/api/notifications'

/** "5 min ago", "2 h ago", or the date for older ones. */
export function useAgo() {
  const { t } = useTranslation()
  return (iso: string) => {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
    if (min < 1) return t('notify.justNow')
    if (min < 60) return t('notify.minAgo', { count: min })
    if (min < 24 * 60) return t('notify.hAgo', { count: Math.round(min / 60) })
    return `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
  }
}

/** The notice in the reader's language (automatic kinds) or as written (messages). */
export function useWording() {
  const { t } = useTranslation()
  return (n: Notice): { title: string; body: string | null } => {
    const p = n.params ?? {}
    switch (n.kind) {
      case 'queue':
        return {
          title: t(n.urgent ? 'notify.queueUrgent' : 'notify.queue', {
            ticket: p.ticket ?? '',
            name: p.name ?? '',
            station: t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' }),
          }),
          body: p.triage ? t('notify.triage', { colour: t(`home.triage.${p.triage}`) }) : null,
        }
      case 'task':
        return {
          title: t('notify.task', { title: p.title ?? '' }),
          body: [p.name, p.due ? t('notify.due', { time: formatTime(new Date(p.due)) }) : null]
            .filter(Boolean)
            .join(' · '),
        }
      case 'inquiry':
        return { title: t('notify.inquiry', { name: p.name ?? '' }), body: t('notify.inquiryBody') }
      case 'to_accept':
        return {
          title: t('notify.toAccept', { name: p.name ?? '' }),
          body: t('notify.toAcceptBody'),
        }
      default:
        return { title: n.title ?? '', body: n.body }
    }
  }
}
