import { Link } from '@tanstack/react-router'
import type { AriaAttributes, CSSProperties, ReactNode } from 'react'

interface StaffLinkProps {
  /** `/app`, `/app/dashboard`, `/app/visit` (with `search`) or `/app/<section>`. */
  to: string
  /** Search params for `/app/visit` (`{ encounter }`). */
  search?: { encounter: string }
  className?: string
  style?: CSSProperties
  children: ReactNode
  'aria-current'?: AriaAttributes['aria-current']
  onClick?: () => void
}

/** Typed router link for staff navigation targets stored as plain strings in sample data. */
export function StaffLink({ to, search, ...rest }: StaffLinkProps) {
  if (to === '/app') return <Link to="/app" {...rest} />
  if (to === '/app/dashboard') return <Link to="/app/dashboard" {...rest} />
  if (to === '/app/visit' && search) return <Link to="/app/visit" search={search} {...rest} />
  const section = to.replace(/^\/app\//, '')
  return <Link to="/app/$section" params={{ section }} {...rest} />
}
