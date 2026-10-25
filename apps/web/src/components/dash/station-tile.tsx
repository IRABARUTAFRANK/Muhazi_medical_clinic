import type { CSSProperties } from 'react'
import { History, Hourglass } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import { cn } from '@/lib/utils'
import { StationGlyph } from './kit'
import { stationLabel } from './kit-style'

/** First in line waiting longer than this turns the tile red. */
const LONG_WAIT_MIN = 30

/*
 * One station in "Queue now": how many wait (joined today), how many are being seen and how long
 * the first patient still in line has been waiting. No average wait here: a correct waiting time
 * needs completed waits over a period, so it lives on the Analytics page (Waiting times).
 * Entries left open from an earlier day are counted apart, to be closed.
 */
export function StationTile({
  i,
  station,
  waiting,
  busy,
  longest,
  forgotten = 0,
}: {
  i: number
  station: string
  waiting: number
  /** Being seen now (left out where unknown). */
  busy?: number
  /** Minutes the first patient still in line has waited; null when nobody waits. */
  longest: number | null
  /** Still open in this queue from an earlier day (0086). */
  forgotten?: number
}) {
  const { t } = useTranslation()
  const hot = waiting > 0 && (longest ?? 0) > LONG_WAIT_MIN
  return (
    <div
      className={cn(
        'anim-enter flex flex-col gap-0.5 rounded-xl border px-3 py-2.5',
        hot ? 'border-red-dot/30 bg-red-bg/40' : 'border-border',
      )}
      style={{ '--i': i } as CSSProperties}
    >
      <span className="flex items-center justify-between">
        <span className="text-xl font-extrabold tabular-nums">{waiting}</span>
        <StationGlyph station={station} className={hot ? 'text-red' : 'text-primary'} />
      </span>
      <span className="text-ink-2 text-[13px] font-semibold">{stationLabel(station, t)}</span>
      {busy !== undefined && (
        <span className="text-ink-3 text-[12px]">{t('desk.busyShort', { count: busy })}</span>
      )}
      {waiting > 0 && longest !== null && (
        <span className={cn('text-[12px]', hot ? 'text-red font-semibold' : 'text-ink-2')}>
          <Hourglass size={11} aria-hidden="true" className="mr-0.5 inline align-[-1px]" />
          {t('dashboard.longestShort', { time: formatDuration(longest, t) })}
        </span>
      )}
      {forgotten > 0 && (
        <span className="text-yellow text-[12px] font-semibold [overflow-wrap:anywhere]">
          <History size={11} aria-hidden="true" className="mr-0.5 inline align-[-1px]" />
          {t('dashboard.forgottenShort', { count: forgotten })}
        </span>
      )}
    </div>
  )
}
