import { MutationCache, QueryClient } from '@tanstack/react-query'

/** The database refused the sign-in itself (0081): asking again cannot help; the tab signs out. */
const REFUSED = /sign in again with the e-mailed code|without activity/i

/**
 * The tab's data cache. Cleared when someone signs out or another person signs in on the same
 * tab, so the next employee never sees the previous one's notices, calls or queues.
 *
 * Any action that went through (Take, Call, a payment, a hand-over, a booking answered…) reads the
 * menu counts again at once: the patient just taken leaves "My queue" now, not 20 seconds later.
 */
export const queryClient: QueryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['nav-counts'] })
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failures, error) => failures < 1 && !REFUSED.test(String(error?.message ?? '')),
      refetchOnWindowFocus: false,
    },
  },
})
