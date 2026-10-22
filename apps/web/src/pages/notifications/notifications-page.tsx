import { useState, type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRightLeft,
  Bell,
  FlaskConical,
  HeartHandshake,
  CalendarCheck,
  CalendarX,
  CheckCheck,
  EyeOff,
  Inbox,
  ListTodo,
  Megaphone,
  MessageSquare,
  Send,
  Siren,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Empty, IconChip, Panel } from '@/components/dash/kit'
import { type Tint } from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button } from '@/components/ui/button'
import { ListBar, Pager, ShownList } from '@/components/ui/list-tools'
import { Composer } from '@/components/staff/notification-bell'
import { useLeadDepartments } from '@/lib/api/staff'
import { StaffShell } from '@/components/staff/staff-shell'
import {
  useNotificationActions,
  useNotifications,
  useSentNotifications,
  type Notice,
} from '@/lib/api/notifications'
import { navForUser } from '@/lib/nav'
import { useAgo, useWording } from '@/lib/notice-wording'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'unread' | 'urgent' | 'patients' | 'messages'

const KIND_LOOK: Record<string, { icon: LucideIcon; tint: Tint }> = {
  queue: { icon: Users, tint: 'amber' },
  referral: { icon: ArrowRightLeft, tint: 'violet' },
  result: { icon: FlaskConical, tint: 'mint' },
  cover: { icon: HeartHandshake, tint: 'mint' },
  task: { icon: ListTodo, tint: 'teal' },
  inquiry: { icon: MessageSquare, tint: 'violet' },
  to_accept: { icon: CalendarCheck, tint: 'navy' },
  appt_confirmed: { icon: CalendarCheck, tint: 'mint' },
  booked_arrived: { icon: CalendarCheck, tint: 'teal' },
  appt_declined: { icon: CalendarX, tint: 'coral' },
  message: { icon: Megaphone, tint: 'coral' },
}
const lookOf = (n: Notice) =>
  n.urgent ? { icon: Siren, tint: 'coral' as Tint } : (KIND_LOOK[n.kind] ?? KIND_LOOK.message!)

/**
 * Notifications in one place for every role: filter (unread, urgent, patients, messages), open
 * what a notice is about, mark read, remove from my list (one by one or selected). The manager
 * also writes messages here and sees what was sent, how many have read it, and can delete it.
 */
