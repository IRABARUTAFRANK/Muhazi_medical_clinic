import { createFileRoute } from '@tanstack/react-router'
import { DisplayPage } from '@/pages/display/display-page'

/**
 * The waiting-room screen (a TV), outside the staff shell like /book: no sign-in, the screen's
 * key in the address (?key=…) is what the database checks (migration 0114).
 */
export const Route = createFileRoute('/display')({
  validateSearch: (search: Record<string, unknown>): { key: string } => ({
    key: typeof search.key === 'string' && /^[a-z0-9]{1,128}$/i.test(search.key) ? search.key : '',
  }),
  component: DisplayRoute,
})

function DisplayRoute() {
  const { key } = Route.useSearch()
  return <DisplayPage screenKey={key} />
}
