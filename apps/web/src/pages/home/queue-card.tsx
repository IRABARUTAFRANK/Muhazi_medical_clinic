import { useTranslation } from 'react-i18next'
import type { QueueCounts, QueueRow, Triage } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { StaffLink } from '@/components/staff/staff-link'
import { cn } from '@/lib/utils'

const triageTone: Record<Triage, 'red' | 'yellow' | 'green'> = {
  red: 'red',
  yellow: 'yellow',
  green: 'green',
}

interface QueueCardProps {
  title: string
  rows: QueueRow[]
  counts: QueueCounts
  rowAction: 'open' | 'call'
  empty: boolean
  className?: string
}

/**
 * Compact row (tablet, and PC cards narrower than 576 px): insurer chip under the name.
 * Wide row (PC cards ≥ 576 px, e.g. 1920 screens): insurer in its own column.
 */
const rowGrid =
  'grid grid-cols-[52px_minmax(0,1fr)_58px_84px_56px_68px] items-center gap-2 px-3 py-2 pc:@xl:grid-cols-[56px_minmax(0,1fr)_60px_92px_64px_80px_84px]'
const wideOnly = 'hidden pc:@xl:inline-flex'
const compactOnly = 'pc:@xl:hidden'

/** "My queue" ordered by triage colour, then appointment time, then ticket. */
export function QueueCard({ title, rows, counts, rowAction, empty, className }: QueueCardProps) {
  const { t } = useTranslation()
  return (
    <Card aria-label={title} className={cn('@container overflow-hidden', className)}>
      <CardHeader className="flex-wrap">
        <span>{title}</span>
        <span className="flex gap-1.5 tabular-nums">
          <Badge tone="grey" dot={false}>
            {t('home.waiting', { count: counts.waiting })}
          </Badge>
          <Badge tone="blue">{t('home.inProgress', { count: counts.inProgress })}</Badge>
          <Badge tone="green">{t('home.done', { count: counts.done })}</Badge>
        </span>
      </CardHeader>
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <svg
            width="64"
            height="64"
            viewBox="0 0 64 64"
            fill="none"
            stroke="var(--mmc-primary)"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="10" y="14" width="44" height="40" rx="6" />
            <path d="M10 26h44M22 10v8M42 10v8" />
            <path d="m25 42 5 5 9-10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="text-base font-semibold">{t('home.emptyQueueTitle')}</div>
          <div className="text-ink-2 max-w-[260px]">{t('home.emptyQueueBody')}</div>
          <StaffLink
            to="/app/register"
            className={cn(buttonVariants({ variant: 'default' }), 'mt-2')}
          >
            {t('home.walkIn')}
          </StaffLink>
        </div>
      ) : (
        <>
          <div
            className={cn(
              rowGrid,
              'text-ink-3 pc:grid hidden min-h-8 py-1 text-xs font-semibold tracking-[.02em] uppercase [&>span]:truncate',
            )}
          >
            <span>{t('home.cols.ticket')}</span>
            <span>{t('home.cols.patient')}</span>
            <span>{t('home.cols.ageSex')}</span>
            <span>{t('home.cols.triage')}</span>
            <span>{t('home.cols.waiting')}</span>
            <span className={cn(wideOnly, 'pc:@xl:inline')}>{t('home.cols.insurer')}</span>
            <span />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {rows.map((q) => (
              <div
                key={q.ticket}
                className={cn(
                  rowGrid,
                  'border-border pc:@xl:min-h-14 min-h-[60px] border-b last:border-b-0',
                )}
              >
                <span className="text-primary font-bold tabular-nums">{q.ticket}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{q.name}</span>
                  <Chip className={cn('max-w-full truncate', compactOnly)}>{q.insurer}</Chip>
                </span>
                <span className="text-ink-2 tabular-nums">{q.ageSex}</span>
                <Badge tone={triageTone[q.triage]}>{t(`home.triage.${q.triage}`)}</Badge>
                <span className="text-ink-2 tabular-nums">
                  {q.waitMin} {t('common.min')}
                </span>
                <Chip className={cn('max-w-full truncate', wideOnly)}>{q.insurer}</Chip>
                <StaffLink
                  to="/app/queue"
                  className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'min-w-0 px-2')}
                >
                  {t(rowAction === 'open' ? 'common.open' : 'common.call')}
                </StaffLink>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
