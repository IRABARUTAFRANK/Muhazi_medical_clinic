import { Link } from '@tanstack/react-router'
import type { AriaAttributes, ReactNode } from 'react'

interface StaffLinkProps {
  /** `/app`, `/app/dashboard` or `/app/<section>` (sections not yet designed). */
  to: string
  className?: string
  children: ReactNode
  'aria-current'?: AriaAttributes['aria-current']
  onClick?: () => void
}

/** Typed router link for staff navigation targets stored as plain strings in sample data. */
export function StaffLink({ to, ...rest }: StaffLinkProps) {
  if (to === '/app') return <Link to="/app" {...rest} />
  if (to === '/app/dashboard') return <Link to="/app/dashboard" {...rest} />
  const section = to.replace(/^\/app\//, '')
  return <Link to="/app/$section" params={{ section }} {...rest} />
}
