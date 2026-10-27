import { useEffect, useRef, useState } from 'react'

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Reveal-on-scroll: every `[data-reveal]` element under the returned ref gets `is-visible`
 * when it enters the viewport (CSS in brand.css does the transition). Elements that appear
 * later, for example cards rendered once live data arrives, are picked up by a MutationObserver
 * so nothing stays hidden.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const all = () => Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'))

    if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
      const show = () => all().forEach((el) => el.classList.add('is-visible'))
      show()
      const mo = new MutationObserver(show)
      mo.observe(root, { childList: true, subtree: true })
      return () => mo.disconnect()
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            io.unobserve(entry.target)
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    const observed = new WeakSet<Element>()
    const observeAll = () => {
      for (const el of all()) {
        if (observed.has(el) || el.classList.contains('is-visible')) continue
        observed.add(el)
        io.observe(el)
      }
    }
    observeAll()
    const mo = new MutationObserver(observeAll)
    mo.observe(root, { childList: true, subtree: true })
    return () => {
      mo.disconnect()
      io.disconnect()
    }
  }, [])
  return ref
}

/**
 * Which rows of a live list just changed: a map of row key → how many times its content has
 * changed since the list was first shown (rows seen for the first time count 0). A queue row
 * flashes once per change: give the row `anim-row` when its count is above 0 and put the count
 * in its React key, so the flash plays again on the next change.
 */
export function useChanged<T>(
  items: readonly T[],
  key: (item: T) => string,
  signature: (item: T) => string,
): Map<string, number> {
  // Compared by content, never by list identity: live data hands a new array on every render,
  // and a setState in render on that would loop forever. The counts live in a ref, updated in
  // render only when the joined signatures actually differ.
  const sigs = items.map((item) => key(item) + '\u0000' + signature(item)).join('\u0001')
  const seen = useRef<{ sigs: string | null; rows: Map<string, { sig: string; n: number }> }>({
    sigs: null,
    rows: new Map(),
  })
  if (seen.current.sigs !== sigs) {
    const rows = new Map<string, { sig: string; n: number }>()
    for (const item of items) {
      const k = key(item)
      const sig = signature(item)
      const prev = seen.current.rows.get(k)
      rows.set(k, { sig, n: prev ? (prev.sig === sig ? prev.n : prev.n + 1) : 0 })
    }
    seen.current = { sigs, rows }
  }
  return new Map(Array.from(seen.current.rows, ([k, r]) => [k, r.n]))
}

/** The content of a list row as one string, without the fields that tick by themselves
 *  (waiting minutes, "x min ago"), so a row flashes when something real changed. */
export const rowSignature = (row: object): string =>
  JSON.stringify(row, (k, v) => (/wait|ago|min$|At$/i.test(k) ? undefined : v))

/**
 * Counts up to `target` once with an ease-out curve: from 0 when the figure first shows, from
 * the previous figure when it changes later (a live tile does not restart from zero every
 * refresh). Instant under reduced motion.
 */
export function useCountUp(target: number, durationMs = 800): number {
  const [value, setValue] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    let raf = 0
    const start = performance.now()
    const base = from.current
    const reduced = prefersReducedMotion()
    const tick = (now: number) => {
      const p = reduced ? 1 : Math.min(1, (now - start) / durationMs)
      const eased = 1 - Math.pow(1 - p, 3)
      setValue(Math.round(base + (target - base) * eased))
      if (p >= 1) from.current = target
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])
  return value
}
