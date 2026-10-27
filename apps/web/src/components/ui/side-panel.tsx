import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, X, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRouter } from '@tanstack/react-router'
import { heroBand, type Hue } from '@/components/dash/kit-style'
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

/** The 3 px coloured left edge (the dot colour of the hue); the header is the hue's hero band. */
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
const look = (hue: PanelHue): { edge: string; header: string } => {
  const h = kitHue(hue)
  return { edge: EDGE[h], header: heroBand(h) }
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
 * 600 px wide (92 vw at most; the whole screen on a tablet or phone), white with 12 px left
 * corners and a deep soft shadow, a 1 px left border plus a 3 px coloured edge in the subject's
 * hue, over a dim overlay. It slides in over 220 ms, closes on Escape, on the overlay and on
 * the × button, moves the focus inside (and back where it was on close), keeps Tab inside and
 * locks the page's scroll behind it. The header (56 px) is the hue's hero band (gradient, white
 * text): a 32 px white-glass icon chip, the title at 18 px semibold, a 13 px subtitle, and on
 * the right "Open full page" when a route exists, then ×. The body scrolls; the footer appears
 * only when a form needs Save / Cancel.
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
          'bg-card border-border anim-panel shadow-panel relative flex h-full w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-l-xl border-l outline-none max-[901px]:w-full max-[901px]:max-w-none max-[901px]:rounded-none',
          className,
        )}
      >
        <span
          aria-hidden="true"
          className={cn('absolute inset-y-0 left-0 z-[1] w-[3px]', l.edge)}
        />

        <header
          className={cn(
            'flex min-h-14 flex-none items-center gap-3 py-2 pr-3 pl-5 text-white',
            l.header,
          )}
        >
          <span className="inline-flex size-8 flex-none items-center justify-center rounded-md bg-white/20 text-white">
            <IconC size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <h2 id={titleId} className="m-0 truncate text-[18px] leading-6 font-semibold">
                {title}
              </h2>
              {tags}
            </div>
            {subtitle && (
              <div className="truncate text-[13px] leading-tight text-white/80">{subtitle}</div>
            )}
          </div>
          <div className="flex flex-none items-center gap-1">
            {actions}
            {fullPageTo && fullHref && (
              <a
                href={fullHref}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-white no-underline transition-colors duration-120 hover:bg-white/15 hover:underline"
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
              className="inline-flex size-8 items-center justify-center rounded-md text-white/85 transition-colors duration-120 hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
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
