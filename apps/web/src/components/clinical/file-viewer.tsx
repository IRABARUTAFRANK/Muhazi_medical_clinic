import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Loader2,
  Lock,
  Maximize2,
  RotateCw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import {
  formatFileSize,
  isImage,
  linkFresh,
  useFileActions,
  useFileLink,
  type PatientFileDoc,
} from '@/lib/api/files'
import { useConfirm } from '@/lib/confirm'
import { useNow } from '@/lib/hooks'
import { cn } from '@/lib/utils'

/**
 * The file viewer of the supporting files, like a drive: the files of a visit (or of a test) as
 * cards with a thumbnail, and a full-screen viewer that opens one of them. Nothing is shown in
 * the page itself. The viewer asks for the file's 5-minute link when it opens a file (and again
 * when the link has expired), zooms, pans and turns pictures, shows PDF files in the browser's
 * viewer, downloads, opens in a new tab and removes (within the rules), and moves between the
 * files with the arrows, the keyboard or a swipe.
 */

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
const msgOf = (x: unknown) => (x instanceof Error ? x.message : String(x))
const errorBox =
  'bg-red-bg text-red m-0 border border-red/30 rounded-md px-3 py-2 text-[13px] font-semibold'

/** A card's message line: what was done, or a warning (a stored copy left behind). */
export type Msg = { text: string; warn?: boolean }

const isPdf = (mime: string) => mime === 'application/pdf'
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}
/** The name a download is saved under: the title, without the characters a disk refuses. */
const fileName = (f: PatientFileDoc) =>
  `${
    f.title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'file'
  }.${EXT[f.mimeType] ?? 'bin'}`
/** A signed Storage link downloads with ?download=<name>; a link of this page with <a download>. */
const downloadHref = (src: string, name: string) =>
  src.startsWith('blob:') || src.startsWith('data:')
    ? src
    : `${src}${src.includes('?') ? '&' : '?'}download=${encodeURIComponent(name)}`

/**
 * Can this browser show a PDF inside the page? Desktop browsers can; Android Chrome cannot (the
 * frame stays blank) and iOS Safari shows only the first page: phones and tablets open it in a
 * new tab instead.
 */
const pdfInline = () => {
  if (typeof window === 'undefined') return true
  const nav = navigator as Navigator & { pdfViewerEnabled?: boolean }
  if (nav.pdfViewerEnabled === false) return false
  return !window.matchMedia?.('(pointer: coarse)').matches
}

/**
 * Sample mode gives data: links, which a new tab and the PDF viewer refuse: turned into a blob
 * link (null until it is ready). Real links are used as they are.
 */
