import i18n from 'i18next'
import { reportDocOf, type VisitDocument } from '@/lib/api/analytics-documents'
import { docDate, makeDocLabels, openPrintWindow, type FontUrls, type TFn } from '@/lib/doc-style'
import {
  buildMedicalReportsBatchHtml,
  type MedicalReportLabels,
  type ReportsBatchCover,
} from '@/lib/medical-report'
import type { LetterheadWithLegacy } from '@/lib/report-parts'

/**
 * "Print all medical reports" (0102): the medical reports of the visits found, in ONE document
 * with a cover page listing them, one report per page, each laid out as the visit screen prints
 * it. Visits whose record is private to the reader are left out and counted on the cover.
 */

const tx = (t: TFn, key: string, en: string, vars?: Record<string, unknown>) => {
  const v = t(key, { defaultValue: en, ...(vars ?? {}) })
  return v && v !== key ? v : en
}

export interface ReportsBatchInput {
  docs: VisitDocument[]
  from: string
  to: string
  clinic: LetterheadWithLegacy
  labels: MedicalReportLabels
  author: { name: string; title: string; registrationNo?: string | null }
  printedBy: string
  /** The filters in words, for the cover ("Department: Dental"). */
  filters: [label: string, value: string | null | undefined][]
  fonts?: FontUrls
}

/** The whole document's HTML (for a preview, a test, or the print window). */
export function reportsBatchHtml(
  input: ReportsBatchInput,
  t: TFn,
  opts: { lang?: string; autoPrint?: boolean; now?: Date } = {},
): string {
  const printable = input.docs.filter((d) => !d.private)
  const hidden = input.docs.length - printable.length
  const docs = printable.map((d) => reportDocOf(d, input.clinic, input.author, t, input.printedBy))
  const periodLabel =
    input.from === input.to
      ? docDate(input.from)
      : t('report.range', { from: docDate(input.from), to: docDate(input.to) })
  const cover: ReportsBatchCover = {
    title: tx(t, 'documents.title', 'Patients’ documents'),
    summary: tx(
      t,
      'documents.coverLine',
      '{{count}} medical reports · {{period}} · printed by {{name}}',
      { count: docs.length, period: periodLabel, name: input.printedBy },
    ),
    periodWord: t('report.period'),
    periodLabel,
    filters: input.filters,
    reportsLabel: tx(t, 'documents.reports', 'Medical reports'),
    patientsLabel: tx(t, 'documents.patients', 'Patients'),
    columns: {
      no: makeDocLabels(t).docNo,
      date: t('report.cols.dateTime'),
      patient: t('analytics.patient'),
      file: t('report.cols.file'),
      doctor: tx(t, 'documents.cols.doctor', 'Doctor'),
      diagnosis: tx(t, 'documents.cols.diagnosis', 'Diagnosis'),
    },
    hidden:
      hidden > 0
        ? tx(
            t,
            'documents.hidden',
            '{{count}} visits are not printed: their records are private.',
            {
              count: hidden,
            },
          )
        : null,
  }
  return buildMedicalReportsBatchHtml(
    docs,
    input.labels,
    { t, lang: opts.lang, now: opts.now, autoPrint: opts.autoPrint, fonts: input.fonts },
    cover,
    input.printedBy,
  )
}

/** Opens the document in a print window (false when blocked, or nothing to print). */
export function openReportsBatch(input: ReportsBatchInput): boolean {
  if (input.docs.every((d) => d.private)) return false
  const t: TFn = (key, vars) => i18n.t(key, { ...(vars ?? {}) }) as string
  return openPrintWindow(reportsBatchHtml(input, t, { lang: i18n.language }))
}
