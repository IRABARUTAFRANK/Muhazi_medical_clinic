import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Circle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { StepKey } from './steps'

export type { StepKey } from './steps'

export interface StepState {
  step: StepKey
  done: boolean
  /** Needed before the visit is finished. */
  required?: boolean
}

/**
 * The six steps side by side, above the one being shown (0130, the owner: "like a slide"): each
 * with its number (a tick when done), its short title, and a red dot when it is needed to finish
 * and still empty. A click shows that step. On a phone only the numbers show (the slide says the
 * title); the bar scrolls sideways inside itself if it ever has to, never the page.
 */
export function StepBar({
  steps,
  current,
  onPick,
}: {
  steps: StepState[]
  /** 1–6. */
  current: number
  onPick: (n: number) => void
}) {
  const { t } = useTranslation()
  return (
    <nav aria-label={t('sixSteps.barLabel')} className="min-w-0">
      <ol className="m-0 flex min-w-0 [scrollbar-width:thin] overflow-x-auto p-0">
        {steps.map((s, i) => {
          const n = i + 1
          const active = n === current
          const title = t(`sixSteps.${s.step}.short`)
          return (
            <li key={s.step} className="relative flex min-w-11 flex-1 list-none">
              {/* the line to the next step, through the middle of the numbers */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-[1.375rem] left-1/2 h-0.5 w-full',
                    s.done ? 'bg-green/60' : 'bg-border',
                  )}
                />
              )}
              <button
                type="button"
                onClick={() => onPick(n)}
                aria-current={active ? 'step' : undefined}
                aria-label={[
                  t('sixSteps.stepAria', { n, title }),
                  t(
                    s.done
                      ? 'sixSteps.done'
                      : s.required
                        ? 'sixSteps.requiredEmpty'
                        : 'sixSteps.empty',
                  ),
                ].join(' · ')}
                title={title}
                className={cn(
                  'group relative z-[1] flex w-full min-w-0 flex-col items-center gap-1 rounded-md bg-transparent px-1 pt-1.5 pb-1 text-center',
                  'focus-visible:ring-primary-tint focus-visible:ring-[3px] focus-visible:outline-none',
                )}
              >
                <span
                  className={cn(
                    'relative flex size-8 flex-none items-center justify-center rounded-full border-2 text-[14px] font-bold tabular-nums transition-[background-color,border-color,box-shadow] duration-200',
                    active
                      ? 'border-primary bg-primary text-on-primary'
                      : s.done
                        ? 'border-green bg-green text-card'
                        : 'border-border bg-card text-ink-2 group-hover:border-primary/60',
                    active && 'ring-primary-tint ring-4',
                  )}
                  aria-hidden="true"
                >
                  {s.done ? <Check size={16} strokeWidth={3} /> : n}
                  {s.required && !s.done && (
                    <span className="bg-red border-card absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2" />
                  )}
                </span>
                <span
                  className={cn(
                    'hidden text-[12px] leading-tight font-semibold sm:block',
                    active ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2',
                  )}
                >
                  {title}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * One step of the visit record, shown alone (a slide): its title, a done / empty mark, a one-line
 * hint, its content, and Previous / Next. The other steps stay mounted but hidden, so a text being
 * typed is not lost when the doctor moves on. It slides in from the side it comes from (quick,
 * nothing under prefers-reduced-motion).
 */
export function StepSlide({
  n,
  total,
  step,
  done,
  active,
  direction,
  required = false,
  aside,
  prevTitle,
  nextTitle,
  onPrev,
  onNext,
  children,
}: {
  n: number
  total: number
  step: StepKey
  done: boolean
  /** The step shown. */
  active: boolean
  /** Where it comes from: 1 = from the right (Next), -1 = from the left (Previous). */
  direction: 1 | -1
  /** Needed before the visit is finished (said beside the title). */
  required?: boolean
  /** Buttons on the title line. */
  aside?: ReactNode
  prevTitle?: string
  nextTitle?: string
  onPrev?: () => void
  onNext?: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el || typeof el.animate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    el.animate(
      [
        { opacity: 0, transform: `translateX(${direction * 28}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    )
    // only when it becomes the step shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  return (
    <section
      ref={ref}
      id={`step-${step}`}
      hidden={!active}
      aria-label={t('sixSteps.stepAria', { n, title: t(`sixSteps.${step}.short`) })}
      className={cn(
        'border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-3 shadow-sm sm:p-4',
        done && 'border-green/30',
      )}
    >
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="min-w-0 flex-[1_1_16rem]">
          <span className="text-ink-3 block text-xs font-semibold tracking-wide uppercase">
            {t('sixSteps.stepOf', { n, total })}
          </span>
          <h3 className="text-ink m-0 flex flex-wrap items-center gap-2 text-[17px] font-semibold">
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
          <p className="text-ink-3 m-0 text-[13px]">
            {t(`sixSteps.${step}.${step === 'definitive' ? 'hintAuto' : 'hint'}`)}
          </p>
        </span>
        {aside && <span className="flex flex-wrap gap-2">{aside}</span>}
      </header>
      {children}
      {(onPrev || onNext) && (
        <footer className="border-border mt-1 flex flex-wrap items-center gap-2 border-t pt-3">
          {onPrev && prevTitle && (
            <Button variant="ghost" onClick={onPrev} className="min-w-0">
              <ChevronLeft size={16} aria-hidden="true" />
              <span className="truncate">{t('sixSteps.previous', { title: prevTitle })}</span>
            </Button>
          )}
          {onNext && nextTitle && (
            <Button onClick={onNext} className="ml-auto min-w-0">
              <span className="truncate">{t('sixSteps.next', { title: nextTitle })}</span>
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          )}
        </footer>
      )}
    </section>
  )
}
