import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { readDisplayKey, storeDisplayKey } from '@/lib/api/display'
import { usePageMeta } from '@/lib/page-meta'
import { DisplayPage } from '@/pages/display/display-page'

/**
 * The waiting-room screen (a TV), outside the staff shell like /book: no sign-in. The TV's own
 * key (0158: given when someone signs in on the TV to set it up, kept in its browser) or a key
 * in the address (?key=…, the link of before 0158, which is then kept too) is what the database
 * checks (migration 0114). Without either, the page offers to set the TV up.
 */
export const Route = createFileRoute('/display')({
  validateSearch: (search: Record<string, unknown>): { key: string } => ({
    key: typeof search.key === 'string' && /^[a-z0-9]{1,128}$/i.test(search.key) ? search.key : '',
  }),
  component: DisplayRoute,
})

function DisplayRoute() {
  const { t } = useTranslation()
  usePageMeta({ title: t('seo.displayTitle') })
  const { key } = Route.useSearch()
  // a link opened once is enough: the TV keeps the key
  useEffect(() => {
    if (key) storeDisplayKey(key)
  }, [key])
  return <DisplayPage screenKey={key || readDisplayKey()} />
}
