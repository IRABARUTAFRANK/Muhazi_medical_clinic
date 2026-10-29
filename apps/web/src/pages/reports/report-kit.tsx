import { CircleAlert, DatabaseZap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/lib/api/errors'
import { needsDbUpdate } from './report-look'

/** A failed load: "needs the database update", "not allowed" in plain words, or the error. */
export function ReportError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  if (needsDbUpdate(error))
    return (
      <p
        role="status"
        className="border-amber/30 bg-amber-bg text-amber m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium"
      >
        <DatabaseZap size={16} aria-hidden="true" className="mt-0.5 flex-none" />
        {t('analytics.needsUpdate')}
      </p>
    )
  const text =
    error instanceof ApiError && error.code === '42501'
      ? t('reports.ui.notAllowed')
      : error instanceof Error
        ? error.message
        : String(error)
  return (
    <p
      role="alert"
      className="border-red/30 bg-red-bg text-red m-0 flex items-start gap-2 rounded-md border px-3 py-2.5 text-[14px] font-medium"
    >
      <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
      {text}
    </p>
  )
}
