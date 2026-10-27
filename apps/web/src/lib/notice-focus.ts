import { useEffect, useState } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'
import { prefersReducedMotion } from '@/lib/motion'
import { FOCUS_PANEL, focusKey, type FocusKind } from '@/lib/notice-target'

/*
 * `?focus=<kind>:<id>` (from a notice, lib/notice-target.ts) brings that item into view and
 * outlines it for 2 s: the row carries `data-focus="<kind>:<id>"`, the panel listing it the
 * stable id of FOCUS_PANEL. `?focus=<kind>` alone shows the panel. The lists load after the page,
 * so the row is looked for a few seconds (the panel is shown meanwhile); the query then leaves
 * the address, so the same notice opened again shows the item again.
 */

type Search = Record<string, unknown>

const readFocus = (s: Search) => (typeof s.focus === 'string' && s.focus ? s.focus : null)

/** Outlines an element for 2 s (a 2 px ring in the primary colour, and the row flash). */
function outline(el: HTMLElement) {
  const before = { shadow: el.style.boxShadow, radius: el.style.borderRadius }
  el.style.boxShadow = 'inset 0 0 0 2px var(--mmc-primary)'
  el.style.borderRadius = '8px'
  el.classList.remove('anim-row')
  void el.offsetWidth // restart the flash when the row already had it
  el.classList.add('anim-row')
  window.setTimeout(() => {
    el.style.boxShadow = before.shadow
    el.style.borderRadius = before.radius
  }, 2000)
}

/** Mounted once by the staff shell: follows `?focus=` on every page. */
export function useNoticeFocus() {
  const router = useRouter()
  const focus = useLocation({ select: (l) => readFocus(l.search as Search) })
  useEffect(() => {
    if (!focus) return
    const [kind, id] = focus.split(':') as [string, string | undefined]
    const panelId = (FOCUS_PANEL as Record<string, string>)[kind]
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
    let tries = 0
    let panelShown = false
    let timer = 0
    const finish = (el: HTMLElement | null) => {
      window.clearInterval(timer)
      if (el) {
        el.scrollIntoView({ behavior, block: 'center' })
        outline(el)
      }
      void router.navigate({
        to: '.',
        search: (s: Search) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'focus')),
        replace: true,
      } as never)
    }
    const tick = () => {
      tries += 1
      const row = id
        ? document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)
        : null
      if (row) return finish(row)
      const panel = panelId ? document.getElementById(panelId) : null
      if (panel && !id) return finish(panel)
      if (panel && !panelShown) {
        panelShown = true
        panel.scrollIntoView({ behavior, block: 'start' })
      }
      // about 3 s: the list has loaded by then; the row is gone (answered) or on another page
      if (tries >= 20) finish(panel)
    }
    timer = window.setInterval(tick, 150)
    tick()
    return () => window.clearInterval(timer)
  }, [focus, router])
}

/** The id `?focus=` names for this kind of item (null otherwise). */
export function useFocusedId(kind: FocusKind): string | null {
  const focus = useLocation({ select: (l) => readFocus(l.search as Search) })
  return focus?.startsWith(`${kind}:`) ? focus.slice(kind.length + 1) : null
}

/**
 * The list with the item a notice points to first, so it is among the rows shown (lists show 5
 * at a time). It stays first after `?focus=` leaves the address, until another notice names one.
 */
export function useFocusFirst<T extends { id: string }>(items: T[], kind: FocusKind): T[] {
  const id = useFocusedId(kind)
  const [pinned, setPinned] = useState(id)
  const [seen, setSeen] = useState(id)
  if (id !== seen) {
    setSeen(id)
    if (id) setPinned(id)
  }
  const hit = pinned ? items.find((x) => x.id === pinned) : undefined
  return hit ? [hit, ...items.filter((x) => x !== hit)] : items
}

/** `data-focus` for a row. */
export const focusAttr = (kind: FocusKind, id: string) => ({ 'data-focus': focusKey(kind, id) })
