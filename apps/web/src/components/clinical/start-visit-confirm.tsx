import { useEffect, useRef } from 'react'
import { CalendarCheck, FilePlus2, History, Receipt, Siren, Ticket } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/*
 * Asked before anything that starts a visit (Register page, patient file, a booked patient's
 * arrival): who, what happens (a ticket and a queue at which desk, a new bill, and for a new
 * patient a new file), when they last came — then "Yes" or "No, go back". Escape goes back.
 */
export function StartVisitConfirm({
  mode = 'visit',
  name,
  fileNumber,
  desk,
  emergency = false,
  lastVisit,
  busy = false,
  onConfirm,
  onCancel,
  className,
}: {
  /** visit: a returning patient; register: a new file and its visit; arrival: a booked patient. */
  mode?: 'visit' | 'register' | 'arrival'
  name: string
  fileNumber?: string | null
  /** The desk whose queue the patient joins (station key). */
  desk: string
  emergency?: boolean
  /** When the patient last came; null = never; undefined = not known here. */
  lastVisit?: { at: string; count: number } | null
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const yes = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    yes.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const deskName = t(`register.stations.${desk}`, { defaultValue: desk })
  const title =
    mode === 'register'
      ? t('visitConfirm.titleRegister', { name })
      : mode === 'arrival'
        ? t('visitConfirm.titleArrival', { name })
        : t(emergency ? 'visitConfirm.titleEmergency' : 'visitConfirm.title', { name })
  const points: { icon: typeof Ticket; text: string; strong?: boolean }[] = [
    ...(mode === 'register' ? [{ icon: FilePlus2, text: t('visitConfirm.newFile') }] : []),
    ...(mode === 'arrival' ? [{ icon: CalendarCheck, text: t('visitConfirm.arrived') }] : []),
    emergency
      ? { icon: Siren, text: t('visitConfirm.queueEmergency', { desk: deskName }), strong: true }
      : { icon: Ticket, text: t('visitConfirm.queue', { desk: deskName }) },
    { icon: Receipt, text: t('visitConfirm.bill') },
    ...(lastVisit === undefined || mode === 'register'
      ? []
      : [
          {
            icon: History,
            text: lastVisit
              ? t('visitConfirm.last', {
                  date: formatDate(new Date(lastVisit.at)),
                  count: lastVisit.count,
                })
              : t('visitConfirm.first'),
          },
        ]),
  ]
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className={cn(
        'anim-enter flex flex-col gap-3 rounded-md border p-3.5',
        emergency ? 'border-red/40 bg-red-bg/60' : 'border-primary/40 bg-primary-tint/50',
        className,
      )}
    >
      <p className="m-0 text-[16px] leading-snug font-semibold">
        {title}
        {fileNumber && (
          <span className="text-ink-3 ml-2 text-[13px] font-semibold tabular-nums">
            {fileNumber}
          </span>
        )}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {points.map((p) => (
          <li
            key={p.text}
            className={cn(
              'flex items-start gap-2 text-[13px]',
              p.strong ? 'text-red font-semibold' : 'text-ink-2',
            )}
          >
            <p.icon size={15} aria-hidden="true" className="mt-0.5 flex-none" />
            {p.text}
          </li>
        ))}
      </ul>
      <span className="flex flex-wrap gap-2">
        <Button
          ref={yes}
          type="button"
          variant={emergency ? 'danger' : 'primary'}
          loading={busy}
          onClick={onConfirm}
        >
          <Ticket size={16} aria-hidden="true" />
          {t(
            mode === 'register'
              ? 'visitConfirm.yesRegister'
              : mode === 'arrival'
                ? 'visitConfirm.yesArrival'
                : 'visitConfirm.yes',
          )}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('visitConfirm.no')}
        </Button>
      </span>
    </div>
  )
}
