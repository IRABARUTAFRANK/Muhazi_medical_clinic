import type { ReactNode } from 'react'
import { CheckCircle2, Circle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/** The six steps of a visit (0127), in order. */
export type StepKey = 'complaint' | 'exam' | 'differential' | 'tests' | 'definitive' | 'plan'

/**
 * One step of the visit record, as a card on a vertical line: its number, title, a done / empty
 * mark, a one-line hint and its content. The doctor works in any order and comes back; on a
 * phone the cards stack, the line stays on the left.
 */
export function StepCard({
  n,
  step,
  done,
  required = false,
  last = false,
  aside,
  children,
}: {
  n: number
  step: StepKey
  done: boolean
  /** Needed before the visit is finished (said beside the title). */
  required?: boolean
  last?: boolean
  /** Buttons on the title line. */
  aside?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <li
      id={`step-${step}`}
      className="relative flex list-none gap-4"
      aria-label={t('sixSteps.stepAria', { n, title: t(`sixSteps.${step}.title`) })}
    >
      {/* the number on the line */}
      <span className="relative hidden flex-none flex-col items-center sm:flex">
        <span
          className={cn(
            'z-[1] flex size-8 items-center justify-center rounded-full border-2 text-[14px] font-bold tabular-nums',
            done ? 'border-green bg-green text-card' : 'border-primary/50 bg-card text-primary',
          )}
          aria-hidden="true"
        >
          {n}
        </span>
        {!last && <span className="bg-border mt-1 w-0.5 flex-1" aria-hidden="true" />}
      </span>
      <section
        className={cn(
          'border-border bg-card mb-3 flex min-w-0 flex-1 flex-col gap-3 rounded-lg border p-3 shadow-sm sm:mb-4 sm:p-4',
          done && 'border-green/30',
        )}
      >
        <header className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <span className="min-w-0 flex-[1_1_16rem]">
            <h3 className="text-ink m-0 flex flex-wrap items-center gap-2 text-[16px] font-semibold">
              {t(`sixSteps.${step}.title`)}
              {done ? (
                <span className="text-green inline-flex items-center gap-1 text-xs font-semibold">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  {t('sixSteps.done')}
                </span>
              ) : (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-xs font-semibold',
                    required ? 'text-red' : 'text-ink-3',
                  )}
                >
                  <Circle size={12} aria-hidden="true" />
                  {t(required ? 'sixSteps.requiredEmpty' : 'sixSteps.empty')}
                </span>
              )}
            </h3>
            <p className="text-ink-3 m-0 text-[13px]">{t(`sixSteps.${step}.hint`)}</p>
          </span>
          {aside && <span className="flex flex-wrap gap-2">{aside}</span>}
        </header>
        {children}
      </section>
    </li>
  )
}
