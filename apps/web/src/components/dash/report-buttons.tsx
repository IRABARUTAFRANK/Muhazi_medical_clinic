import { useState } from 'react'
import { FileSpreadsheet, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { downloadExcel, openPdf, type Report } from '@/lib/report'
import { useLetterhead, usePrintedBy } from '@/lib/report-parts'
import { useClinicInfo } from '@/lib/api/public'

/**
 * "Excel" and "PDF" buttons for a report, in the grey tint of every export and print action. The report is built only when a button is pressed
 * (the builder may read query data already on the page).
 */
export function ReportButtons({
  build,
  size = 'md',
}: {
  build: () => Report | null
  size?: 'sm' | 'md'
}) {
  const { t, i18n } = useTranslation()
  // the clinic's full letterhead (settings, logo of this site) and who prints
  const letterhead = useLetterhead()
  // until the settings arrive, the report keeps the clinic profile its builder was given
  const { data: clinicInfo } = useClinicInfo()
  const printedBy = usePrintedBy()
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const labels = {
    period: t('report.period'),
    producedBy: t('report.producedBy'),
    producedAt: t('report.producedAt'),
    total: t('report.total'),
    page: t('report.page'),
  }
  const run = async (kind: 'xlsx' | 'pdf') => {
    setError(null)
    const built = build()
    if (!built) {
      setError(t('report.notReady'))
      return
    }
    // what the builder left out: the letterhead from the settings, the person who prints, the
    // moment of printing and the interface language
    const r: Report = {
      ...built,
      producedBy: built.producedBy || printedBy,
      letterhead: built.letterhead ?? (clinicInfo?.profile ? letterhead : undefined),
      printedAt: built.printedAt ?? new Date(),
      lang: built.lang ?? i18n.language,
    }
    setBusy(kind)
    try {
      if (kind === 'xlsx') await downloadExcel(r, labels)
      else if (!openPdf(r, labels)) setError(t('report.popupBlocked'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="tint-grey"
        size={size}
        onClick={() => void run('xlsx')}
        loading={busy === 'xlsx'}
        title={t('report.excelHint')}
      >
        {busy !== 'xlsx' && <FileSpreadsheet size={16} aria-hidden="true" />}
        {t('report.excel')}
      </Button>
      <Button
        variant="tint-grey"
        size={size}
        onClick={() => void run('pdf')}
        loading={busy === 'pdf'}
        title={t('report.pdfHint')}
      >
        {busy !== 'pdf' && <FileText size={16} aria-hidden="true" />}
        {t('report.pdf')}
      </Button>
      {error && <span className="text-red text-[13px] font-semibold">{error}</span>}
    </span>
  )
}
