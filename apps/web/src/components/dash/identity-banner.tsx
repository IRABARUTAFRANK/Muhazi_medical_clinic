import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Award,
  Building2,
  CalendarDays,
  ConciergeBell,
  Crown,
  HeartPulse,
  IdCard,
  MapPin,
  Stethoscope,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_HOURS, formatDate, type Role, type StaffUser } from '@mmc/shared'
import { useClinicInfo, useClinicStatus } from '@/lib/api/public'
import { useDayNames } from '@/lib/hooks'
import { roleLabel } from '@/lib/roles'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { initials, tintClass, type Tint } from './kit-style'

/*
 * Identity banner, the first thing under the top bar on every dashboard: who is signed in
 * (large name), as what (role with its icon and colour), where (department, position,
 * station) and the staff ID, so a shared screen never leaves doubt about whose session it is.
 */

const ROLE_LOOK: Record<Role, { icon: LucideIcon; tint: Tint; stripe: string }> = {
  manager: { icon: Crown, tint: 'navy', stripe: 'bg-navy' },
  receptionist: { icon: ConciergeBell, tint: 'teal', stripe: 'bg-primary' },
  nurse: { icon: HeartPulse, tint: 'mint', stripe: 'bg-green' },
  doctor: { icon: Stethoscope, tint: 'violet', stripe: 'bg-violet' },
  cashier: { icon: Wallet, tint: 'amber', stripe: 'bg-amber' },
}
const lookFor = (role: Role) => ROLE_LOOK[role] ?? ROLE_LOOK.doctor

type Position = 'head' | 'assistant' | 'member'

/** The signed-in person's department and position (own profile row; readable by everyone). */
function usePlacement(user: StaffUser) {
  return useQuery({
    queryKey: ['my-placement', user.id],
    enabled: !!supabase,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from('profiles')
        .select('position, department:department_id(name)')
        .eq('id', user.id)
        .maybeSingle()
      if (error) throw error
      const dept = data?.department as { name: string } | { name: string }[] | null | undefined
      return {
        position: (data?.position ?? 'member') as Position,
        department: (Array.isArray(dept) ? dept[0]?.name : dept?.name) ?? null,
      }
    },
  })
}

export function IdentityBanner({ user, greeting }: { user: StaffUser; greeting: string }) {
  const { t } = useTranslation()
  const dayNames = useDayNames()
  const now = new Date()
  const { data: placement } = usePlacement(user)
  const { data: info } = useClinicInfo()
  const { data: status } = useClinicStatus(info?.hours ?? CLINIC_HOURS)
  const look = lookFor(user.role)
  const RoleIcon = look.icon
  const position: Position =
    placement?.position ??
    (user.dashboard === 'head' && user.role !== 'manager' ? 'head' : 'member')
  const department = placement?.department ?? (position === 'head' ? user.headOf : undefined)

  return (
    <section
      aria-label={t('identity.aria', { name: user.name })}
      className="anim-enter bg-card shadow-card relative flex flex-none flex-wrap items-center gap-x-6 gap-y-4 overflow-hidden rounded-[20px] py-5 pr-6 pl-7"
    >
      {/* Role colour stripe and a large faint role icon, for recognition from across the room. */}
      <span className={cn('absolute inset-y-0 left-0 w-1.5', look.stripe)} aria-hidden="true" />
      <RoleIcon
        size={150}
        strokeWidth={1.2}
        aria-hidden="true"
        className="text-ink pointer-events-none absolute -right-4 -bottom-8 opacity-[0.045]"
      />

      <span className="relative flex-none">
        <span
          className={cn(
            'inline-flex size-[76px] items-center justify-center rounded-[22px] text-[26px] font-extrabold tracking-[-0.02em]',
            tintClass[look.tint],
          )}
        >
          {initials(user.name)}
        </span>
        <span
          className={cn(
            'ring-card absolute -right-1.5 -bottom-1.5 inline-flex size-8 items-center justify-center rounded-full text-white ring-[3px]',
            look.stripe,
          )}
        >
          <RoleIcon size={16} aria-hidden="true" />
        </span>
      </span>

      <div className="relative min-w-[220px] flex-1">
        <div className="text-ink-2 text-sm font-semibold">{greeting}</div>
        <h1 className="m-0 mt-0.5 text-[30px] leading-[1.15] font-extrabold tracking-[-0.02em] break-words">
          {user.name}
        </h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-bold',
              tintClass[look.tint],
            )}
          >
            <RoleIcon size={14} aria-hidden="true" />
            {roleLabel(user, t)}
          </span>
          {department && <Chip icon={Building2}>{department}</Chip>}
          {placement && position !== 'member' && (
            <Chip icon={Award}>{t(`staff.positions.${position}`)}</Chip>
          )}
          {user.station && user.role !== 'doctor' && <Chip icon={MapPin}>{user.station}</Chip>}
          {user.staffId && (
            <Chip icon={IdCard}>
              <span className="tabular-nums">{user.staffId}</span>
            </Chip>
          )}
        </div>
      </div>

      <div className="relative flex flex-col items-start gap-2 text-sm">
        <span className="text-ink-2 inline-flex items-center gap-2 font-semibold">
          <CalendarDays size={16} aria-hidden="true" className="text-ink-3" />
          {dayNames.long[now.getDay()]} {formatDate(now)}
        </span>
        {status && (
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-bold',
              status.open ? 'bg-green-bg text-green' : 'bg-red-bg text-red',
            )}
          >
            <span
              className={cn(
                'size-2 rounded-full',
                status.open ? 'bg-green animate-pulse' : 'bg-red',
              )}
              aria-hidden="true"
            />
            {t(status.open ? 'dashboard.clinicOpen' : 'dashboard.clinicClosed')}
          </span>
        )}
      </div>
    </section>
  )
}

function Chip({ icon: IconC, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="border-border text-ink-2 bg-surface inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-semibold">
      <IconC size={14} aria-hidden="true" className="text-ink-3" />
      {children}
    </span>
  )
}
