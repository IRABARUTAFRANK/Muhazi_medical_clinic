import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { isCategoryFilter, type CategoryFilter } from '@mmc/shared'
import { BookingPage } from '@/pages/booking/booking-page'

interface BookSearch {
  /** Service category filter; omitted means "all services". */
  category?: CategoryFilter
  /** A doctor's code: their calendar opens first. */
  doctor?: string
}

export const Route = createFileRoute('/book')({
  validateSearch: (search: Record<string, unknown>): BookSearch => ({
    category:
      isCategoryFilter(search.category) && search.category !== 'all' ? search.category : undefined,
    doctor:
      typeof search.doctor === 'string' && /^[a-z0-9-]{1,40}$/i.test(search.doctor)
        ? search.doctor
        : undefined,
  }),
  component: BookRoute,
})

function BookRoute() {
  const { category, doctor } = Route.useSearch()
  const navigate = useNavigate({ from: '/book' })
  const current: CategoryFilter = category ?? 'all'
  return (
    <BookingPage
      key={current}
      category={current}
      doctor={doctor}
      onCategoryChange={(c) =>
        void navigate({ search: { category: c === 'all' ? undefined : c }, resetScroll: false })
      }
    />
  )
}
