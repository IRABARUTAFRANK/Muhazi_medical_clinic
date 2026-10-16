import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { weekAvailability, type Practitioner } from '@mmc/shared'
import { Avatar } from '@/components/ui/avatar'
import { buttonVariants } from '@/components/ui/button'
import { useDayNames } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/** Free slots ≥ this count show green; fewer show yellow. */
const FEW_THRESHOLD = 4

export function DoctorPreviewCard({
  doctor,
  now,
  booked,
  className,
}: {
  doctor: Practitioner
  now: Date
  /** Live booked slots; undefined in sample mode. */
  booked?: ReadonlySet<string>
  className?: string
}) {
  const { t } = useTranslation()
  const days = useDayNames()
  const week = weekAvailability(doctor, now, 0, booked)
  const next = week.find((d) => d.free !== null && d.free > 0)
  const nextLabel = next
    ? t('landing.doctors.freeTimes', { day: days.short[next.date.getDay()], count: next.free })
    : t('landing.doctors.askReception')

  return (
    <div className={cn('card-glow bg-card flex min-w-0 flex-col gap-3 rounded-2xl p-5', className)}>
      <div className="flex items-center gap-3">
        <Avatar name={doctor.name} size="xl" />
        <span className="min-w-0">
          <h3 className="m-0 text-base font-bold">{doctor.name}</h3>
          <p className="text-ink-2 m-0 text-sm">{doctor.title}</p>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-ink-3 text-xs font-semibold tracking-[.04em] uppercase">
          {t('landing.doctors.next7')}
        </span>
        <div className="grid grid-cols-7 gap-1">
          {week.map((d) => (
            <span
              key={d.date.toISOString()}
              className="text-ink-2 flex flex-col items-center gap-1 text-[11px]"
            >
              <span>{days.short[d.date.getDay()]}</span>
              <span
                className={cn(
                  'h-2 w-full rounded',
                  d.free === null
                    ? 'bg-border'
                    : d.free >= FEW_THRESHOLD
                      ? 'bg-green-dot'
                      : 'bg-yellow-dot',
                )}
              />
              <span className="text-ink font-semibold tabular-nums">
                {d.free === null ? '—' : d.free}
              </span>
            </span>
          ))}
        </div>
        <span className="text-ink-3 text-xs">
          {t('landing.doctors.legend')} <Swatch className="bg-green-dot" />{' '}
          {t('landing.doctors.free')} <Swatch className="bg-yellow-dot ml-1.5" />{' '}
          {t('landing.doctors.few')} <Swatch className="bg-border ml-1.5" />{' '}
          {t('landing.doctors.off')}
        </span>
      </div>
      <span className="text-green text-[13px] font-semibold">
        {t('landing.doctors.nextFree', { when: nextLabel })}
      </span>
      <Link
        to="/book"
        search={{ category: doctor.cats[0] }}
        className={buttonVariants({ variant: 'default', size: 'md' })}
      >
        {t('landing.doctors.seeCalendar')}
      </Link>
    </div>
  )
}

const Swatch = ({ className }: { className: string }) => (
  <span
    className={cn('inline-block size-2.5 rounded-[3px] align-middle', className)}
    aria-hidden="true"
  />
)