export function NotificationsPage({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data } = useNotifications(200)
  const actions = useNotificationActions()
  // the manager, and heads / assistant heads for their own department
  const leads = useLeadDepartments(user)
  const canSend = user.role === 'manager' || leads.length > 0
  const { data: sent = [] } = useSentNotifications(canSend)
  const ago = useAgo()
  const word = useWording()
  const [tab, setTab] = useState<'inbox' | 'sent'>('inbox')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [composing, setComposing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const items = data?.items ?? []
  const unread = data?.unread ?? 0

  const filtered = items.filter((n) =>
    filter === 'unread'
      ? !n.read
      : filter === 'urgent'
        ? n.urgent
        : filter === 'messages'
          ? n.kind === 'message'
          : filter === 'patients'
            ? n.kind !== 'message'
            : true,
  )
  // Search the wording, then 20 per page.
  const shown = filtered.filter((n) => {
    const w = word(n)
    return matches(query, w.title, w.body, n.sender)
  })
  const paged = usePaged(shown, 20, `${filter}|${query}`)
  const allPicked = shown.length > 0 && shown.every((n) => selected.includes(n.id))
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const open = (n: Notice) => {
    if (!n.read) actions.markRead.mutate([n.id])
    if (n.link) {
      const [path, query] = n.link.split('?')
      void navigate({ href: query ? `${path}?${query}` : path! })
    }
  }
  const counts: Record<Filter, number> = {
    all: items.length,
    unread,
    urgent: items.filter((n) => n.urgent).length,
    patients: items.filter((n) => n.kind !== 'message').length,
    messages: items.filter((n) => n.kind === 'message').length,
  }

  return (
    <StaffShell user={user} nav={navForUser(user)} activeId="notifications">
      <main className="pc:px-8 pc:pb-10 flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <PageBanner
          icon={Bell}
          tint="amber"
          title={t('notices.title')}
          lead={t(canSend ? 'notices.leadManager' : 'notices.lead')}
          meta={<BannerChip icon={Inbox}>{t('notices.unreadCount', { count: unread })}</BannerChip>}
        >
          <Button
            disabled={unread === 0 || actions.markRead.isPending}
            onClick={() => void run(() => actions.markRead.mutateAsync(null))}
          >
            <CheckCheck size={16} aria-hidden="true" />
            {t('notify.markAll')}
          </Button>
          {canSend && (
            <Button variant="primary" onClick={() => setComposing((c) => !c)}>
              <Megaphone size={16} aria-hidden="true" />
              {t('notify.compose')}
            </Button>
          )}
        </PageBanner>

        {composing && canSend && (
          <div className="bg-card shadow-card anim-enter overflow-hidden rounded-[16px]">
            <Composer
              onClose={() => setComposing(false)}
              leads={user.role === 'manager' ? undefined : leads}
            />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="bg-red-bg text-red m-0 rounded-xl px-3 py-2 text-[14px] font-semibold"
          >
            {error}
          </p>
        )}

        {canSend && (
          <div className="flex gap-1 self-start rounded-xl bg-white/70 p-1" role="tablist">
            {(['inbox', 'sent'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  'inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-[14px] font-semibold',
                  tab === k ? 'bg-navy text-white' : 'text-ink-2 hover:bg-hover',
                )}
              >
                {k === 'inbox' ? (
                  <Inbox size={16} aria-hidden="true" />
                ) : (
                  <Send size={16} aria-hidden="true" />
                )}
                {t(`notices.tabs.${k}`)}
              </button>
            ))}
          </div>
        )}

        {tab === 'inbox' && (
          <Panel
            i={1}
            icon={Inbox}
            tint="amber"
            title={t('notices.inbox')}
            right={t('notices.shown', { count: shown.length })}
          >
            <ListBar query={query} onQuery={setQuery} placeholderKey="list.searchNotices" />
            {/* Filters */}
            <div className="flex flex-wrap gap-2">
              {(['all', 'unread', 'urgent', 'patients', 'messages'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => {
                    setFilter(f)
                    setSelected([])
                  }}
                  className={cn(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold',
                    filter === f
                      ? 'border-primary bg-primary text-white'
                      : 'border-border bg-card text-ink-2 hover:bg-hover',
                  )}
                >
                  {t(`notices.filters.${f}`)}
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-[12px] tabular-nums',
                      filter === f ? 'bg-white/20' : 'bg-hover',
                    )}
                  >
                    {counts[f]}
                  </span>
                </button>
              ))}
            </div>

            {/* Bulk actions */}
            {shown.length > 0 && (
              <div className="border-border flex flex-wrap items-center gap-2 border-y py-2">
                <label className="inline-flex items-center gap-2 text-[14px] font-semibold">
                  <input
                    type="checkbox"
                    className="accent-primary size-4"
                    checked={allPicked}
                    onChange={(e) => setSelected(e.target.checked ? shown.map((n) => n.id) : [])}
                  />
                  {t('notices.selectAll')}
                </label>
                <span className="flex-1" />
                <Button
                  size="sm"
                  disabled={selected.length === 0}
                  onClick={() =>
                    void run(async () => {
                      await actions.markRead.mutateAsync(selected)
                      setSelected([])
                    })
                  }
                >
                  <CheckCheck size={14} aria-hidden="true" />
                  {t('notices.markSelected', { count: selected.length })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={selected.length === 0}
                  onClick={() =>
                    void run(async () => {
                      await actions.hide.mutateAsync(selected)
                      setSelected([])
                    })
                  }
                >
                  <EyeOff size={14} aria-hidden="true" />
                  {t('notices.removeSelected', { count: selected.length })}
                </Button>
              </div>
            )}

            {shown.length === 0 ? (
              <Empty icon={Inbox}>{t('notices.empty')}</Empty>
            ) : (
              <div className="flex flex-col">
                {paged.slice.map((n, i) => {
                  const w = word(n)
                  const look = lookOf(n)
                  return (
                    <div
                      key={n.id}
                      className={cn(
                        'border-grid anim-enter flex flex-wrap items-start gap-3 border-b py-3 last:border-b-0',
                        !n.read && 'bg-primary-tint/30 -mx-2 rounded-lg px-2',
                      )}
                      style={{ '--i': Math.min(i, 12) } as CSSProperties}
                    >
                      <input
                        type="checkbox"
                        aria-label={w.title}
                        className="accent-primary mt-2 size-4 flex-none"
                        checked={selected.includes(n.id)}
                        onChange={(e) =>
                          setSelected((s) =>
                            e.target.checked ? [...s, n.id] : s.filter((x) => x !== n.id),
                          )
                        }
                      />
                      <IconChip icon={look.icon} tint={look.tint} />
                      <span className="min-w-0 flex-[1_1_200px]">
                        <span
                          className={cn(
                            'flex items-center gap-2 text-[15px]',
                            !n.read ? 'font-bold' : 'font-semibold',
                          )}
                        >
                          {!n.read && <span className="bg-primary size-2 flex-none rounded-full" />}
                          {w.title}
                        </span>
                        {w.body && (
                          <span className="text-ink-2 block text-[14px] leading-snug">
                            {w.body}
                          </span>
                        )}
                        <span className="text-ink-3 mt-1 block text-[13px]">
                          {ago(n.at)}
                          {n.sender ? ` · ${t('notify.from', { name: n.sender })}` : ''}
                        </span>
                      </span>
                      <span className="ml-auto flex flex-none flex-wrap justify-end gap-1 pl-7 sm:pl-0">
                        {n.link && (
                          <Button size="sm" variant="primary" onClick={() => open(n)}>
                            {t('common.open')}
                          </Button>
                        )}
                        {!n.read && (
                          <Button
                            size="sm"
                            aria-label={t('notices.markRead')}
                            title={t('notices.markRead')}
                            onClick={() => void run(() => actions.markRead.mutateAsync([n.id]))}
                          >
                            <CheckCheck size={14} aria-hidden="true" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('notices.remove')}
                          title={t('notices.remove')}
                          onClick={() => void run(() => actions.hide.mutateAsync([n.id]))}
                        >
                          <EyeOff size={14} aria-hidden="true" />
                        </Button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            <Pager {...paged} onPage={paged.setPage} />
          </Panel>
        )}

        {tab === 'sent' && canSend && (
          <Panel
            i={1}
            icon={Send}
            tint="violet"
            title={t('notices.sentTitle')}
            right={t('notices.shown', { count: sent.length })}
          >
            {sent.length === 0 ? (
              <Empty icon={Send}>{t('notices.noneSent')}</Empty>
            ) : (
              <ShownList items={sent} step={10}>
                {(shown) => (
                  <div className="flex flex-col">
                    {shown.map((m, i) => (
                      <div
                        key={m.id}
                        className="border-grid anim-enter flex items-start gap-3 border-b py-3 last:border-b-0"
                        style={{ '--i': Math.min(i, 12) } as CSSProperties}
                      >
                        <IconChip
                          icon={m.urgent ? Siren : Megaphone}
                          tint={m.urgent ? 'coral' : 'violet'}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] font-semibold">{m.title}</span>
                          {m.body && <span className="text-ink-2 block text-[14px]">{m.body}</span>}
                          <span className="text-ink-3 mt-1 flex flex-wrap items-center gap-x-3 text-[13px]">
                            <span>{ago(m.at)}</span>
                            <span className="inline-flex items-center gap-1">
                              <Users size={12} aria-hidden="true" />
                              {m.to === 'all'
                                ? t('notify.toAll')
                                : m.to === 'role'
                                  ? t(`staff.roles.${m.target}`, { defaultValue: m.target ?? '' })
                                  : (m.target ?? '')}
                              {m.headsOnly ? ` · ${t('notify.headsOnly')}` : ''}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <CheckCheck size={12} aria-hidden="true" />
                              {t('notices.readBy', { count: m.readBy })}
                            </span>
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (window.confirm(t('notices.confirmDelete')))
                              void run(() => actions.remove.mutateAsync(m.id))
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {t('notices.delete')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </ShownList>
            )}
          </Panel>
        )}
      </main>
    </StaffShell>
  )
}
