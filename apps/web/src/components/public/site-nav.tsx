import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Clock, Menu, Phone, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_HOURS, CLINIC_PROFILE, formatPhone, telHref } from '@mmc/shared'
import { buttonVariants } from '@/components/ui/button'
import { useClinicInfo, useClinicStatus } from '@/lib/api/public'
import { cn } from '@/lib/utils'
import { LangSwitch } from './lang-switch'

export const Wrap = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mx-auto w-full max-w-[1180px] px-4 sm:px-8', className)} {...props} />
)

const stripLink =
  'relative inline-flex min-h-11 items-center px-3 text-[14px] font-semibold text-white/80 no-underline transition-colors hover:text-white after:absolute after:inset-x-3 after:bottom-1.5 after:h-0.5 after:origin-left after:scale-x-0 after:rounded-full after:bg-[#7BD36A] after:transition-transform after:duration-200 hover:after:scale-x-100'
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
 * Public header in two tiers. Top: the clinic's identity, large (logo, name, place), with the
 * phone, the opening status, language and the two actions. Below: a navy strip with the section
 * links. On scroll the identity tier compacts so the page keeps its room. Below `lg` the links
 * and actions move into a menu sheet.
 */
export function SiteNav({ current }: SiteNavProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const close = () => setOpen(false)
  const { data: info } = useClinicInfo()
  const profile = info?.profile ?? CLINIC_PROFILE
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

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

  return (
    <header
      className={cn(
        'sticky top-0 z-40 transition-shadow duration-300',
        scrolled && 'shadow-[0_10px_30px_rgba(11,34,82,.18)]',
      )}
    >
      {/* Tier 1 · identity */}
      <div className="border-b border-[#e3eaf3] bg-white/95 backdrop-blur-md">
        <Wrap
          className={cn(
            'flex items-center gap-4 transition-[min-height] duration-300',
            scrolled ? 'min-h-[68px]' : 'min-h-[92px]',
          )}
        >
          <Link to="/" className="group flex min-w-0 items-center gap-3.5 no-underline">
            <img
              src="/logo.jpg"
              alt=""
              className={cn(
                'flex-none rounded-full object-cover shadow-[0_6px_18px_rgba(11,34,82,.18)] ring-2 ring-white transition-all duration-300 group-hover:scale-[1.03]',
                scrolled ? 'size-11 sm:size-12' : 'size-[52px] sm:size-[68px]',
              )}
            />
            <span className="flex min-w-0 flex-col leading-[1.1]">
              <span
                className={cn(
                  'font-extrabold tracking-[-0.02em] text-[#0b2252] transition-all duration-300',
                  scrolled ? 'text-[18px] sm:text-[20px]' : 'text-[19px] sm:text-[28px]',
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
              className="wide:inline-flex hidden items-center gap-2.5 rounded-xl px-2 py-1.5 text-left no-underline transition-colors hover:bg-[#f1f6fb]"
            >
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-[#e8f6ec] text-[#1e7b34]">
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
                <Clock size={14} aria-hidden="true" />
                {status.open ? t('landing.visit.openNow') : t('dashboard.clinicClosed')}
              </span>
            )}
            <div className="hidden sm:block">
              <LangSwitch />
            </div>
            <Link
              to="/"
              hash="signin"
              className={cn(
                buttonVariants({ variant: 'default', size: 'md' }),
                'hidden md:inline-flex',
              )}
            >
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
              {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
            </button>
          </div>
        </Wrap>
      </div>

      {/* Tier 2 · section links on navy */}
      <div className="hidden bg-[linear-gradient(90deg,#0b2252,#13306b_60%,#145a3a)] lg:block">
        <Wrap className="flex min-h-12 items-center gap-1">
          <nav aria-label={t('common.siteNav')} className="-ml-3 flex gap-1">
            {links.map((l) => (
              <Link
                key={l.key}
                to={l.to}
                hash={l.hash}
                className={cn(stripLink, l.active && 'text-white after:scale-x-100')}
              >
                {t(l.key)}
              </Link>
            ))}
          </nav>
          <Link
            to="/book"
            className="ml-auto inline-flex min-h-9 items-center gap-2 rounded-full bg-[#37a935] px-4 text-[14px] font-bold text-white no-underline shadow-[0_6px_16px_rgba(55,169,53,.35)] transition-[transform,background-color] hover:-translate-y-px hover:bg-[#2f9a2e] active:translate-y-0"
          >
            {t('common.findDoctor')} →
          </Link>
        </Wrap>
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
                onClick={close}
                className={cn(menuLinkClass, l.active && 'bg-primary-tint text-primary')}
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
              onClick={close}
              className={buttonVariants({ variant: 'default', size: 'md' })}
            >
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
  )
}
