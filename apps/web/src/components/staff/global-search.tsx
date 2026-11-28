import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  BadgeCheck,
  CalendarClock,
  Clock,
  FileText,
  History,
  Loader2,
  Package,
  Receipt,
  Search,
  Stethoscope,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatRwf, formatTime, isoDate, type StaffUser } from '@mmc/shared'
import { Icon } from '@/components/ui/icon'
import { EMPTY_RESULTS, useQuickSearch } from '@/lib/api/quick-search'
import { navForUser } from '@/lib/nav'
import { fold, matchPages, pagesOf } from '@/lib/quick-search-pages'
import { cn } from '@/lib/utils'

/*
 * 0213: the search bar at the top of every screen suggests as one types, like a web search: the
 * patients, the pages and features of the menu, the visits, bills and receipts by their number,
 * the bookings, the employees (the manager) and the medicines (stock), a few of each. Arrows move,
 * Enter opens, Escape closes; Enter with nothing chosen lists every patient matching on the
 * patient register, as before. With nothing typed it shows what was opened last on this computer.
 */

interface Option {
  key: string
  icon: LucideIcon | string
  label: string
  sub?: string
  badge?: string
  to: string
  search?: Record<string, string>
}
interface Group {
  id: string
  title: string
  options: Option[]
}

const RECENT_MAX = 6
const recentKey = (userId: string) => `mmc.search.recent.${userId}`
type Recent = Omit<Option, 'icon'> & { icon: string }

function readRecent(userId: string): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(userId)) ?? '[]') as Recent[]
    return Array.isArray(v)
      ? v.filter((x) => x && typeof x.to === 'string').slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}
function writeRecent(userId: string, list: Recent[]): void {
  try {
    localStorage.setItem(recentKey(userId), JSON.stringify(list.slice(0, RECENT_MAX)))
  } catch {
    // a private window keeps nothing
  }
}

/** The kind of an option, kept by name in the recent list (an icon cannot be stored). */
const ICONS: Record<string, LucideIcon> = {
  patient: UserRound,
  visit: Stethoscope,
  bill: FileText,
  receipt: Receipt,
  booking: CalendarClock,
  staff: BadgeCheck,
  item: Package,
}
const kindOf = (key: string) => key.split(':')[0] ?? ''

/** The part of the text that matches what was typed, in bold. */
function Marked({ text, q }: { text: string; q: string }) {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return <>{text}</>
  const f = fold(text)
  // the first word's first place (folded and plain texts keep the same length for our letters)
  for (const w of words) {
    const i = f.indexOf(w)
    if (i >= 0 && f.length === text.length)
      return (
        <>
          {text.slice(0, i)}
          <mark className="text-ink bg-transparent font-bold">{text.slice(i, i + w.length)}</mark>
          {text.slice(i + w.length)}
        </>
      )
  }
  return <>{text}</>
}

const yearsOf = (birth: string | null) => {
  if (!birth) return null
  const b = new Date(birth)
  if (Number.isNaN(b.getTime())) return null
  const n = new Date()
  let y = n.getFullYear() - b.getFullYear()
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate()))
    y--
  return y >= 0 ? y : null
}
const when = (iso: string | null) =>
  iso ? `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}` : null

