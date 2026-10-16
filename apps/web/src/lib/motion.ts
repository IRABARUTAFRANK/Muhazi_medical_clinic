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

/** Counts from 0 to `target` with an ease-out curve (instant under reduced motion). */
export function useCountUp(target: number, durationMs = 1200): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    let raf = 0
    const start = performance.now()
    const reduced = prefersReducedMotion()
    const tick = (now: number) => {
      const p = reduced ? 1 : Math.min(1, (now - start) / durationMs)
      const eased = 1 - Math.pow(1 - p, 3)
      setValue(Math.round(target * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])
  return value
}
