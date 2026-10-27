import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Bell, BellRing, CheckCheck, Inbox, Megaphone, Send, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { controlClass, Field, labelClass } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { useNotificationActions, useNotifications, type Notice } from '@/lib/api/notifications'
import { useAgo, useWording } from '@/lib/notice-wording'
import { useOpenNotice } from '@/lib/notice-target'
import { NoticeBookingAnswer } from '@/pages/home/booking-answer'
import { DB_ROLES, useDepartments, useEmployees, useLeadDepartments } from '@/lib/api/staff'
import { useConfirm } from '@/lib/confirm'
import { headerBand } from '@/components/dash/kit-style'
import { cn } from '@/lib/utils'

/**
 * Bell in the staff top bar. Each person sees only what is for them (their name, role,
 * department, or everyone); the count shows the unread ones. Clicking a notice marks it read and
 * opens the screen it is about. The manager can also write to everyone, a role, a department
 * (or its heads) or one person.
 */
export function NotificationBell({ user }: { user: StaffUser }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data } = useNotifications()
  const actions = useNotificationActions()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [composing, setComposing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const ago = useAgo()
  const word = useWording()
  const unread = data?.unread ?? 0
  const items = data?.items ?? []
  // the manager writes to anyone; a head or assistant head to their own department(s)
  const leads = useLeadDepartments(user)
  const canSend = user.role === 'manager' || leads.length > 0

  useEffect(() => {
    if (!open) return
    // The "Are you sure?" box sits outside the bell: a click or Escape there answers it and
    // leaves the bell open (the backdrop may already be gone when the click reaches here).
    const asking = (e: Event) =>
      document.querySelector('[role="alertdialog"]') !== null ||
      !(e.target as Node | null)?.isConnected
    const onDown = (e: MouseEvent) => {
      if (asking(e)) return
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !asking(e) && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // the exact place a notice is about (a visit, a booking on Home, a stock note…), marked read
  const notice = useOpenNotice()
  const openNotice = (n: Notice) => {
    if (notice.target(n)) setOpen(false)
    notice.open(n)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t('notify.open', { count: unread })}
        title={t('notify.title')}
        className={cn(
          'text-ink-2 hover:bg-hover hover:text-ink focus-visible:ring-primary/20 relative inline-flex size-9 items-center justify-center rounded-md transition-colors duration-120 focus-visible:ring-2 focus-visible:outline-none',
          open && 'bg-hover text-ink',
        )}
      >
        {unread > 0 ? (
          <BellRing size={18} aria-hidden="true" />
        ) : (
          <Bell size={18} aria-hidden="true" />
        )}
        {unread > 0 && (
          <span className="bg-red-dot ring-card absolute top-0.5 right-0.5 inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold text-white tabular-nums ring-2">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('notify.title')}
          className="text-ink bg-card border-card-border shadow-panel anim-dialog rounded-lg2 fixed inset-x-2 top-[100px] z-50 flex max-h-[min(560px,70dvh)] flex-col overflow-hidden border sm:absolute sm:inset-x-auto sm:top-[calc(100%+6px)] sm:right-0 sm:w-[min(400px,92vw)]"
        >
          {/* the header on the amber band of every notices panel */}
          <div
            className={cn(
              'border-border flex min-h-10 items-center gap-2 border-b px-3 py-1.5',
              headerBand('amber'),
            )}
          >
            <span className="flex-1 text-[16px] font-semibold">{t('notify.title')}</span>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={() => setOpen(false)}
              className="text-ink-3 hover:bg-hover hover:text-ink order-last inline-flex size-7 items-center justify-center rounded-md sm:hidden"
            >
              <X size={16} aria-hidden="true" />
            </button>
            {unread > 0 && (
              <button
                type="button"
                className="text-primary hover:bg-hover inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium whitespace-nowrap"
                aria-label={t('notify.markAll')}
                title={t('notify.markAll')}
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
                <CheckCheck size={16} aria-hidden="true" />
                <span className="hidden sm:inline">{t('notify.markAll')}</span>
              </button>
            )}
            {canSend && !composing && (
              <Button
                size="sm"
                aria-label={t('notify.compose')}
                title={t('notify.compose')}
                onClick={() => setComposing(true)}
              >
                <Megaphone size={14} aria-hidden="true" />
                <span className="hidden sm:inline">{t('notify.compose')}</span>
              </Button>
            )}
          </div>

          {composing && (
            <Composer
              onClose={() => setComposing(false)}
              leads={user.role === 'manager' ? undefined : leads}
            />
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {items.length === 0 && (
              <p className="text-ink-3 m-0 px-4 py-8 text-center text-[13px]">
                {t('notify.empty')}
              </p>
            )}
            {items.map((n, k) => {
              const w = word(n)
              return (
                <div
                  key={n.id}
                  // a new (unread) notice slides in; read ones are simply there
                  className={cn(
                    'border-grid border-b last:border-b-0',
                    !n.read && k < 8 && 'anim-slide-in',
                  )}
                  style={{ '--i': k } as CSSProperties}
                >
                  <button
                    type="button"
                    onClick={() => openNotice(n)}
                    className="hover:bg-hover flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-120"
                  >
                    {/* unread: a dot (red when urgent), not a tinted row */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1.5 size-1.5 flex-none rounded-full',
                        n.read ? 'bg-transparent' : n.urgent ? 'bg-red-dot' : 'bg-primary',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn('block text-[14px] leading-snug', !n.read && 'font-semibold')}
                      >
                        {n.kind === 'message' && (
                          <Megaphone
                            size={13}
                            aria-hidden="true"
                            className="text-yellow mr-1 inline"
                          />
                        )}
                        {w.title}
                      </span>
                      {w.body && (
                        <span className="text-ink-2 mt-0.5 block text-[13px] leading-snug">
                          {w.body}
                        </span>
                      )}
                      <span className="text-ink-3 mt-1 block text-[12px]">
                        {ago(n.at)}
                        {n.kind === 'message' && n.sender
                          ? ` · ${t('notify.from', { name: n.sender })}`
                          : ''}
                      </span>
                    </span>
                  </button>
                  {/* a booking to accept is answered here (Accept / Another time / Decline) */}
                  <NoticeBookingAnswer
                    notice={n}
                    className="px-3 pb-2.5 pl-7"
                    onLeave={() => setOpen(false)}
                  />
                </div>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void navigate({ to: '/app/notifications' })
            }}
            className="border-border text-primary hover:bg-hover flex min-h-10 items-center justify-center gap-1.5 border-t px-4 text-[14px] font-medium"
          >
            <Inbox size={14} aria-hidden="true" />
            {t('notices.manage')}
          </button>
        </div>
      )}
    </div>
  )
}

export function Composer({
  onClose,
  leads,
}: {
  onClose: () => void
  /** For a head of department: only their department(s). */
  leads?: { id: string; name: string }[]
}) {
  const { t } = useTranslation()
  const actions = useNotificationActions()
  const confirm = useConfirm()
  const { data: allDepartments = [] } = useDepartments()
  const { data: employees = [] } = useEmployees()
  const departments = leads ?? allDepartments
  const [to, setTo] = useState<'all' | 'role' | 'department' | 'user'>(leads ? 'department' : 'all')
  const [target, setTarget] = useState(leads?.length === 1 ? leads[0]!.id : '')
  const [headsOnly, setHeadsOnly] = useState(false)
  const [urgent, setUrgent] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (to !== 'all' && !target) return setError(t('notify.errors.target'))
    // who receives it, in words: a role, a department or one person (everyone has its own line)
    const who =
      to === 'role'
        ? t(`staff.roles.${target}`, { defaultValue: target })
        : to === 'department'
          ? (departments.find((d) => d.id === target)?.name ?? '')
          : (employees.find((x) => x.id === target)?.fullName ?? '')
    const heads = headsOnly && (to === 'all' || to === 'department')
    const ask = `confirm.notices.send.${
      to === 'all'
        ? heads
          ? 'allHeads'
          : 'all'
        : to === 'department'
          ? heads
            ? 'deptHeads'
            : 'dept'
          : to === 'role'
            ? 'role'
            : 'person'
    }`
    if (
      !(await confirm({
        title: t(ask, { title: title.trim(), who }),
        body: t(urgent ? 'confirm.notices.send.bodyUrgent' : 'confirm.notices.send.body'),
        confirmLabel: t('confirm.notices.send.yes'),
      }))
    )
      return
    try {
      await actions.send.mutateAsync({
        to,
        target: to === 'all' ? null : target,
        title,
        body,
        headsOnly,
        urgent,
      })
      setTitle('')
      setBody('')
      setSent(true)
      setTimeout(onClose, 900)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-border bg-surface flex flex-col gap-2.5 border-b px-3 py-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-semibold">{t('notify.compose')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('staff.form.cancel')}
          className="text-ink-3 hover:text-ink"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          label={t('notify.to')}
          value={to}
          onChange={(e) => {
            setTo(e.target.value as typeof to)
            setTarget('')
          }}
        >
          {!leads && <option value="all">{t('notify.toAll')}</option>}
          {!leads && <option value="role">{t('notify.toRole')}</option>}
          <option value="department">{t('notify.toDept')}</option>
          {!leads && <option value="user">{t('notify.toUser')}</option>}
        </Select>
        {to === 'role' && (
          <Select
            label={t('staff.form.role')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">—</option>
            {DB_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`staff.roles.${r}`)}
              </option>
            ))}
          </Select>
        )}
        {to === 'department' && (
          <Select
            label={t('staff.form.department')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
        {to === 'user' && (
          <Select
            label={t('notify.person')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">—</option>
            {employees
              .filter((x) => x.active)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.fullName}
                </option>
              ))}
          </Select>
        )}
      </div>
      {/* to a department: its heads only; to everyone (the manager): every head of department */}
      {(to === 'department' || to === 'all') && (
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <input
            type="checkbox"
            className="accent-primary"
            checked={headsOnly}
            onChange={(e) => setHeadsOnly(e.target.checked)}
          />
          {t('notify.headsOnly')}
        </label>
      )}
      <Field
        label={t('notify.subject')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      <label className={labelClass}>
        {t('notify.message')}
        <textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={cn(controlClass, 'h-auto py-1.5')}
        />
      </label>
      <label className="flex items-center gap-2 text-[13px] font-medium">
        <input
          type="checkbox"
          className="accent-red"
          checked={urgent}
          onChange={(e) => setUrgent(e.target.checked)}
        />
        {t('notify.urgent')}
      </label>
      {error && (
        <p className="border-red/25 bg-red-bg text-red m-0 rounded-md border px-3 py-1.5 text-[12px] font-medium">
          {error}
        </p>
      )}
      {sent && (
        <p className="text-green m-0 flex items-center gap-1 text-[12px] font-medium">
          <CheckCheck size={14} aria-hidden="true" className="anim-pop" />
          {t('notify.sent')}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        className="self-start"
        loading={actions.send.isPending}
      >
        <Send size={14} aria-hidden="true" />
        {t('notify.send')}
      </Button>
    </form>
  )
}
