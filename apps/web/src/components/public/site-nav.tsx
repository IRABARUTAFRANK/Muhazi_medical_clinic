import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CalendarDays, LogIn, Menu, Phone, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_HOURS, CLINIC_PROFILE, formatPhone, telHref } from '@mmc/shared'
import { buttonVariants } from '@/components/ui/button'
import { useClinicInfo, useClinicStatus } from '@/lib/api/public'
import { cn } from '@/lib/utils'
import { LangSwitch } from './lang-switch'

export const Wrap = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mx-auto w-full max-w-[1180px] px-4 sm:px-8', className)} {...props} />
)

/** Smooth scrolling to a section, unless the visitor asked the system for less motion. */
const smooth = (): ScrollIntoViewOptions => ({
  behavior:
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth',
  block: 'start',
})

const menuLinkClass =
  'flex min-h-12 items-center rounded-xl px-3 text-base font-medium text-ink no-underline transition-colors hover:bg-primary-tint hover:text-primary'

interface SiteNavProps {
  current: 'landing' | 'booking'
}

interface NavLink {
  key: string
  hash?: string
  to: '/' | '/book'
  active?: boolean
}

/**
 * Public header.
 *  · Identity tier (white): large logo and name, phone, open status, language, staff sign-in.
 *  · Link strip (navy): the sections, a gliding underline on the section in view (scroll spy)
 *    that follows the pointer on hover, and "Find a doctor".
 *  · On scroll (PC) the identity tier folds away and a small logo slides into the strip, so the
 *    header shrinks to one line; a thin bar shows how far down the page the visitor is.
 *  · Section links scroll smoothly. Below `lg` the strip becomes a menu sheet.
 */
