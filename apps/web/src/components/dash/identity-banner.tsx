import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Award, Building2, CalendarDays, IdCard, MapPin, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_HOURS, formatDate, type StaffUser } from '@mmc/shared'
import { Avatar } from '@/components/ui/avatar'
import { useClinicInfo, useClinicStatus } from '@/lib/api/public'
import { useDayNames } from '@/lib/hooks'
import { roleLabel } from '@/lib/roles'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { edgeClass, lookFor, stripeClass, tagClass, tileClass } from './kit-style'

/*
 * Identity header, the first thing under the top bar on every dashboard: who is signed in
 * (name, 20 px), as what (role tag with its icon), where (department, position, station) and
 * the staff ID, so a shared screen never leaves doubt about whose session it is. A band on the
 * role's light tint with a 3 px coloured left edge; the date and the clinic's open state sit
 * at the right.
 */

type Position = 'head' | 'assistant' | 'member'

/** The signed-in person's department and position (own profile row; readable by everyone). */
function usePlacement(user: StaffUser) {
  return useQuery({
    queryKey: ['my-placement', user.id],
    enabled: !!supabase,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!.rpc('my_placement')
      if (error) throw error
      const d = (data ?? {}) as {
        position?: Position
        department?: string | null
        specialty?: string | null
        departments?: { name: string; position: Position }[]
      }
      return {
        position: (d.position ?? 'member') as Position,
        department: d.department ?? null,
        // every department (an employee may work in several), with the position held there
        departments: d.departments ?? [],
        specialty: d.specialty ?? null,
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
    // an assistant head also has the department dashboard; only the head has head_of
    (user.dashboard === 'head' && user.headOf && user.role !== 'manager' ? 'head' : 'member')
  const department = placement?.department ?? (position === 'head' ? user.headOf : undefined)
  const specialty = placement?.specialty?.trim() || null
  // the role tag says "Doctor · Dentist"; a head's tag names the department instead
  const headLabel = user.dashboard === 'head' && !!user.headOf

  return (
    <section
      aria-label={t('identity.aria', { name: user.name })}
      className={cn(
        'anim-enter flex flex-none flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-l-[3px] py-3 pr-4 pl-4',
        tileClass[look.tint],
        edgeClass[look.tint],
      )}
    >
      <span className="relative flex-none">
        <Avatar name={user.name} size="xl" className="bg-card" />
        <span
          className={cn(
            'ring-card absolute -right-1 -bottom-1 inline-flex size-5 items-center justify-center rounded-full text-white ring-2',
            stripeClass[look.tint],
          )}
        >
          <RoleIcon size={11} aria-hidden="true" />
        </span>
      </span>

      <div className="min-w-[180px] flex-1">
        <h1 className="text-ink m-0 text-[24px] leading-8 font-semibold break-words">
          {user.name}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'bg-card inline-flex h-6 items-center gap-1 rounded border px-2 text-[12px] leading-none font-medium',
              tagClass[look.tint],
              'bg-card',
            )}
          >
            <RoleIcon size={12} aria-hidden="true" />
            {roleLabel(user, t, specialty)}
          </span>
          {specialty && headLabel && <Chip icon={Award}>{specialty}</Chip>}
          {placement && placement.departments.length > 1 ? (
            placement.departments.map((x) => (
              <Chip key={x.name} icon={Building2}>
                {x.name}
                {x.position !== 'member' ? ` · ${t(`staff.positions.${x.position}`)}` : ''}
              </Chip>
            ))
          ) : (
            <>
              {department && <Chip icon={Building2}>{department}</Chip>}
              {placement && position !== 'member' && (
                <Chip icon={Award}>{t(`staff.positions.${position}`)}</Chip>
              )}
            </>
          )}
          {user.station && (user.role !== 'doctor' || specialty || headLabel) && (
            <Chip icon={MapPin}>{user.station}</Chip>
          )}
          {user.staffId && (
            <Chip icon={IdCard}>
              <span className="tabular-nums">{user.staffId}</span>
            </Chip>
          )}
        </div>
      </div>

      <div className="flex flex-row flex-wrap items-center gap-x-3 gap-y-1 text-[14px] sm:flex-col sm:items-end sm:gap-y-1">
        <span className="text-ink-2">{greeting}</span>
        <span className="text-ink-2 inline-flex items-center gap-1.5">
          <CalendarDays size={14} aria-hidden="true" className="text-ink-3" />
          {dayNames.long[now.getDay()]} {formatDate(now)}
        </span>
        {status && (
          <span
            className={cn(
              'bg-card inline-flex h-6 items-center gap-1.5 rounded border px-2 text-[12px] leading-none font-medium',
              status.open ? 'border-green/30 text-green' : 'border-red/30 text-red',
            )}
          >
            <span
              // open: the dot breathes (the clinic is live)
              className={cn(
                'size-1.5 rounded-full',
                status.open ? 'bg-green-dot text-green-dot anim-pulse-dot' : 'bg-red-dot',
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
    <span className="border-border text-ink-2 bg-card inline-flex h-6 items-center gap-1 rounded border px-2 text-[12px] leading-none font-medium">
      <IconC size={12} aria-hidden="true" className="text-ink-3" />
      {children}
    </span>
  )
}
