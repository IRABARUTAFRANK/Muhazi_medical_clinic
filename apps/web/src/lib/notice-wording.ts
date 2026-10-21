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
          body:
            [
              p.triage ? t('notify.triage', { colour: t(`home.triage.${p.triage}`) }) : null,
              String(p.vitals) === 'false' ? t('notify.noVitals') : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
        }
      case 'no_vitals':
        // Sent to the nurses; removed as soon as anyone records the vitals.
        return {
          title: t('notify.noVitalsTitle', { ticket: p.ticket ?? '', name: p.name ?? '' }),
          body: t('notify.noVitalsBody', {
            station: t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' }),
          }),
        }
      case 'queue_pool': {
        // One notice for a patient sent to several desks; the first one free takes them.
        const desks = (n.params?.stations as unknown as string[] | null) ?? []
        return {
          title: t('notify.queuePool', { ticket: p.ticket ?? '', name: p.name ?? '' }),
          body: desks.map((d) => t(`register.stations.${d}`, { defaultValue: d })).join(', '),
        }
      }
      case 'call_next':
        // A colleague finished with a patient and asks for the next one.
        return {
          title: t('notify.callNext', {
            by: p.by ?? '',
            station: t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' }),
          }),
          body: p.note ? `“${p.note}”` : null,
        }
      case 'help':
        return {
          title: t('notify.help', { by: p.by ?? '', name: p.name ?? '' }),
          body: p.note ? `“${p.note}”` : null,
        }
      case 'help_answer':
        return {
          title: t(
            (p.accepted as unknown) === true ? 'notify.helpAccepted' : 'notify.helpDeclined',
            { by: p.by ?? '', name: p.name ?? '' },
          ),
          body: null,
        }
      case 'referral': {
        // A colleague handed the patient over: who, why, and whether they want the patient back.
        const desk = t(`register.stations.${p.station}`, { defaultValue: p.station ?? '' })
        return {
          title: t('notify.referral', {
            ticket: p.ticket ?? '',
            name: p.name ?? '',
            by: p.by ?? '',
            desk,
          }),
          body:
            [
              p.note ? `“${p.note}”` : null,
              (p.back as unknown) === true ? t('notify.referralBack') : null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
        }
      }
      case 'result':
        return {
          title: t('notify.result', { test: p.test ?? '', name: p.name ?? '' }),
          body: p.impression ?? null,
        }
      case 'cover':
        return {
          title: t('notify.cover', {
            doctor: p.doctor ?? '',
            until: p.until ? formatTime(new Date(p.until)) : '',
          }),
          body: p.note ?? null,
        }
      case 'task':
        return {
          title: t('notify.task', { title: p.title ?? '' }),
          body: [p.name, p.due ? t('notify.due', { time: formatTime(new Date(p.due)) }) : null]
            .filter(Boolean)
            .join(' · '),
        }
      case 'task_done':
        return {
          title: t('notify.taskDone', { by: p.by ?? '', title: p.title ?? '' }),
          body: p.name ?? null,
        }
      case 'inquiry':
        return { title: t('notify.inquiry', { name: p.name ?? '' }), body: t('notify.inquiryBody') }
      case 'to_accept':
        return {
          title: t('notify.toAccept', { name: p.name ?? '' }),
          body: t('notify.toAcceptBody'),
        }
      case 'appt_confirmed':
        return {
          title: t('notify.apptConfirmed', { name: p.name ?? '', doctor: p.doctor ?? '' }),
          body: p.when
            ? t('notify.apptWhen', {
                when: `${formatDate(new Date(p.when))} ${formatTime(new Date(p.when))}`,
              })
            : null,
        }
      case 'appt_declined':
        return {
          title: t('notify.apptDeclined', { name: p.name ?? '', doctor: p.doctor ?? '' }),
          body: [
            p.when
              ? t('notify.apptWhen', {
                  when: `${formatDate(new Date(p.when))} ${formatTime(new Date(p.when))}`,
                })
              : null,
            p.reason ? t('notify.apptReason', { reason: p.reason }) : null,
            t('notify.apptRebook'),
          ]
            .filter(Boolean)
            .join(' · '),
        }
      default:
        return { title: n.title ?? '', body: n.body }
    }
  }
}
