import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface LogoProps {
  to?: '/' | '/app'
  subtitle: string
  size?: 'md' | 'lg'
  ariaLabel?: string
  className?: string
}

/** Clinic logo with name and a one-line subtitle, used in every header. */
export function Logo({ to = '/', subtitle, size = 'lg', ariaLabel, className }: LogoProps) {
  const { t } = useTranslation()
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      className={cn('text-ink flex items-center gap-2.5 no-underline', className)}
    >
      <img
        src="/logo.jpg"
        alt=""
        className={cn('flex-none rounded-full object-cover', size === 'lg' ? 'size-11' : 'size-9')}
      />
      <span className="flex flex-col leading-[1.15]">
        <span className={size === 'lg' ? 'text-[17px] font-extrabold' : 'text-sm font-bold'}>
          {t('app.clinicName')}
        </span>
        <span className="text-ink-3 text-xs">{subtitle}</span>
      </span>
    </Link>
  )
}
