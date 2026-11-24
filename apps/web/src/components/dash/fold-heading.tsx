import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/**
 * The heading of a patient's block that opens and closes it (the laboratory worklist, the doctor's
 * tests and results, the results inbox): the patient and how many, then "Show the tests" /
 * "Hide the tests" with a chevron. The whole line is one button; the block's own buttons stand
 * beside it, never inside.
 */
export function FoldHeading({
  open,
  onToggle,
  controls,
  what = 'tests',
  className,
  children,
}: {
  open: boolean
  onToggle: () => void
  /** The id of what opens. */
  controls: string
  /** What is shown inside: the tests, or their results. */
  what?: 'tests' | 'results'
  className?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const word =
    what === 'results'
      ? t(open ? 'lab.block.hideResults' : 'lab.block.showResults')
      : t(open ? 'lab.block.hide' : 'lab.block.show')
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        'focus-visible:ring-primary/40 -m-1 flex min-w-[min(240px,100%)] flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 rounded-md p-1 text-left focus-visible:ring-2 focus-visible:outline-none',
        className,
      )}
    >
      {children}
      <span className="text-primary ml-auto inline-flex flex-none items-center gap-1 text-[13px] font-semibold">
        {word}
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn('transition-transform', open && 'rotate-180')}
        />
      </span>
    </button>
  )
}
