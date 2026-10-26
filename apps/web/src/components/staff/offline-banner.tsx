import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Yellow banner under the top bar while the device works offline. */
export function OfflineBanner() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="offline-banner flex flex-none items-center gap-2 border-b px-4 py-2 text-[14px] font-medium"
    >
      <TriangleAlert size={16} aria-hidden="true" />
      {t('sync.banner')}
    </div>
  )
}