export function SiteNav({ current }: SiteNavProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [progress, setProgress] = useState(0)
  const [inView, setInView] = useState<string | null>(null)
  const close = () => setOpen(false)
  const { data: info } = useClinicInfo()
  const profile = info?.profile ?? CLINIC_PROFILE
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)

  const links: NavLink[] =
    current === 'landing'
      ? [
          { key: 'nav.services', to: '/', hash: 'services' },
          { key: 'nav.findDoctor', to: '/', hash: 'doctors' },
          { key: 'nav.book', to: '/', hash: 'book' },
          { key: 'nav.insurance', to: '/', hash: 'insurance' },
          { key: 'nav.visit', to: '/', hash: 'visit' },
        ]
      : [
          { key: 'nav.home', to: '/' },
          { key: 'nav.findDoctor', to: '/book', active: true },
          { key: 'nav.insurance', to: '/', hash: 'insurance' },
          { key: 'nav.visit', to: '/', hash: 'visit' },
        ]

  // Condensed header + reading progress.
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setScrolled(y > 40)
      const max = document.documentElement.scrollHeight - window.innerHeight
      setProgress(max > 0 ? Math.min(1, y / max) : 0)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  // Scroll spy: the section crossing the middle band of the screen is "in view".
  useEffect(() => {
    if (current !== 'landing') return
    const ids = ['services', 'doctors', 'book', 'insurance', 'visit']
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e)
    if (!els.length) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setInView(e.target.id)
      },
      { rootMargin: '-40% 0px -55% 0px' },
    )
    els.forEach((e) => io.observe(e))
    const onTop = () => window.scrollY < 200 && setInView(null)
    window.addEventListener('scroll', onTop, { passive: true })
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', onTop)
    }
  }, [current])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const activeKey =
    links.find((l) => l.active)?.key ?? links.find((l) => l.hash && l.hash === inView)?.key ?? null

  return (
    <>
      {/* The header is fixed: folding it on scroll must not move the page (anchors would land
        short). This spacer keeps its full, unfolded height in the flow. */}
      <div aria-hidden="true" className="h-[92px] lg:h-[146px]" />
      <header className="site-header-in fixed inset-x-0 top-0 z-40">
        {/* Identity tier: folds away on scroll (PC); stays compact on phones. */}
        <div
          className={cn(
            'grid border-b border-[#e3eaf3] bg-white/95 backdrop-blur-md transition-[grid-template-rows,opacity] duration-300 ease-out',
            scrolled
              ? 'lg:grid-rows-[0fr] lg:border-b-0 lg:opacity-0'
              : 'grid-rows-[1fr] opacity-100',
          )}
        >
          <div className="overflow-hidden">
            <Wrap
              className={cn(
                'flex items-center gap-4 transition-[min-height] duration-300',
                scrolled ? 'min-h-[64px]' : 'min-h-[92px]',
              )}
            >
              <Link to="/" className="group flex min-w-0 items-center gap-3.5 no-underline">
                <img
                  src="/logo.jpg"
                  alt=""
                  className={cn(
                    'flex-none rounded-full object-cover shadow-[0_6px_18px_rgba(11,34,82,.18)] ring-2 ring-white transition-all duration-300 group-hover:scale-[1.04] group-hover:rotate-[-4deg]',
                    scrolled ? 'size-11' : 'size-[52px] sm:size-[68px]',
                  )}
                />
                <span className="flex min-w-0 flex-col leading-[1.1]">
                  <span
                    className={cn(
                      'font-extrabold tracking-[-0.02em] text-[#0b2252] transition-all duration-300',
                      scrolled ? 'text-[18px]' : 'text-[19px] sm:text-[28px]',
                    )}
                  >
                    {t('app.clinicName')}
                  </span>
                  <span className="text-ink-3 mt-1 truncate text-[10.5px] font-semibold tracking-[.1em] uppercase sm:text-[13px] sm:tracking-[.12em]">
                    {t('app.place')}
                  </span>
                </span>
              </Link>

              <div className="ml-auto flex items-center gap-2 sm:gap-3">
                <a
                  href={telHref(profile.phone)}
                  className="group wide:inline-flex hidden items-center gap-2.5 rounded-xl px-2 py-1.5 text-left no-underline transition-colors hover:bg-[#f1f6fb]"
                >
                  <span className="inline-flex size-10 items-center justify-center rounded-full bg-[#e8f6ec] text-[#1e7b34] transition-transform group-hover:scale-110 group-hover:rotate-12">
                    <Phone size={18} aria-hidden="true" />
                  </span>
                  <span className="flex flex-col leading-tight">
                    <span className="text-ink-3 text-[11px] font-semibold tracking-[.06em] uppercase">
                      {t('landing.visit.callUs')}
                    </span>
                    <span className="text-[15px] font-bold text-[#0b2252] tabular-nums">
                      {formatPhone(profile.phone)}
                    </span>
                  </span>
                </a>
                {status && (
                  <span
                    className={cn(
                      'hidden items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-semibold xl:inline-flex',
                      status.open ? 'bg-[#e8f6ec] text-[#1e7b34]' : 'bg-[#f1f3f6] text-[#4b5a78]',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-2 rounded-full',
                        status.open ? 'pulse-ring bg-[#37a935] text-[#37a935]' : 'bg-[#8a95a8]',
                      )}
                    />
                    {status.open ? t('landing.visit.openNow') : t('dashboard.clinicClosed')}
                  </span>
                )}
                <span aria-hidden="true" className="hidden h-8 w-px bg-[#e3eaf3] xl:block" />
                <div className="hidden sm:block">
                  <LangSwitch />
                </div>
                <Link
                  to="/"
                  hash="signin"
                  hashScrollIntoView={smooth()}
                  className={cn(
                    buttonVariants({ variant: 'default', size: 'md' }),
                    'hidden transition-transform hover:-translate-y-px md:inline-flex',
                  )}
                >
                  <LogIn size={16} aria-hidden="true" />
                  {t('common.staffSignIn')}
                </Link>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls="site-menu"
                  aria-label={open ? t('common.closeMenu') : t('common.menu')}
                  onClick={() => setOpen((o) => !o)}
                  className="border-border bg-card text-ink hover:bg-hover inline-flex size-11 items-center justify-center rounded-xl border transition-colors lg:hidden"
                >
                  {open ? (
                    <X size={22} aria-hidden="true" />
                  ) : (
                    <Menu size={22} aria-hidden="true" />
                  )}
                </button>
              </div>
            </Wrap>
          </div>
        </div>

        {/* Link strip */}
        <div className="relative hidden bg-[linear-gradient(90deg,#0b2252,#13306b_60%,#145a3a)] lg:block">
          <Wrap className="flex min-h-[54px] items-center gap-2">
            {/* Mini identity, slides in when the identity tier folds away */}
            <Link
              to="/"
              aria-hidden={!scrolled}
              tabIndex={scrolled ? 0 : -1}
              className={cn(
                'flex items-center gap-2.5 overflow-hidden text-white no-underline transition-[max-width,opacity,transform,margin] duration-300 ease-out',
                scrolled
                  ? 'mr-3 max-w-[260px] translate-x-0 opacity-100'
                  : 'pointer-events-none mr-0 max-w-0 -translate-x-3 opacity-0',
              )}
            >
              <img
                src="/logo.jpg"
                alt=""
                className="size-8 flex-none rounded-full ring-2 ring-white/70"
              />
              <span className="text-[15px] font-extrabold whitespace-nowrap">
                {t('app.clinicName')}
              </span>
            </Link>

            <StripLinks links={links} activeKey={activeKey} label={t('common.siteNav')} />

            <div className="ml-auto flex items-center gap-2">
              <Link
                to="/"
                hash="signin"
                hashScrollIntoView={smooth()}
                aria-label={t('common.staffSignIn')}
                title={t('common.staffSignIn')}
                className={cn(
                  'inline-flex size-9 items-center justify-center rounded-full text-white/85 transition-all duration-300 hover:bg-white/10 hover:text-white',
                  scrolled ? 'scale-100 opacity-100' : 'pointer-events-none scale-75 opacity-0',
                )}
              >
                <LogIn size={17} aria-hidden="true" />
              </Link>
              <Link
                to="/book"
                className="group inline-flex min-h-9 items-center gap-2 rounded-full bg-[#37a935] px-4 text-[14px] font-bold text-white no-underline shadow-[0_6px_16px_rgba(55,169,53,.35)] transition-[transform,background-color,box-shadow] hover:-translate-y-px hover:bg-[#2f9a2e] hover:shadow-[0_10px_22px_rgba(55,169,53,.45)] active:translate-y-0"
              >
                <CalendarDays size={16} aria-hidden="true" />
                {t('common.findDoctor')}
                <span
                  aria-hidden="true"
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </div>
          </Wrap>
          {/* Reading progress */}
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-[3px] origin-left bg-[linear-gradient(90deg,#7bd36a,#39a9df)] transition-transform duration-150"
            style={{ width: '100%', transform: `scaleX(${progress})` }}
          />
        </div>

        {open && (
          <div
            id="site-menu"
            className="anim-rise border-border/70 border-b bg-white px-4 pt-2 pb-4 shadow-lg sm:px-8 lg:hidden"
          >
            <nav aria-label={t('common.menu')} className="flex flex-col">
              {links.map((l) => (
                <Link
                  key={l.key}
                  to={l.to}
                  hash={l.hash}
                  hashScrollIntoView={smooth()}
                  onClick={close}
                  className={cn(
                    menuLinkClass,
                    (l.active || l.key === activeKey) && 'bg-primary-tint text-primary',
                  )}
                >
                  {t(l.key)}
                </Link>
              ))}
            </nav>
            <div className="border-border/70 mt-2 flex flex-wrap items-center gap-3 border-t pt-3">
              <LangSwitch />
              <a
                href={telHref(profile.phone)}
                className={buttonVariants({ variant: 'default', size: 'md' })}
              >
                <Phone size={16} aria-hidden="true" />
                {formatPhone(profile.phone)}
              </a>
              <Link
                to="/"
                hash="signin"
                hashScrollIntoView={smooth()}
                onClick={close}
                className={buttonVariants({ variant: 'default', size: 'md' })}
              >
                <LogIn size={16} aria-hidden="true" />
                {t('common.staffSignIn')}
              </Link>
              <Link
                to="/book"
                onClick={close}
                className={buttonVariants({ variant: 'primary', size: 'md' })}
              >
                {t('common.findDoctor')}
              </Link>
            </div>
          </div>
        )}
      </header>
    </>
  )
}

/** Section links with one underline that glides to the hovered link, else the one in view. */
function StripLinks({
  links,
  activeKey,
  label,
}: {
  links: NavLink[]
  activeKey: string | null
  label: string
}) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)
  const refs = useRef(new Map<string, HTMLAnchorElement>())
  const [hovered, setHovered] = useState<string | null>(null)
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null)
  const target = hovered ?? activeKey

  const measure = useCallback(() => {
    const el = target ? refs.current.get(target) : null
    const nav = navRef.current
    if (!el || !nav) return setBar(null)
    const a = el.getBoundingClientRect()
    const n = nav.getBoundingClientRect()
    setBar({ left: a.left - n.left + 12, width: a.width - 24 })
  }, [target])

  useLayoutEffect(() => {
    measure()
  }, [measure, t])
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  return (
    <nav
      ref={navRef}
      aria-label={label}
      className="relative -ml-3 flex gap-1"
      onMouseLeave={() => setHovered(null)}
    >
      {links.map((l) => (
        <Link
          key={l.key}
          ref={(el) => {
            if (el) refs.current.set(l.key, el)
          }}
          to={l.to}
          hash={l.hash}
          hashScrollIntoView={smooth()}
          onMouseEnter={() => setHovered(l.key)}
          onFocus={() => setHovered(l.key)}
          onBlur={() => setHovered(null)}
          // Every link points at "/": let the router mark only the one whose #section is open.
          activeOptions={{ includeHash: true }}
          data-current={l.key === activeKey ? '' : undefined}
          className={cn(
            'inline-flex min-h-[54px] items-center px-3 text-[14px] font-semibold no-underline transition-colors duration-200',
            l.key === target ? 'text-white' : 'text-white/72 hover:text-white',
          )}
        >
          {t(l.key)}
        </Link>
      ))}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute bottom-2 h-[3px] rounded-full bg-[#7bd36a] shadow-[0_0_12px_rgba(123,211,106,.7)] transition-[left,width,opacity] duration-300 ease-out',
          bar ? 'opacity-100' : 'opacity-0',
        )}
        style={bar ? { left: bar.left, width: bar.width } : { left: 0, width: 0 }}
      />
    </nav>
  )
}
