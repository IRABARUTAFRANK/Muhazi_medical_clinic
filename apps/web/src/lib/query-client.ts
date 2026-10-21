import { QueryClient } from '@tanstack/react-query'

/**
 * The tab's data cache. Cleared when someone signs out or another person signs in on the same
 * tab, so the next employee never sees the previous one's notices, calls or queues.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})
