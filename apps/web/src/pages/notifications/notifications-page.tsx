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
  CircleAlert,
  EyeOff,
  Inbox,
  ListTodo,
  LockKeyhole,
  Megaphone,
  MessageSquare,
  ShieldCheck,
  Send,
  Siren,
  Trash2,
  UserRoundCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Empty, IconChip, Panel } from '@/components/dash/kit'
import { card, type Tint } from '@/components/dash/kit-style'
import { BannerChip, PageBanner } from '@/components/dash/page-banner'
import { Button } from '@/components/ui/button'
import { SidePanel, useSidePanelState } from '@/components/ui/side-panel'
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
import { useConfirm, type ConfirmOptions } from '@/lib/confirm'
import { navForUser } from '@/lib/nav'
import { useAgo, useWording } from '@/lib/notice-wording'
import { matches, usePaged } from '@/lib/paging'
import { cn } from '@/lib/utils'

type Filter = 'all' | 'unread' | 'urgent' | 'patients' | 'messages'

const KIND_LOOK: Record<string, { icon: LucideIcon; tint: Tint }> = {
  queue: { icon: Users, tint: 'amber' },
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
  const confirm = useConfirm()
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
  // one notice opens in a side panel (grey) over the list; its row keeps a tint meanwhile
  const panel = useSidePanelState<Notice>((n) => n.id)
  const items = data?.items ?? []
  const inPanel = panel.item ? (items.find((x) => x.id === panel.item!.id) ?? panel.item) : null
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
  // Asked first; on yes, run as above.
  const ask = async (options: Omit<ConfirmOptions, 'input'>, fn: () => Promise<unknown>) => {
    if (await confirm(options)) await run(fn)
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
      <main className="pc:p-6 flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <PageBanner
          icon={Bell}
          tint="amber"
          title={t('notices.title')}
          lead={t(canSend ? 'notices.leadManager' : 'notices.lead')}
          meta={<BannerChip icon={Inbox}>{t('notices.unreadCount', { count: unread })}</BannerChip>}
        >
          <Button
            variant="tint-mint"
            disabled={unread === 0 || actions.markRead.isPending}
            onClick={() =>
              void ask(
                {
                  title: t('confirm.notices.markAll.title', { count: unread }),
                  body: t('confirm.notices.markAll.body'),
                  confirmLabel: t('confirm.notices.markAll.yes'),
                },
                () => actions.markRead.mutateAsync(null),
              )
            }
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
          <div className={cn(card, 'anim-enter gap-0 overflow-hidden p-0')}>
            <Composer
              onClose={() => setComposing(false)}
              leads={user.role === 'manager' ? undefined : leads}
            />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error}
          </p>
        )}

        {/* the segmented control of the kit: a grey track, the open tab a white tile in teal */}
        {canSend && (
          <div
            className="border-border bg-surface flex h-9 gap-0.5 self-start rounded-md border p-0.5"
            role="tablist"
          >
            {(['inbox', 'sent'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  'focus-visible:ring-primary/20 inline-flex items-center gap-2 rounded border px-3 text-[13px] font-medium transition-colors duration-120 outline-none focus-visible:ring-2',
                  tab === k
                    ? 'border-border bg-card text-primary'
                    : 'text-ink-2 hover:bg-hover hover:text-ink border-transparent',
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
                    'focus-visible:ring-primary/20 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors duration-120 outline-none focus-visible:ring-2',
                    filter === f
                      ? 'border-primary/30 bg-primary-tint text-primary'
                      : 'border-border bg-card text-ink-2 hover:bg-hover',
                  )}
                >
                  {t(`notices.filters.${f}`)}
                  <span
                    className={cn(
                      'rounded px-1.5 text-[12px] tabular-nums',
                      filter === f ? 'bg-card' : 'bg-hover',
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
                  variant="tint-mint"
                  disabled={selected.length === 0}
                  onClick={() =>
                    void ask(
                      {
                        title: t('confirm.notices.markSelected.title', {
                          count: selected.length,
                        }),
                        confirmLabel: t('confirm.notices.markAll.yes'),
                      },
                      async () => {
                        await actions.markRead.mutateAsync(selected)
                        setSelected([])
                      },
                    )
                  }
                >
                  <CheckCheck size={14} aria-hidden="true" />
                  {t('notices.markSelected', { count: selected.length })}
                </Button>
                <Button
                  size="sm"
                  variant="tint-coral"
                  disabled={selected.length === 0}
                  onClick={() =>
                    void ask(
                      {
                        title: t('confirm.notices.hideSelected.title', {
                          count: selected.length,
                        }),
                        body: t('confirm.notices.hide.body'),
                        confirmLabel: t('confirm.notices.hide.yes'),
                        tone: 'danger',
                      },
                      async () => {
                        await actions.hide.mutateAsync(selected)
                        setSelected([])
                      },
                    )
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
                        !n.read && 'bg-primary-tint/30 -mx-2 rounded-md px-2',
                        panel.isOpen(n) && 'bg-primary-tint/50 -mx-2 rounded-md px-2',
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
                        {/* the title opens the notice in the side panel */}
                        <button
                          type="button"
                          onClick={() => panel.show(n)}
                          className={cn(
                            'hover:text-primary flex items-center gap-2 text-left text-[14px] outline-none hover:underline focus-visible:underline',
                            !n.read ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {!n.read && <span className="bg-primary size-2 flex-none rounded-full" />}
                          {w.title}
                        </button>
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
                          <Button size="sm" variant="info" onClick={() => open(n)}>
                            {t('common.open')}
                          </Button>
                        )}
                        {!n.read && (
                          <Button
                            size="sm"
                            variant="tint-mint"
                            aria-label={t('notices.markRead')}
                            title={t('notices.markRead')}
                            onClick={() =>
                              void ask(
                                {
                                  title: t('confirm.notices.markOne.title', { title: w.title }),
                                  confirmLabel: t('confirm.notices.markAll.yes'),
                                },
                                () => actions.markRead.mutateAsync([n.id]),
                              )
                            }
                          >
                            <CheckCheck size={14} aria-hidden="true" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="tint-coral"
                          aria-label={t('notices.remove')}
                          title={t('notices.remove')}
                          onClick={() =>
                            void ask(
                              {
                                title: t('confirm.notices.hideOne.title', { title: w.title }),
                                body: t('confirm.notices.hide.body'),
                                confirmLabel: t('confirm.notices.hide.yes'),
                                tone: 'danger',
                              },
                              () => actions.hide.mutateAsync([n.id]),
                            )
                          }
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
                          <span className="block text-[14px] font-medium">{m.title}</span>
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
                          variant="tint-coral"
                          onClick={() =>
                            void ask(
                              {
                                title: t('confirm.notices.deleteSent.title', { title: m.title }),
                                body: t('confirm.notices.deleteSent.body'),
                                confirmLabel: t('confirm.notices.deleteSent.yes'),
                                tone: 'danger',
                              },
                              () => actions.remove.mutateAsync(m.id),
                            )
                          }
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

        {/* one notice, opened from its title: what it says, when, from whom; the same actions */}
        {inPanel && <NoticePanel notice={inPanel} open={panel.open} onClose={panel.close} />}
      </main>
    </StaffShell>
  )
}

/** One notice in a side panel (grey): the wording in full, then Open / Mark read / Remove. */
function NoticePanel({
  notice: n,
  open,
  onClose,
}: {
  notice: Notice
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const actions = useNotificationActions()
  const confirm = useConfirm()
  const ago = useAgo()
  const word = useWording()
  const w = word(n)
  const look = lookOf(n)
  const [error, setError] = useState<string | null>(null)
  const ask = async (options: Omit<ConfirmOptions, 'input'>, fn: () => Promise<unknown>) => {
    if (!(await confirm(options))) return
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const openLink = () => {
    if (!n.read) actions.markRead.mutate([n.id])
    onClose()
    if (n.link) {
      const [path, query] = n.link.split('?')
      void navigate({ href: query ? `${path}?${query}` : path! })
    }
  }
  return (
    <SidePanel
      open={open}
      onClose={onClose}
      hue="grey"
      icon={look.icon}
      title={w.title}
      subtitle={`${ago(n.at)}${n.sender ? ` · ${t('notify.from', { name: n.sender })}` : ''}`}
      tags={
        n.urgent ? (
          <span className="border-red/30 bg-red-bg text-red inline-flex h-6 items-center gap-1 rounded border px-2 text-[12px] font-medium">
            <Siren size={12} aria-hidden="true" />
            {t('notices.filters.urgent')}
          </span>
        ) : !n.read ? (
          <span className="border-primary/30 bg-primary-tint text-primary inline-flex h-6 items-center rounded border px-2 text-[12px] font-medium">
            {t('notices.filters.unread')}
          </span>
        ) : undefined
      }
      footer={
        <>
          {!n.read && (
            <Button
              size="sm"
              variant="tint-mint"
              disabled={actions.markRead.isPending}
              onClick={() =>
                void ask(
                  {
                    title: t('confirm.notices.markOne.title', { title: w.title }),
                    confirmLabel: t('confirm.notices.markAll.yes'),
                  },
                  () => actions.markRead.mutateAsync([n.id]),
                )
              }
            >
              <CheckCheck size={14} aria-hidden="true" />
              {t('notices.markRead')}
            </Button>
          )}
          <Button
            size="sm"
            variant="tint-coral"
            disabled={actions.hide.isPending}
            onClick={() =>
              void ask(
                {
                  title: t('confirm.notices.hideOne.title', { title: w.title }),
                  body: t('confirm.notices.hide.body'),
                  confirmLabel: t('confirm.notices.hide.yes'),
                  tone: 'danger',
                },
                async () => {
                  await actions.hide.mutateAsync([n.id])
                  onClose()
                },
              )
            }
          >
            <EyeOff size={14} aria-hidden="true" />
            {t('notices.remove')}
          </Button>
          {n.link && (
            <Button size="sm" variant="info" onClick={openLink}>
              {t('common.open')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className={cn(card, 'flex-row items-start gap-3')}>
          <IconChip icon={look.icon} tint={look.tint} />
          <p className="text-ink m-0 text-[14px] leading-relaxed">{w.body || w.title}</p>
        </div>
        {error && (
          <p
            role="alert"
            className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium"
          >
            <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
            {error}
          </p>
        )}
      </div>
    </SidePanel>
  )
}