export function GlobalSearch({ user, className }: { user: StaffUser; className?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const id = useId()
  const listId = `${id}-list`
  const input = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [recent, setRecent] = useState<Recent[]>(() => readRecent(user.id))

  // "/" anywhere puts the cursor here (the visible box only: PC and tablet rows both render one)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      if (e.key === '/' && !typing && input.current && input.current.offsetParent !== null) {
        e.preventDefault()
        input.current.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // the database is asked once the typing pauses (180 ms)
  useEffect(() => {
    const h = window.setTimeout(() => setTyped(q.trim()), 180)
    return () => window.clearTimeout(h)
  }, [q])

  const nav = useMemo(() => navForUser(user), [user])
  const pages = useMemo(() => pagesOf(nav, t as never), [nav, t])
  const isManager = !!user.isManager || user.role === 'manager'
  const ask = typed.length >= 2
  const { data = EMPTY_RESULTS, isFetching } = useQuickSearch(ask ? typed : '', isManager)
  const results = ask ? data : EMPTY_RESULTS
  const query = q.trim()
  const hasBookings = nav.some((n) => n.to === '/app/appointments')

  const groups: Group[] = useMemo(() => {
    if (query.length < 2) return []
    const g: Group[] = []
    const push = (gid: string, title: string, options: Option[]) => {
      if (options.length) g.push({ id: gid, title, options })
    }
    push(
      'patients',
      t('search.groups.patients'),
      results.patients.map((p) => {
        const age = yearsOf(p.birthDate)
        return {
          key: `patient:${p.id}`,
          icon: UserRound,
          label: p.name,
          sub: [p.fileNumber, age != null ? t('search.age', { count: age }) : null, p.phone]
            .filter(Boolean)
            .join(' · '),
          badge: p.openEncounterId ? t('search.inClinic') : undefined,
          to: '/app/patient',
          search: { id: p.id },
        }
      }),
    )
    push(
      'pages',
      t('search.groups.pages'),
      matchPages(pages, query).map((p) => ({
        key: p.key,
        icon: p.icon,
        label: p.label,
        sub: p.where && p.where !== p.label ? p.where : undefined,
        to: p.to,
        search: p.search,
      })),
    )
    push(
      'visits',
      t('search.groups.visits'),
      results.visits.map((v) => ({
        key: `visit:${v.encounterId}`,
        icon: Stethoscope,
        label: t('search.visit', { ref: v.reference ?? '' }),
        sub: [v.name, v.fileNumber, when(v.at)].filter(Boolean).join(' · '),
        badge: v.status === 'open' ? t('search.open') : undefined,
        to: '/app/visit',
        search: { encounter: v.encounterId },
      })),
    )
    push(
      'bills',
      t('search.groups.bills'),
      results.bills.map((b) => ({
        key: `bill:${b.encounterId}`,
        icon: FileText,
        label: t('search.bill', { number: b.number }),
        sub: [b.name, b.fileNumber, formatRwf(b.total)].filter(Boolean).join(' · '),
        to: '/app/visit',
        search: { encounter: b.encounterId },
      })),
    )
    push(
      'receipts',
      t('search.groups.receipts'),
      results.receipts.map((r): Option => ({
        key: `receipt:${r.receiptNo}`,
        icon: Receipt,
        label: t('search.receipt', { number: r.receiptNo }),
        sub: [
          r.name,
          r.sale ? t('search.counterSale', { number: r.sale }) : r.fileNumber,
          formatRwf(r.amount),
          t(`visit.payment.methods.${r.method}`, { defaultValue: r.method }),
          when(r.at),
        ]
          .filter(Boolean)
          .join(' · '),
        to: r.encounterId ? '/app/visit' : '/app/analytics',
        search: r.encounterId ? { encounter: r.encounterId } : { view: 'receipts' },
      })),
    )
    push(
      'bookings',
      t('search.groups.bookings'),
      results.bookings.map((b): Option => {
        const at = b.startsAt ?? b.preferredAt
        return {
          key: `booking:${b.id}`,
          icon: CalendarClock,
          label: b.name ?? b.reference ?? '',
          sub: [
            b.reference,
            when(at),
            b.doctor,
            t(`ops.appts.status.${b.status}`, { defaultValue: b.status }),
          ]
            .filter(Boolean)
            .join(' · '),
          to: hasBookings ? '/app/appointments' : '/app/my-bookings',
          search: hasBookings ? (at ? { day: isoDate(new Date(at)) } : undefined) : { focus: b.id },
        }
      }),
    )
    push(
      'staff',
      t('search.groups.staff'),
      results.staff.map((s) => ({
        key: `staff:${s.id}`,
        icon: BadgeCheck,
        label: s.name,
        sub: [s.staffId, t(`staff.roles.${s.role}`, { defaultValue: s.role })]
          .filter(Boolean)
          .join(' · '),
        badge: s.active ? undefined : t('search.noLonger'),
        to: '/app/staff/profile',
        search: { id: s.id },
      })),
    )
    push(
      'items',
      t('search.groups.items'),
      results.items.map((i) => ({
        key: `item:${i.id}`,
        icon: Package,
        label: i.name,
        sub: i.code,
        to: '/app/stock',
        search: { open: i.id },
      })),
    )
    return g
  }, [query, results, pages, t, hasBookings])

  const recentGroup: Group[] =
    query.length === 0 && recent.length
      ? [
          {
            id: 'recent',
            title: t('search.groups.recent'),
            options: recent.map((r) => ({ ...r, icon: ICONS[kindOf(r.key)] ?? r.icon })),
          },
        ]
      : []
  const shown = query.length === 0 ? recentGroup : groups
  const flat = shown.flatMap((g) => g.options)
  const waiting = query.length >= 2 && (typed !== query || isFetching)
  const none = query.length >= 2 && !waiting && flat.length === 0
  const panel = open && (shown.length > 0 || query.length >= 2)

  const go = (o: Option) => {
    const entry: Recent = {
      key: o.key,
      icon: typeof o.icon === 'string' ? o.icon : kindOf(o.key),
      label: o.label,
      sub: o.sub,
      to: o.to,
      search: o.search,
    }
    const next = [entry, ...recent.filter((r) => r.key !== o.key)].slice(0, RECENT_MAX)
    setRecent(next)
    writeRecent(user.id, next)
    setOpen(false)
    setActive(-1)
    setQ('')
    input.current?.blur()
    void navigate({ to: o.to, search: (o.search ?? {}) as never })
  }
  const allPatients = () => {
    setOpen(false)
    setActive(-1)
    void navigate({ to: '/app/patients', search: query ? { q: query } : {} })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => (flat.length ? (a + 1) % flat.length : -1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (flat.length ? (a <= 0 ? flat.length - 1 : a - 1) : -1))
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
        setActive(-1)
      }
    }
  }

  let n = -1
  const optionId = (i: number) => `${id}-o-${i}`
  const row = (o: Option, title: string): ReactNode => {
    n++
    const i = n
    const IconC = typeof o.icon === 'string' ? null : o.icon
    return (
      <li
        key={`${title}-${o.key}`}
        id={optionId(i)}
        role="option"
        aria-selected={active === i}
        // keep the focus in the box: the click opens before the box loses it
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => go(o)}
        onMouseEnter={() => setActive(i)}
        className={cn(
          'flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2',
          active === i ? 'bg-primary-tint' : 'hover:bg-hover',
        )}
      >
        <span className="text-ink-3 bg-hover mt-0.5 inline-flex size-7 flex-none items-center justify-center rounded-md">
          {IconC ? (
            <IconC size={15} aria-hidden="true" />
          ) : (
            <Icon name={o.icon as string} size={15} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ink text-[14px] font-medium break-words">
            <Marked text={o.label} q={query} />
            {o.badge && (
              <span className="bg-mint-bg text-mint ml-2 inline-block rounded px-1.5 text-[11.5px] font-semibold whitespace-nowrap">
                {o.badge}
              </span>
            )}
          </span>
          {o.sub && (
            <span className="text-ink-3 text-[12.5px] break-words">
              <Marked text={o.sub} q={query} />
            </span>
          )}
        </span>
      </li>
    )
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const chosen = active >= 0 ? flat[active] : undefined
        if (chosen) go(chosen)
        else allPatients()
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
          setActive(-1)
        }
      }}
      className={cn('relative', className)}
    >
      <div className="border-border bg-surface text-ink-3 focus-within:border-primary focus-within:ring-primary/20 flex h-9 items-center gap-2 rounded-full border px-3 text-[14px] transition-[border-color,box-shadow] duration-120 focus-within:ring-2">
        {waiting ? (
          <Loader2 size={16} aria-hidden="true" className="animate-spin" />
        ) : (
          <Search size={16} aria-hidden="true" />
        )}
        <input
          ref={input}
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={panel}
          aria-controls={listId}
          aria-activedescendant={panel && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          className="text-ink placeholder:text-ink-4 min-w-0 flex-1 border-0 bg-transparent outline-none"
        />
        <kbd className="border-border text-ink-4 hidden rounded border px-1 text-[11px] leading-4 lg:inline">
          /
        </kbd>
      </div>
      {panel && (
        <div className="border-border bg-card pc:min-w-[460px] absolute top-full left-0 z-50 mt-1.5 flex max-h-[min(70vh,560px)] w-full flex-col overflow-hidden rounded-lg border shadow-[0_12px_32px_rgba(11,34,82,0.18)]">
          <ul
            id={listId}
            role="listbox"
            aria-label={t('search.placeholder')}
            className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1.5"
          >
            {shown.map((g) => (
              <li key={g.id} role="presentation" className="flex flex-col">
                <span
                  role="presentation"
                  className="text-ink-3 flex items-center justify-between gap-2 px-2.5 pt-2 pb-1 text-[11.5px] font-bold tracking-wide uppercase"
                >
                  <span className="flex items-center gap-1.5">
                    {g.id === 'recent' && <History size={12} aria-hidden="true" />}
                    {g.title}
                  </span>
                  {g.id === 'recent' && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setRecent([])
                        writeRecent(user.id, [])
                      }}
                      className="text-primary text-[12px] font-semibold tracking-normal normal-case hover:underline"
                    >
                      {t('search.clear')}
                    </button>
                  )}
                </span>
                <ul role="group" aria-label={g.title} className="m-0 flex list-none flex-col p-0">
                  {g.options.map((o) => row(o, g.id))}
                </ul>
              </li>
            ))}
            {waiting && flat.length === 0 && (
              <li
                role="presentation"
                className="text-ink-3 flex items-center gap-2 px-2.5 py-3 text-[13.5px]"
              >
                <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                {t('search.searching')}
              </li>
            )}
            {none && (
              <li role="presentation" className="flex flex-col gap-1 px-2.5 py-3">
                <span className="text-ink text-[14px] font-medium">
                  {t('search.none', { q: query })}
                </span>
                <span className="text-ink-3 text-[13px]">{t('search.noneHint')}</span>
              </li>
            )}
          </ul>
          {query.length >= 2 && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={allPatients}
              className="border-border text-primary hover:bg-hover flex flex-none items-center gap-2 border-t px-4 py-2.5 text-left text-[13.5px] font-semibold"
            >
              <Search size={14} aria-hidden="true" className="flex-none" />
              <span className="min-w-0 break-words">{t('search.allPatients', { q: query })}</span>
            </button>
          )}
          <p className="text-ink-4 border-border pc:block m-0 hidden flex-none border-t px-4 py-1.5 text-[11.5px]">
            <Clock size={11} aria-hidden="true" className="mr-1 inline align-[-1px]" />
            {t('search.keys')}
          </p>
        </div>
      )}
    </form>
  )
}
