import { useRouterState } from '@tanstack/react-router'

/**
 * A value of the address (?sale=…, ?note=…, ?request=…), read from the raw search so it works
 * whatever the route keeps: the notifications link to the desk with these.
 */
export function useSearchParam(name: string): string | null {
  return useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown> | undefined)?.[name]
      return typeof v === 'string' || typeof v === 'number' ? String(v) : null
    },
  })
}
