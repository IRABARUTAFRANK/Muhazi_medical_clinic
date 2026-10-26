import type { CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRightLeft,
  Bell,
  FlaskConical,
  HeartHandshake,
  CalendarCheck,
  CalendarX,
  CheckCheck,
  ListTodo,
  LockKeyhole,
  Megaphone,
  MessageSquare,
  ShieldCheck,
  Siren,
  UserRoundCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, buttonVariants } from '@/components/ui/button'
import { StaffLink } from '@/components/staff/staff-link'
import { useNotificationActions, useNotifications, type Notice } from '@/lib/api/notifications'
import { useConfirm } from '@/lib/confirm'
import { useAgo, useWording } from '@/lib/notice-wording'
import { cn } from '@/lib/utils'
import { Empty, IconChip, Panel } from './kit'
import type { Tint } from './kit-style'

const LOOK: Record<string, { icon: LucideIcon; tint: Tint }> = {
  queue: { icon: Users, tint: 'amber' },
  queue_pool: { icon: Users, tint: 'violet' },
  referral: { icon: ArrowRightLeft, tint: 'violet' },
  result: { icon: FlaskConical, tint: 'mint' },
  // 0088: a patient handed over to me, the answer to mine, a handover withdrawn (the 'cover'
  // notices from before 0088 keep their look)
  handover: { icon: UserRoundCheck, tint: 'violet' },
  handover_answer: { icon: UserRoundCheck, tint: 'mint' },
  handover_cancelled: { icon: UserRoundCheck, tint: 'navy' },
  cover: { icon: HeartHandshake, tint: 'mint' },
  task: { icon: ListTodo, tint: 'teal' },
  inquiry: { icon: MessageSquare, tint: 'violet' },
  to_accept: { icon: CalendarCheck, tint: 'navy' },
  appt_confirmed: { icon: CalendarCheck, tint: 'mint' },
  booked_arrived: { icon: CalendarCheck, tint: 'teal' },
  appt_declined: { icon: CalendarX, tint: 'coral' },
  message: { icon: Megaphone, tint: 'coral' },
  // 0088: past records (a request to answer, the answer, an emergency access)
  access_request: { icon: LockKeyhole, tint: 'amber' },
  access_answer: { icon: ShieldCheck, tint: 'mint' },
  access_emergency: { icon: Siren, tint: 'coral' },
}

/**
 * Notifications on every dashboard: the latest notices for this person (unread first), open what
 * one is about, mark all read, or go to the full Notifications page.
 */
export function NoticesPanel({
  i = 1,
  limit = 5,
  className,
}: {
  i?: number
  limit?: number
  className?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data } = useNotifications()
  const actions = useNotificationActions()
  const confirm = useConfirm()
  const ago = useAgo()
  const word = useWording()
  const items = [...(data?.items ?? [])]
    .sort((a, b) => Number(a.read) - Number(b.read))
    .slice(0, limit)
  const unread = data?.unread ?? 0
  const open = (n: Notice) => {
    if (!n.read) actions.markRead.mutate([n.id])
    if (n.link) {
      const [path, query] = n.link.split('?')
      void navigate({ href: query ? `${path}?${query}` : path! })
    }
  }
  return (
    <Panel
      i={i}
      icon={Bell}
      tint="amber"
      title={t('notify.title')}
      right={t('notices.unreadCount', { count: unread })}
      className={className}
    >
      {items.length === 0 ? (
        <Empty icon={Bell}>{t('notify.empty')}</Empty>
      ) : (
        <div className="flex flex-col">
          {items.map((n, k) => {
            const w = word(n)
            const look = n.urgent
              ? { icon: Siren, tint: 'coral' as Tint }
              : (LOOK[n.kind] ?? LOOK.message!)
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => open(n)}
                // a new (unread) notice slides in; read ones are simply there
                className={cn(
                  'border-grid hover:bg-hover flex w-full items-start gap-3 border-b py-2 text-left transition-colors duration-120 last:border-b-0',
                  !n.read && 'anim-slide-in',
                )}
                style={{ '--i': k } as CSSProperties}
              >
                <IconChip icon={look.icon} tint={look.tint} size="sm" />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'flex items-center gap-1.5 text-[14px] leading-snug',
                      !n.read && 'font-semibold',
                    )}
                  >
                    {/* unread: a teal dot, not a tinted row */}
                    {!n.read && (
                      <span
                        aria-hidden="true"
                        className="bg-primary size-1.5 flex-none rounded-full"
                      />
                    )}
                    <span className="min-w-0">{w.title}</span>
                  </span>
                  {w.body && (
                    <span className="text-ink-2 block truncate text-[13px]">{w.body}</span>
                  )}
                  <span className="text-ink-3 block text-[12px]">{ago(n.at)}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      <span className="flex flex-wrap gap-2">
        <StaffLink
          to="/app/notifications"
          className={cn(buttonVariants({ size: 'sm' }), 'self-start')}
        >
          {t('notices.manage')} →
        </StaffLink>
        {unread > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (
                !(await confirm({
                  title: t('confirm.notices.markAll.title', { count: unread }),
                  body: t('confirm.notices.markAll.body'),
                  confirmLabel: t('confirm.notices.markAll.yes'),
                }))
              )
                return
              actions.markRead.mutate(null)
            }}
          >
            <CheckCheck size={14} aria-hidden="true" />
            {t('notify.markAll')}
          </Button>
        )}
      </span>
    </Panel>
  )
}
