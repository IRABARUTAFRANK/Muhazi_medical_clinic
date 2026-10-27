import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, X, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRouter } from '@tanstack/react-router'
import { tintClass, type Hue } from '@/components/dash/kit-style'
import { cn } from '@/lib/utils'
import './side-panel.css'

/**
 * The hue of a side panel is the subject it opens: patient = teal, finance = mint, stock =
 * amber, laboratory = lavender, staff = clinical blue, settings = grey, record access = coral,
 * bookings = rose. `violet` and `navy` are the kit's names for lavender and the clinical blue
 * and are accepted too, so a page can pass the tint it already uses.
 */
export type PanelHue = Hue | 'lavender' | 'blue' | 'grey'

const kitHue = (hue: PanelHue): Hue | 'grey' =>
  hue === 'lavender' ? 'violet' : hue === 'blue' ? 'navy' : hue

/** The 3 px coloured left edge (the dot colour of the hue) and the header on its tint at 60 %. */
const EDGE: Record<Hue | 'grey', string> = {
  teal: 'bg-primary',
  mint: 'bg-green-dot',
  amber: 'bg-yellow-dot',
  coral: 'bg-red-dot',
  violet: 'bg-violet-dot',
  navy: 'bg-blue-dot',
  rose: 'bg-rose-dot',
  grey: 'bg-ink-3',
}
const HEADER: Record<Hue | 'grey', string> = {
  teal: 'bg-primary-tint/60',
  mint: 'bg-green-bg/60',
  amber: 'bg-amber-bg/60',
  coral: 'bg-red-bg/60',
  violet: 'bg-violet-bg/60',
  navy: 'bg-blue-bg/60',
  rose: 'bg-rose-bg/60',
  grey: 'bg-surface',
}
const look = (hue: PanelHue): { edge: string; header: string; chip: string } => {
  const h = kitHue(hue)
  return {
    edge: EDGE[h],
    header: HEADER[h],
    chip: h === 'grey' ? 'bg-hover text-ink-2' : tintClass[h],
  }
}

export interface SidePanelProps {
  open: boolean
  onClose: () => void
  hue: PanelHue
  icon: LucideIcon
  title: ReactNode
  subtitle?: ReactNode
  /** Small tags after the title (a triage colour, a state). */
  tags?: ReactNode
  /** Route of the same thing as a whole page: shows "Open full page" with an external-link icon. */
  fullPageTo?: { to: string; search?: Record<string, unknown> }
  /** Extra actions in the header, before the close button. */
  actions?: ReactNode
  /** Save / Cancel row of a form: a 56 px row with a rule above, buttons right. */
  footer?: ReactNode
  /** Accessible name when the title is not plain text. */
  ariaLabel?: string
  className?: string
  /** Body padding (20 px by default); false when the content lays itself out. */
  padded?: boolean
  children: ReactNode
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A right-hand drawer for the thing someone opened (a patient file, an employee, a booking):
 * 600 px wide (92 vw at most; the whole screen on a tablet or phone), white, a 1 px left border
 * plus a 3 px coloured edge in the subject's hue, over a dim overlay. It slides in over 220 ms,
 * closes on Escape, on the overlay and on the × button, moves the focus inside (and back where
 * it was on close), keeps Tab inside and locks the page's scroll behind it. The header (56 px)
 * sits on a soft tint of the hue: a 32 px icon chip, the title at 18 px semibold, a 13 px grey
 * subtitle, and on the right "Open full page" when a route exists, then ×. The body scrolls;
 * the footer appears only when a form needs Save / Cancel.
 */
export function SidePanel({
  open,
  onClose,
  hue,
  icon: IconC,
  title,
  subtitle,
  tags,
  fullPageTo,
  actions,
  footer,
  ariaLabel,
  className,
  padded = true,
  children,
}: SidePanelProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  // focus inside while open, back where it was after; the page behind does not scroll
  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement as HTMLElement | null
    const body = document.body
    const before = body.style.overflow
    body.style.overflow = 'hidden'
    const id = window.requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }))
    return () => {
      window.cancelAnimationFrame(id)
      body.style.overflow = before
      returnFocus.current?.focus?.({ preventScroll: true })
    }
  }, [open])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        e.preventDefault()
        return
      }
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  if (!open) return null
  const l = look(hue)
  const fullHref = fullPageTo ? router.buildLocation(fullPageTo as never).href : undefined

  return createPortal(
    <div
      className="anim-panel-overlay fixed inset-0 z-[90] flex justify-end bg-[rgba(15,23,42,0.32)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'bg-card border-border anim-panel relative flex h-full w-[600px] max-w-[92vw] flex-col border-l outline-none max-[901px]:w-full max-[901px]:max-w-none',
          className,
        )}
      >
        <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', l.edge)} />

        <header
          className={cn(
            'border-border flex min-h-14 flex-none items-center gap-3 border-b py-2 pr-3 pl-5',
            l.header,
          )}
        >
          <span
            className={cn(
              'inline-flex size-8 flex-none items-center justify-center rounded-md',
              l.chip,
            )}
          >
            <IconC size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <h2
                id={titleId}
                className="text-ink m-0 truncate text-[18px] leading-6 font-semibold"
              >
                {title}
              </h2>
              {tags}
            </div>
            {subtitle && (
              <div className="text-ink-3 truncate text-[13px] leading-tight">{subtitle}</div>
            )}
          </div>
          <div className="flex flex-none items-center gap-1">
            {actions}
            {fullPageTo && fullHref && (
              <a
                href={fullHref}
                className="text-primary hover:bg-primary-tint inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-120 hover:underline"
                onClick={(e) => {
                  // a plain click stays in the app and closes the panel; middle / ctrl-click opens a tab
                  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey)
                    return
                  e.preventDefault()
                  onClose()
                  void router.navigate(fullPageTo as never)
                }}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span className="max-[480px]:sr-only">{t('panel.openFull')}</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('panel.close')}
              className="text-ink-2 hover:bg-hover hover:text-ink focus-visible:ring-primary/20 inline-flex size-8 items-center justify-center rounded-md transition-colors duration-120 focus-visible:ring-2 focus-visible:outline-none"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className={cn('min-h-0 flex-1 overflow-y-auto', padded && 'p-5')}>{children}</div>

        {footer && (
          <footer className="border-border bg-card flex min-h-14 flex-none items-center justify-end gap-2 border-t px-5 py-2">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The open / closed state of a panel that shows one item of a list: `open(item)` selects and
 * shows it, `close()` hides it, `item` is what is shown (kept while closed so the content does
 * not blank out mid-animation). `isOpen(id)` gives a row its selected tint.
 */
export function useSidePanelState<T>(pick: (item: T) => string = (x) => String(x)) {
  const [item, setItem] = useState<T | null>(null)
  const [open, setOpen] = useState(false)
  return {
    item,
    open,
    show: (next: T) => {
      setItem(next)
      setOpen(true)
    },
    close: () => setOpen(false),
    isOpen: (candidate: T) => open && item !== null && pick(item) === pick(candidate),
  }
}
