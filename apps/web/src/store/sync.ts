import { create } from 'zustand'
import type { SyncState } from '@mmc/shared'

interface SyncStore {
  online: boolean
  offlineSince: Date | null
  pending: number
  /** Demo override (e.g. `?mode=offline`); null = real browser connectivity. */
  override: SyncState | null
  setOverride: (state: SyncState | null) => void
}

/**
 * Sync badge state. Until PowerSync is wired in, "offline" follows the browser's
 * connectivity and "pending" is always 0 unless a demo override is set.
 */
export const useSyncStore = create<SyncStore>()((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  offlineSince: typeof navigator !== 'undefined' && !navigator.onLine ? new Date() : null,
  pending: 0,
  override: null,
  setOverride: (override) => set({ override }),
}))

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () =>
    useSyncStore.setState({ online: false, offlineSince: new Date() }),
  )
  window.addEventListener('online', () =>
    useSyncStore.setState({ online: true, offlineSince: null }),
  )
}

export function useSyncState(): SyncState {
  const { online, offlineSince, pending, override } = useSyncStore()
  if (override) return override
  if (!online) return { status: 'offline', since: offlineSince ?? new Date(), pending }
  return { status: 'synced' }
}
