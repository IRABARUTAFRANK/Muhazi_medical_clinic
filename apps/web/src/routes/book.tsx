import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { isCategoryFilter, type CategoryFilter } from '@mmc/shared'
import { BookingPage } from '@/pages/booking/booking-page'

interface BookSearch {
  /** Service category filter; omitted means "all services". */
  category?: CategoryFilter
}

export const Route = createFileRoute('/book')({
  validateSearch: (search: Record<string, unknown>): BookSearch => ({
    category:
      isCategoryFilter(search.category) && search.category !== 'all' ? search.category : undefined,
  }),
  component: BookRoute,
})

function BookRoute() {
  const { category } = Route.useSearch()
  const navigate = useNavigate({ from: '/book' })
  const current: CategoryFilter = category ?? 'all'
  return (
    <BookingPage
      key={current}
      category={current}
      onCategoryChange={(c) =>
        void navigate({ search: { category: c === 'all' ? undefined : c }, resetScroll: false })
      }
    />
  )
}
