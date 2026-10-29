import { useEffect, useState } from 'react'
import type { VisitEditLock } from '@/lib/api/patients'

/** A clock that ticks every second while the window is open, so the countdown and the end are live. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

/**
 * The reader's edit window on a finished visit (0104): `editing` while it is open, with the
 * seconds left. The record is refetched every 15 s; the clock here ends the window on the second.
 */
export function useEditWindow(lock: VisitEditLock | null | undefined) {
  const active = !!lock?.active && !!lock.expiresAt
  const now = useNow(active)
  const until = active ? new Date(lock.expiresAt!).getTime() : 0
  const secondsLeft = active ? Math.max(0, Math.floor((until - now) / 1000)) : 0
  return { editing: active && secondsLeft > 0, secondsLeft, until }
}
