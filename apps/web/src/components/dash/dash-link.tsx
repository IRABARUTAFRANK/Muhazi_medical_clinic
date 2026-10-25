import type { AriaAttributes, CSSProperties, MouseEvent, ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'

/*
 * Links from a dashboard card to the page behind it. A card takes a plain address
 * ("/app/analytics?view=revenue&range=month", "/app/stock?tab=reorder"): it stays a real link
 * (keyboard, middle click, "open in a new tab") and moves inside the app without reloading.
 */

/** A real `<a>` that navigates inside the app (a modified click opens a new tab as usual). */
export function DashLink({
  href,
  className,
  style,
  children,
  title,
  'aria-label': ariaLabel,
}: {
  href: string
  className?: string
  style?: CSSProperties
  children: ReactNode
  title?: string
  'aria-label'?: AriaAttributes['aria-label']
}) {
  const router = useRouter()
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return
    e.preventDefault()
    void router.navigate({ href })
  }
  return (
    <a
      href={href}
      onClick={onClick}
      className={className}
      style={style}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  )
}
