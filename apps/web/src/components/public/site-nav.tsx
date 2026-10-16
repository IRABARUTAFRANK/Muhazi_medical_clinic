import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LangSwitch } from './lang-switch'
import { Logo } from './logo'

export const Wrap = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mx-auto w-full max-w-[1180px] px-4 sm:px-8', className)} {...props} />
)

const linkClass =
  'inline-flex min-h-11 items-center rounded-xl px-3 text-[15px] font-medium text-ink-2 no-underline transition-colors hover:bg-primary-tint hover:text-primary'
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
 * Public header: a floating, rounded, translucent bar. Section links from `lg`, a menu button
 * below that opens the same links plus language, sign-in and find-a-doctor.
 */
export function SiteNav({ current }: SiteNavProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

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
    <div className="sticky top-0 z-40 px-3 pt-3 sm:px-4">
      <header className="relative mx-auto max-w-[1180px] rounded-2xl border border-white/70 bg-white/85 shadow-[0_8px_30px_rgba(11,34,82,.12)] backdrop-blur-md">
        <div className="flex min-h-16 items-center gap-3 px-3 sm:px-5">
          <Logo subtitle={t('app.place')} />
          <nav aria-label={t('common.siteNav')} className="ml-2 hidden gap-1 lg:flex">
            {links.map((l) => (
              <Link
                key={l.key}
                to={l.to}
                hash={l.hash}
                className={cn(linkClass, l.active && 'bg-primary-tint text-primary')}
              >
                {t(l.key)}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
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
            {current === 'landing' && (
              <Link
                to="/book"
                className={cn(
                  buttonVariants({ variant: 'primary', size: 'md' }),
                  'wide:inline-flex hidden',
                )}
              >
                {t('common.findDoctor')}
              </Link>
            )}
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
        </div>

        {open && (
          <div
            id="site-menu"
            className="anim-rise border-border/70 border-t px-3 pt-2 pb-4 sm:px-5 lg:hidden"
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
    </div>
  )
}
