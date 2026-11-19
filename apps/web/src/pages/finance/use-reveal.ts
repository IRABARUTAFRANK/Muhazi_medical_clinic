import { useEffect, useRef } from 'react'

/**
 * 0191: a form or a message that has just appeared is brought into view, glows for a moment,
 * and (a form) gets the cursor in its first field — so a click on Mark paid, Change, Add… never
 * seems to do nothing because the box opened out of sight.
 */
export function useReveal<T extends HTMLElement>(focusFirstField = false) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'nearest' })
    if (focusFirstField) {
      const field = el.querySelector<HTMLElement>(
        'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )
      // after the scroll has started, so the focus does not jump the page
      const id = window.setTimeout(() => field?.focus({ preventScroll: true }), 150)
      return () => window.clearTimeout(id)
    }
  }, [focusFirstField])
  return ref
}