function usePageUrl(url: string | null): string | null {
  const [blob, setBlob] = useState<{ from: string; url: string } | null>(null)
  const isData = !!url && url.startsWith('data:')
  useEffect(() => {
    if (!url || !isData) return
    let live = true
    let made: string | null = null
    void fetch(url)
      .then((r) => r.blob())
      .then((b) => {
        if (!live) return
        made = URL.createObjectURL(b)
        setBlob({ from: url, url: made })
      })
      .catch(() => undefined)
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [url, isData])
  if (!url) return null
  if (!isData) return url
  return blob?.from === url ? blob.url : null
}

// ---------------------------------------------------------------- the thumbnail
/**
 * A file's picture on its card (and in the viewer's strip): the picture itself for a photo or a
 * scan of today's visit, else a tile with the type. A past visit's picture is not loaded before
 * the person opens it: opening it is a recorded look.
 */
export function FileThumb({ file, small = false }: { file: PatientFileDoc; small?: boolean }) {
  const { t } = useTranslation()
  const picture = isImage(file.mimeType)
  const live = picture && file.view === 'visit' && !file.removed
  const { data } = useFileLink(file.id, live)
  const [broken, setBroken] = useState<string | null>(null)

  if (live && data && data.url !== broken)
    return (
      <img
        src={data.url}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setBroken(data.url)}
        className="size-full object-cover"
      />
    )
  const pdf = isPdf(file.mimeType)
  const Icon = pdf ? FileText : picture ? ImageIcon : FileIcon
  const recorded = picture && !live && !file.removed
  return (
    <span
      className={cn(
        'flex size-full flex-col items-center justify-center gap-1.5 text-center',
        file.removed
          ? 'bg-hover text-ink-3'
          : pdf
            ? 'bg-red-bg text-red'
            : 'bg-primary-tint text-primary',
      )}
      title={recorded ? t('supportingFiles.viewer.recordedHint') : undefined}
    >
      <Icon size={small ? 20 : 34} aria-hidden="true" strokeWidth={1.6} />
      {!small && pdf && (
        <span className="rounded bg-current/10 px-1.5 text-[11px] font-bold tracking-wide">
          PDF
        </span>
      )}
      {!small && recorded && (
        <span className="text-ink-2 inline-flex items-center gap-1 px-2 text-[11px] font-semibold">
          <Lock size={11} aria-hidden="true" />
          {t('supportingFiles.viewer.recorded')}
        </span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------- removing
/** Removing a file: the reason, then "Are you sure?" (the row stays, with who and why). */
export function RemoveForm({
  file,
  patientName,
  onDone,
  onCancel,
}: {
  file: PatientFileDoc
  patientName: string
  onDone: (message: Msg) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { remove } = useFileActions()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const why = reason.trim()
    if (why.length < 3) {
      setErr(t('stockErrors.reasonNeeded'))
      return
    }
    setErr(null)
    if (
      !(await confirm({
        title: t('supportingFiles.confirm.removeTitle', { title: file.title, name: patientName }),
        body: t('supportingFiles.confirm.removeBody', { reason: why }),
        confirmLabel: t('supportingFiles.confirm.removeYes'),
        tone: 'danger',
      }))
    )
      return
    try {
      const done = await remove.mutateAsync({ fileId: file.id, reason: why })
      // the row is removed; its copy in storage may not be (the manager finishes it)
      onDone(
        done.storageLeft
          ? { text: t('supportingFiles.storageLeft', { title: file.title }), warn: true }
          : { text: t('supportingFiles.removed', { title: file.title }) },
      )
    } catch (x) {
      setErr(msgOf(x))
    }
  }

  return (
    <Reveal focus block="nearest">
      <form
        onSubmit={(e) => void submit(e)}
        className="border-red/40 bg-red-bg/40 flex flex-col gap-2 rounded-md border p-3"
      >
        <Field
          label={t('supportingFiles.removeReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('supportingFiles.removeReasonPh')}
          maxLength={300}
          required
        />
        {err && (
          <p role="alert" className={errorBox}>
            {err}
          </p>
        )}
        <span className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="danger" loading={remove.isPending}>
            {!remove.isPending && <Trash2 size={14} aria-hidden="true" />}
            {t('supportingFiles.removeSend')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('supportingFiles.cancel')}
          </Button>
        </span>
        <p className="text-ink-3 m-0 text-[12px]">{t('supportingFiles.removeRule')}</p>
      </form>
    </Reveal>
  )
}

// ---------------------------------------------------------------- the picture
type View = { s: number | null; x: number; y: number }
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const MAX_ZOOM = 8

/** A swipe (touch or pen) of 60 px or more, mostly sideways: the next or the previous file. */
function swipeOf(dx: number, dy: number): 'next' | 'prev' | null {
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return null
  return dx < 0 ? 'next' : 'prev'
}

/**
 * A picture fitted to the screen: zoom with the buttons, the mouse wheel, a pinch or a
 * double-click (100 % / fit), pan by dragging once zoomed, turn by 90°. At fit size a swipe
 * moves to the next or previous file.
 */
function ImageStage({
  src,
  alt,
  onSwipe,
}: {
  src: string
  alt: string
  onSwipe: (to: 'next' | 'prev') => void
}) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [area, setArea] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ s: null, x: 0, y: 0 })
  const [rot, setRot] = useState(0)
  const [moving, setMoving] = useState(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<
    | { kind: 'pan' | 'swipe'; x: number; y: number; from: View; touch: boolean }
    | { kind: 'pinch'; dist: number; scale: number }
    | null
  >(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const turned = (((rot / 90) % 2) + 2) % 2 === 1
  const nw = natural ? (turned ? natural.h : natural.w) : 1
  const nh = natural ? (turned ? natural.w : natural.h) : 1
  const pad = area.w < 640 ? 8 : 32
  const fit =
    natural && area.w > 0
      ? Math.min(
          1,
          Math.max(0.01, (area.w - pad * 2) / nw),
          Math.max(0.01, (area.h - pad * 2) / nh),
        )
      : 1
  const scale = view.s ?? fit
  const zoomed = scale > fit + 0.001

  /** Keep the picture on screen: no further than its edges. */
  const bound = (v: View, s: number): View => {
    const mx = Math.max(0, (nw * s - area.w) / 2)
    const my = Math.max(0, (nh * s - area.h) / 2)
    return { s: v.s, x: clamp(v.x, -mx, mx), y: clamp(v.y, -my, my) }
  }
  /** Zoom to `next`, keeping the point `at` (from the centre) where it is. */
  const zoomTo = (next: (current: number) => number, at = { x: 0, y: 0 }) =>
    setView((v) => {
      const cur = v.s ?? fit
      const s = clamp(next(cur), fit, Math.max(MAX_ZOOM, fit))
      if (s <= fit + 0.001) return { s: null, x: 0, y: 0 }
      const k = s / cur
      return bound({ s, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }, s)
    })
  const fromCentre = (clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
  }

  // the mouse wheel zooms (a listener that may prevent the page's scroll)
  const wheel = useRef<(e: WheelEvent) => void>(() => undefined)
  useEffect(() => {
    wheel.current = (e: WheelEvent) => {
      const f = Math.exp(-clamp(e.deltaY, -120, 120) * 0.0025)
      zoomTo((c) => c * f, fromCentre(e.clientX, e.clientY))
    }
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      wheel.current(e)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // a pointer the browser no longer tracks: the gesture works without the capture
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    if (pts.length >= 2) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }]
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), scale }
    } else {
      gesture.current = {
        kind: zoomed ? 'pan' : 'swipe',
        x: e.clientX,
        y: e.clientY,
        from: view,
        touch: e.pointerType !== 'mouse',
      }
    }
    setMoving(true)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()]
      if (pts.length < 2) return
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2)
      zoomTo(() => g.scale * (d / Math.max(1, g.dist)), mid)
    } else if (g.kind === 'pan') {
      const s = g.from.s ?? fit
      setView(
        bound({ s: g.from.s, x: g.from.x + e.clientX - g.x, y: g.from.y + e.clientY - g.y }, s),
      )
    }
  }
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    pointers.current.delete(e.pointerId)
    if (g?.kind === 'swipe' && g.touch) {
      const to = swipeOf(e.clientX - g.x, e.clientY - g.y)
      if (to) onSwipe(to)
    }
    if (pointers.current.size === 0) {
      gesture.current = null
      setMoving(false)
    } else if (g?.kind === 'pinch') {
      // one finger left after a pinch: it pans from here
      const [p] = [...pointers.current.values()] as [{ x: number; y: number }]
      gesture.current = { kind: 'pan', x: p.x, y: p.y, from: view, touch: true }
    }
  }

  const pct = Math.round(scale * 100)
  const tool =
    'inline-flex size-9 items-center justify-center rounded-full text-white hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-white'
  return (
    <div
      ref={box}
      className={cn(
        'relative size-full touch-none overflow-hidden select-none',
        zoomed ? (moving ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
      )}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={(e) => {
        const at = fromCentre(e.clientX, e.clientY)
        const target = Math.abs(scale - 1) < 0.01 ? (fit < 0.99 ? fit : 2) : 1
        zoomTo(() => target, at)
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) =>
          setNatural({
            w: e.currentTarget.naturalWidth || 1,
            h: e.currentTarget.naturalHeight || 1,
          })
        }
        style={{
          width: natural?.w,
          height: natural?.h,
          transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${rot}deg) scale(${scale})`,
        }}
        className={cn(
          'absolute top-1/2 left-1/2 max-w-none origin-center shadow-[0_10px_40px_rgba(0,0,0,.45)]',
          !natural && 'opacity-0',
          !moving && 'transition-transform duration-150 ease-out motion-reduce:transition-none',
        )}
      />
      {/* the picture's tools: zoom out, the zoom (press: fit), zoom in, turn */}
      <div
        role="toolbar"
        aria-label={t('supportingFiles.viewer.tools')}
        className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-white/10 bg-[rgba(2,6,23,.72)] p-1 shadow-lg backdrop-blur"
      >
        <button
          type="button"
          className={tool}
          aria-label={t('supportingFiles.viewer.zoomOut')}
          title={t('supportingFiles.viewer.zoomOut')}
          disabled={!zoomed}
          onClick={() => zoomTo((c) => c / 1.25)}
        >
          <ZoomOut size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="inline-flex h-9 min-w-[64px] items-center justify-center gap-1 rounded-full px-2 text-[13px] font-semibold text-white tabular-nums hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
          aria-label={`${t('supportingFiles.viewer.fit')} (${pct} %)`}
          title={t('supportingFiles.viewer.fitHint')}
          onClick={() => setView({ s: null, x: 0, y: 0 })}
        >
          {zoomed ? `${pct} %` : <Maximize2 size={16} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={tool}
          aria-label={t('supportingFiles.viewer.zoomIn')}
          title={t('supportingFiles.viewer.zoomIn')}
          disabled={scale >= Math.max(MAX_ZOOM, fit) - 0.001}
          onClick={() => zoomTo((c) => c * 1.25)}
        >
          <ZoomIn size={18} aria-hidden="true" />
        </button>
        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-white/20" />
        <button
          type="button"
          className={tool}
          aria-label={t('supportingFiles.viewer.rotate')}
          title={t('supportingFiles.viewer.rotate')}
          onClick={() => {
            setRot((r) => r + 90)
            setView({ s: null, x: 0, y: 0 })
          }}
        >
          <RotateCw size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the viewer
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
const topBtn =
  'inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-white no-underline transition-colors duration-120 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white motion-reduce:transition-none'
const label = 'max-[640px]:sr-only'

/**
 * The full-screen viewer of the files of a visit or a test (above the side panels, below the
 * "Are you sure?" box). Escape or × closes it and the focus goes back where it was.
 */
export function FileViewer({
  files,
  startId,
  patientName,
  onClose,
  onMessage,
}: {
  /** The files one may open (not removed), in the order of the cards. */
  files: PatientFileDoc[]
  startId: string
  patientName: string
  onClose: () => void
  /** The card's message line (the result of a removal). */
  onMessage?: (message: Msg | null) => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const metaId = useId()
  const root = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const [currentId, setCurrentId] = useState(startId)
  const [removing, setRemoving] = useState(false)
  const now = useNow(5_000)

  const found = files.findIndex((f) => f.id === currentId)
  const index = found >= 0 ? found : 0
  const file = files[index] ?? null
  const link = useFileLink(file?.id ?? null)
  const fresh = linkFresh(link.data, now)
  const loading = !fresh && link.isFetching
  const expired = !!link.data && !fresh && !link.isFetching
  const shown = link.data && link.data.id === file?.id && !loading ? link.data : null
  const pageUrl = usePageUrl(shown?.url ?? null)

  // the latest onClose, for the effects below
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  // nothing left to show (the last file was removed): the viewer closes
  useEffect(() => {
    if (!file) onCloseRef.current()
  }, [file])

  // focus inside while open, back where it was after; the page behind does not scroll
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const body = document.body
    const overflow = body.style.overflow
    body.style.overflow = 'hidden'
    const id = window.requestAnimationFrame(() => closeBtn.current?.focus({ preventScroll: true }))
    return () => {
      window.cancelAnimationFrame(id)
      body.style.overflow = overflow
      before?.focus?.({ preventScroll: true })
    }
  }, [])

  const go = (to: 'next' | 'prev') => {
    const i = to === 'next' ? index + 1 : index - 1
    const f = files[i]
    if (!f) return
    setRemoving(false)
    setCurrentId(f.id)
  }

  // the keys, on the whole window: the focus may be lost to the page when the button pressed
  // goes (the last file reached, the remove form closed); the "Are you sure?" box is left alone
  const onKey = (e: KeyboardEvent) => {
    const el = root.current
    const target = e.target as HTMLElement
    if (!el || (target !== document.body && !el.contains(target))) return
    const typing = target.closest('input, textarea, select, [contenteditable]')
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (removing) setRemoving(false)
      else onClose()
      return
    }
    if (!typing && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      go(e.key === 'ArrowRight' ? 'next' : 'prev')
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.getClientRects().length > 0,
    )
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) {
      e.preventDefault()
      return
    }
    const active = document.activeElement
    if (!active || !el.contains(active)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const keys = useRef(onKey)
  useEffect(() => {
    keys.current = onKey
  })
  useEffect(() => {
    const listen = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [])

  // a swipe on what is not a picture (a PDF on a phone, an error)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const swipe = {
    onPointerDown: (e: ReactPointerEvent) => {
      swipeStart.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY }
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const s = swipeStart.current
      swipeStart.current = null
      if (!s) return
      const to = swipeOf(e.clientX - s.x, e.clientY - s.y)
      if (to) go(to)
    },
  }

  if (!file) return null
  const pdf = isPdf(file.mimeType)
  const picture = isImage(file.mimeType)
  const name = fileName(file)
  const KindIcon = pdf ? FileText : picture ? ImageIcon : FileIcon
  const meta = [
    t(`supportingFiles.kinds.${file.kind}`),
    file.test ? t('supportingFiles.forTest', { test: file.test }) : null,
    t('supportingFiles.addedBy', {
      name: file.uploadedBy ?? t('supportingFiles.someone'),
      when: when(file.uploadedAt),
    }),
    formatFileSize(file.sizeBytes),
  ]
    .filter(Boolean)
    .join(' · ')
  const position = t('supportingFiles.viewer.position', { n: index + 1, total: files.length })
  const many = files.length > 1

  let body: ReactNode
  if (link.error && !link.isFetching)
    body = (
      <div
        className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center"
        {...swipe}
      >
        <KindIcon size={44} aria-hidden="true" className="text-white/50" strokeWidth={1.5} />
        <p role="alert" className="m-0 max-w-md text-[15px] font-semibold text-[#fecaca]">
          {msgOf(link.error)}
        </p>
        <button
          type="button"
          className={cn(topBtn, 'border border-white/30')}
          onClick={() => void link.refetch()}
        >
          <RotateCw size={16} aria-hidden="true" />
          {t('supportingFiles.viewer.retry')}
        </button>
      </div>
    )
  else if (!shown)
    body = (
      <div
        role="status"
        className="flex size-full flex-col items-center justify-center gap-3 text-white/80"
      >
        <Loader2 size={32} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        <span className="text-[14px]">{t('supportingFiles.viewer.loading')}</span>
      </div>
    )
  else if (picture)
    body = <ImageStage key={file.id} src={shown.url} alt={file.title} onSwipe={go} />
  else if (pdf && pdfInline())
    body = (
      <div className="mx-auto size-full max-w-[1100px] px-0 pb-0 sm:px-4 sm:pb-4">
        {pageUrl ? (
          <iframe
            key={pageUrl}
            src={pageUrl}
            title={file.title}
            className="size-full rounded-none border-0 bg-white sm:rounded-md"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-white/70">
            <Loader2
              size={28}
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          </div>
        )}
      </div>
    )
  else
    body = (
      <div
        className="flex size-full flex-col items-center justify-center gap-4 p-6 text-center"
        {...swipe}
      >
        <span
          className={cn(
            'grid size-24 place-items-center rounded-2xl',
            pdf ? 'bg-[#fee2e2] text-[#b91c1c]' : 'bg-white/10 text-white',
          )}
        >
          <KindIcon size={44} aria-hidden="true" strokeWidth={1.5} />
        </span>
        <p className="m-0 max-w-md text-[15px] font-semibold break-words">{file.title}</p>
        <p className="m-0 max-w-md text-[13px] text-white/70">
          {pdf ? t('supportingFiles.pdfPhone') : t('supportingFiles.viewer.noPreview')}
        </p>
        {pageUrl && fresh && (
          <span className="flex flex-wrap justify-center gap-2">
            {pdf && (
              <a
                href={pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(topBtn, 'bg-[#1f6f8b] px-4 hover:bg-[#185b72]')}
              >
                <ExternalLink size={18} aria-hidden="true" />
                {t('supportingFiles.openPdf')}
              </a>
            )}
            <a
              href={downloadHref(pageUrl, name)}
              download={name}
              className={cn(topBtn, 'border border-white/30 px-4')}
            >
              <Download size={18} aria-hidden="true" />
              {t('supportingFiles.viewer.download')}
            </a>
          </span>
        )}
      </div>
    )

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={metaId}
      tabIndex={-1}
      className="fixed inset-0 z-[95] flex animate-[mmc-fade_180ms_ease-out_both] flex-col bg-[#0b1220] text-white outline-none"
    >
      {/* the top bar: the file, who added it, and what can be done with it */}
      <header className="flex min-h-16 flex-none items-center gap-2 border-b border-white/10 bg-[rgba(2,6,23,.45)] px-2 py-2 sm:gap-3 sm:px-4">
        <span
          className={cn(
            'hidden size-10 flex-none place-items-center rounded-lg sm:grid',
            pdf ? 'bg-[#fee2e2] text-[#b91c1c]' : 'bg-white/12 text-white',
          )}
        >
          <KindIcon size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 pl-1 sm:pl-0">
          <h2
            id={titleId}
            className="m-0 truncate text-[16px] leading-6 font-semibold"
            title={file.title}
          >
            {file.title}
          </h2>
          <p id={metaId} className="m-0 truncate text-[12.5px] text-white/70" title={meta}>
            {meta}
          </p>
        </div>
        {many && (
          <span
            className="hidden flex-none px-1 text-[13px] text-white/70 tabular-nums sm:inline"
            aria-hidden="true"
          >
            {index + 1} / {files.length}
          </span>
        )}
        <div className="flex flex-none items-center gap-0.5 sm:gap-1">
          {pageUrl && fresh && (
            <>
              <a
                href={downloadHref(pageUrl, name)}
                download={name}
                className={topBtn}
                title={t('supportingFiles.viewer.download')}
              >
                <Download size={18} aria-hidden="true" />
                <span className={label}>{t('supportingFiles.viewer.download')}</span>
              </a>
              <a
                href={pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={topBtn}
                title={t('supportingFiles.newTab')}
              >
                <ExternalLink size={18} aria-hidden="true" />
                <span className={label}>{t('supportingFiles.newTab')}</span>
              </a>
            </>
          )}
          {expired && (
            <button
              type="button"
              className={cn(topBtn, 'bg-[#1f6f8b] hover:bg-[#185b72]')}
              onClick={() => void link.refetch()}
              title={t('supportingFiles.openAgain')}
            >
              <RotateCw size={18} aria-hidden="true" />
              <span className={label}>{t('supportingFiles.openAgain')}</span>
            </button>
          )}
          {file.canRemove && (
            <button
              type="button"
              aria-expanded={removing}
              className={cn(
                topBtn,
                'text-[#fecaca] hover:bg-[rgba(239,68,68,.22)]',
                removing && 'bg-[rgba(239,68,68,.22)]',
              )}
              onClick={() => {
                onMessage?.(null)
                setRemoving((r) => !r)
              }}
              title={t('supportingFiles.remove')}
            >
              <Trash2 size={18} aria-hidden="true" />
              <span className={label}>{t('supportingFiles.remove')}</span>
            </button>
          )}
          <span aria-hidden="true" className="mx-0.5 hidden h-6 w-px bg-white/20 sm:block" />
          <button
            ref={closeBtn}
            type="button"
            className={topBtn}
            onClick={onClose}
            aria-label={t('supportingFiles.close')}
            title={t('supportingFiles.close')}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* removing: the reason, then "Are you sure?" (above the viewer) */}
      {removing && (
        <div className="flex-none px-2 pt-2 sm:px-4">
          <div className="bg-card text-ink mx-auto max-w-lg rounded-lg p-2 shadow-xl">
            <RemoveForm
              file={file}
              patientName={patientName}
              onDone={(m) => {
                setRemoving(false)
                onMessage?.(m)
                // the next file, else the previous one, else the viewer closes
                const next = files[index + 1] ?? files[index - 1]
                if (next) setCurrentId(next.id)
                else onClose()
              }}
              onCancel={() => setRemoving(false)}
            />
          </div>
        </div>
      )}

      {/* the file */}
      <div className="relative min-h-0 flex-1">
        <div
          key={file.id}
          className="size-full motion-safe:animate-[mmc-dialog_200ms_cubic-bezier(.2,.7,.2,1)_both] motion-reduce:animate-[mmc-fade_150ms_ease-out_both]"
        >
          {body}
        </div>
        {many && index > 0 && (
          <button
            type="button"
            onClick={() => go('prev')}
            aria-label={t('supportingFiles.viewer.prev')}
            title={t('supportingFiles.viewer.prev')}
            className="absolute top-1/2 left-2 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-[rgba(2,6,23,.6)] text-white shadow-lg hover:bg-[rgba(2,6,23,.85)] focus-visible:outline-2 focus-visible:outline-white sm:left-4 sm:size-12"
          >
            <ChevronLeft size={26} aria-hidden="true" />
          </button>
        )}
        {many && index < files.length - 1 && (
          <button
            type="button"
            onClick={() => go('next')}
            aria-label={t('supportingFiles.viewer.next')}
            title={t('supportingFiles.viewer.next')}
            className="absolute top-1/2 right-2 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-[rgba(2,6,23,.6)] text-white shadow-lg hover:bg-[rgba(2,6,23,.85)] focus-visible:outline-2 focus-visible:outline-white sm:right-4 sm:size-12"
          >
            <ChevronRight size={26} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* the note, how long the link works, where one is, and every file of the visit / test */}
      <footer className="flex flex-none flex-col gap-2 px-3 pt-2 pb-3 sm:px-4">
        <p className="sr-only" aria-live="polite">
          {`${position}: ${file.title}`}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center text-[12.5px]">
          {many && (
            <span className="font-semibold text-white/85 tabular-nums sm:hidden" aria-hidden="true">
              {index + 1} / {files.length}
            </span>
          )}
          {file.note && <span className="text-white/90">{file.note}</span>}
          {/* the viewer gets a new link by itself on open and on next; only a link left open
              for longer than 5 minutes needs "Open again" */}
          {expired && (
            <span className="font-semibold text-[#fcd34d]">{t('supportingFiles.expired')}</span>
          )}
        </div>
        {many && (
          <nav aria-label={t('supportingFiles.viewer.all')} className="max-pc:hidden">
            <ul className="m-0 flex list-none justify-center gap-2 overflow-x-auto p-1">
              {files.map((f, i) => (
                <li key={f.id} className="flex-none">
                  <button
                    type="button"
                    onClick={() => {
                      setRemoving(false)
                      setCurrentId(f.id)
                    }}
                    aria-current={i === index ? 'true' : undefined}
                    aria-label={`${t('supportingFiles.viewer.position', { n: i + 1, total: files.length })}: ${f.title}`}
                    title={f.title}
                    className={cn(
                      'block h-14 w-[74px] overflow-hidden rounded-md border-2 transition-opacity duration-120 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:transition-none',
                      i === index
                        ? 'border-white'
                        : 'border-transparent opacity-60 hover:opacity-100',
                    )}
                  >
                    <FileThumb file={f} small />
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </footer>
    </div>,
    document.body,
  )
}
