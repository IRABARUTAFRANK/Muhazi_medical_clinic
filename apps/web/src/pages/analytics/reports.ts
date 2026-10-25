import { CLINIC_PROFILE, type ClinicProfile } from '@mmc/shared'
import i18n from '@/i18n'
import { docDate, makeDocLabels } from '@/lib/doc-style'
import type { Report, ReportFigure, ReportSection, ReportWords } from '@/lib/report'
import type { TFn } from './format'

/**
 * The Excel / PDF of an Analytics view, in the clinic's report standard (lib/report.ts lays it
 * out): key figures, one or two sentences, then one table per sheet. The letterhead, the person
 * who prints and the moment are added by the report buttons.
 */
export function analyticsReport(o: {
  t: TFn
  clinic?: ClinicProfile | null
  title: string
  /** Short code on the report number (REV, STF, VIS, TRT, LAB, PHA, TRI, STK, WAI). */
  code: string
  /** File name stem ("revenue"); the period is added. */
  name: string
  from: string
  to: string
  figures?: ReportFigure[]
  summary?: string
  sections: ReportSection[]
}): Report {
  const { t } = o
  const words: ReportWords = {
    reportNo: t('report.reportNo'),
    printed: t('report.printed'),
    preparedBy: t('report.preparedBy'),
    checkedBy: t('report.checkedBy'),
    period: t('report.period'),
    total: t('report.total'),
    summarySheet: t('report.sheets.summary'),
    figure: t('report.cols.figure'),
    value: t('report.cols.value'),
    unit: t('report.cols.unit'),
  }
  const ymd = (s: string) => s.replace(/-/g, '')
  const one = o.from === o.to
  return {
    title: o.title,
    period: one ? docDate(o.from) : t('report.range', { from: docDate(o.from), to: docDate(o.to) }),
    clinic: o.clinic ?? CLINIC_PROFILE,
    producedBy: '',
    doc: makeDocLabels(t),
    words,
    lang: i18n.language,
    code: o.code,
    periodKey: one ? ymd(o.from) : `${ymd(o.from)}-${ymd(o.to)}`,
    fileName: `${o.name}_${o.from}${one ? '' : `_${o.to}`}`,
    figures: o.figures?.slice(0, 6),
    summaryText: o.summary,
    // a section without rows still prints its heading; leave empty ones out
    sections: o.sections
      .map((s) => ({ ...s, tables: s.tables.filter((tb) => tb.rows.length > 0) }))
      .filter((s) => s.tables.length > 0),
  }
}
