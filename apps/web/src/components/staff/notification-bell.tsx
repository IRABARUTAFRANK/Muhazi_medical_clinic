import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Bell, BellRing, CheckCheck, Inbox, Megaphone, Send, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StaffUser } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/select'
import { useNotificationActions, useNotifications, type Notice } from '@/lib/api/notifications'
import { useAgo, useWording } from '@/lib/notice-wording'
import { DB_ROLES, useDepartments, useEmployees, useLeadDepartments } from '@/lib/api/staff'
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
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openNotice = (n: Notice) => {
    if (!n.read) actions.markRead.mutate([n.id])
    if (n.link) {
      setOpen(false)
      const [path, query] = n.link.split('?')
      void navigate({ href: query ? `${path}?${query}` : path! })
    }
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
          'relative inline-flex size-11 items-center justify-center rounded-xl text-white/85 transition-colors hover:bg-white/10 hover:text-white',
          open && 'bg-white/15 text-white',
        )}
      >
        {unread > 0 ? (
          <BellRing size={20} aria-hidden="true" className="bell-ring" />
        ) : (
          <Bell size={20} aria-hidden="true" />
        )}
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-[#e5484d] px-1 text-[10px] leading-[18px] font-bold text-white tabular-nums ring-2 ring-[#13306b]">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('notify.title')}
          className="anim-enter text-ink bg-card shadow-sheet fixed inset-x-2 top-[112px] z-50 flex max-h-[min(560px,70dvh)] flex-col overflow-hidden rounded-2xl sm:absolute sm:inset-x-auto sm:top-[calc(100%+8px)] sm:right-0 sm:w-[min(400px,92vw)]"
        >
          <div className="border-border flex items-center gap-2 border-b px-4 py-3">
            <span className="flex-1 text-[15px] font-bold">{t('notify.title')}</span>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={() => setOpen(false)}
              className="text-ink-3 hover:bg-hover hover:text-ink order-last inline-flex size-9 items-center justify-center rounded-lg sm:hidden"
            >
              <X size={18} aria-hidden="true" />
            </button>
            {unread > 0 && (
              <button
                type="button"
                className="text-primary inline-flex min-h-9 items-center gap-1 rounded-lg px-1.5 text-xs font-semibold whitespace-nowrap"
                aria-label={t('notify.markAll')}
                title={t('notify.markAll')}
                onClick={() => actions.markRead.mutate(null)}
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
            {items.map((n) => {
              const w = word(n)
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openNotice(n)}
                  className={cn(
                    'border-border hover:bg-hover flex w-full items-start gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0',
                    !n.read && 'bg-primary-tint/50',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1.5 size-2 flex-none rounded-full',
                      n.read ? 'bg-transparent' : n.urgent ? 'bg-[#e5484d]' : 'bg-primary',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn('block text-[13px] leading-snug', !n.read && 'font-semibold')}
                    >
                      {n.kind === 'message' && (
                        <Megaphone
                          size={13}
                          aria-hidden="true"
                          className="mr-1 inline text-[#b45309]"
                        />
                      )}
                      {w.title}
                    </span>
                    {w.body && (
                      <span className="text-ink-2 mt-0.5 block text-xs leading-snug">{w.body}</span>
                    )}
                    <span className="text-ink-3 mt-1 block text-[11px]">
                      {ago(n.at)}
                      {n.kind === 'message' && n.sender
                        ? ` · ${t('notify.from', { name: n.sender })}`
                        : ''}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void navigate({ to: '/app/notifications' })
            }}
            className="border-border text-primary hover:bg-hover flex items-center justify-center gap-1.5 border-t px-4 py-2.5 text-[13px] font-semibold"
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
      className="border-border bg-surface flex flex-col gap-2.5 border-b px-4 py-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-bold">{t('notify.compose')}</span>
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
      {to === 'department' && (
        <label className="flex items-center gap-2 text-xs font-semibold">
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
      <label className="text-ink-2 flex flex-col gap-1.5 text-[13px] font-semibold">
        {t('notify.message')}
        <textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="border-border bg-card text-ink focus:border-primary focus:ring-primary-tint rounded-lg border px-3 py-2 text-[14px] font-normal outline-none focus:ring-[3px]"
        />
      </label>
      <label className="flex items-center gap-2 text-xs font-semibold">
        <input
          type="checkbox"
          className="accent-red"
          checked={urgent}
          onChange={(e) => setUrgent(e.target.checked)}
        />
        {t('notify.urgent')}
      </label>
      {error && (
        <p className="bg-red-bg text-red m-0 rounded-lg px-3 py-2 text-xs font-semibold">{error}</p>
      )}
      {sent && <p className="text-green m-0 text-xs font-semibold">{t('notify.sent')}</p>}
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
