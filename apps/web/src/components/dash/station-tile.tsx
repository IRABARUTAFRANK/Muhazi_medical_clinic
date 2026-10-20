import type { CSSProperties } from 'react'
import { Hourglass, Timer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '@/lib/duration'
import { cn } from '@/lib/utils'
import { StationGlyph } from './kit'
import { stationLabel } from './kit-style'

/** First in line waiting longer than this turns the tile red. */
const LONG_WAIT_MIN = 30

/*
 * One station in "Queue now": how many wait, how many are being seen, the average wait today
 * (from joining the queue until a staff member took the patient, over those already taken)
 * and how long the first patient still in line has been waiting.
 */
export function StationTile({
  i,
  station,
  waiting,
  busy,
  minutes,
  longest,
}: {
  i: number
  station: string
  waiting: number
  /** Being seen now (left out where unknown). */
  busy?: number
  /** Average wait today; null while nobody has been taken yet. */
  minutes: number | null
  /** Minutes the first patient still in line has waited; null when nobody waits. */
  longest: number | null
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
      <span className="text-ink-3 text-[12px]">
        <Timer size={11} aria-hidden="true" className="mr-0.5 inline align-[-1px]" />
        {minutes === null
          ? t('dashboard.noneTaken')
          : t('dashboard.avgShort', { time: formatDuration(minutes, t) })}
      </span>
      {waiting > 0 && longest !== null && (
        <span className={cn('text-[12px]', hot ? 'text-red font-semibold' : 'text-ink-2')}>
          <Hourglass size={11} aria-hidden="true" className="mr-0.5 inline align-[-1px]" />
          {t('dashboard.longestShort', { time: formatDuration(longest, t) })}
        </span>
      )}
    </div>
  )
}
