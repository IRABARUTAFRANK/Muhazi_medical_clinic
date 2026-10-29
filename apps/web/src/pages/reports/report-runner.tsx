import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import {
  FileSpreadsheet,
  FileText,
  Filter,
  Loader2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  TableProperties,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE } from '@mmc/shared'
import { IconChip } from '@/components/dash/kit'
import { card, sectionTitle } from '@/components/dash/kit-style'
import { Button } from '@/components/ui/button'
import type { DashboardRange } from '@/lib/api/dashboard'
import { useClinicInfo } from '@/lib/api/public'
import { docDate, docNumber } from '@/lib/doc-style'
import { usePeriod } from '@/lib/period'
import { downloadExcel, openPdf, type Report } from '@/lib/report'
import { useLetterhead } from '@/lib/report-parts'
import type {
  AnyReportDef,
  ReportContext,
  ReportFilterValues,
  ReportOption,
} from '@/lib/reports/defs/types'
import { clearPreset, loadPreset, savePreset } from '@/lib/reports/presets'
import {
  availableColumns,
  buildModel,
  buildReport,
  cleanChoices,
  defaultChoices,
  filterLines,
  type ReportChoices,
} from '@/lib/reports/run'
import { cn } from '@/lib/utils'
import { ReportFilters, type FilterDraft } from './report-filters'
import { ReportError } from './report-kit'
import { GROUP_LOOK } from './report-look'
import { ReportLayout } from './report-layout'
import { ReportFigures, ReportPreview } from './report-preview'

const RANGES: readonly DashboardRange[] = ['today', 'week', 'month', 'all', 'custom']

/** A value that follows `value` once it has stopped changing for `ms` (typing a search). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

/** The filters as the report opens: the saved default, else each filter's own default. */
function draftOf(def: AnyReportDef, saved: FilterDraft | null): FilterDraft {
  const d: FilterDraft = {}
  for (const f of def.filters) {
    if (f.kind === 'period') continue
    const s = saved?.[f.key]
    const own = f.default
    d[f.key] =
      s !== undefined
        ? s
        : typeof own === 'string' || typeof own === 'boolean' || Array.isArray(own)
          ? own
          : f.kind === 'multi'
            ? []
            : f.kind === 'toggle'
              ? false
              : ''
  }
  return d
}

const periodDefault = (def: AnyReportDef): DashboardRange => {
  const d = def.filters.find((f) => f.kind === 'period')?.default
  return typeof d === 'string' && RANGES.includes(d as DashboardRange)
    ? (d as DashboardRange)
    : 'month'
}

/**
 * One report: its filters, its layout (columns, totals, grouping, sort), the key figures and
 * the preview of the table, with Print / PDF, Excel, "Save as my default" and "Reset". Mounted
 * again for each report (key), so each opens with its own defaults or the person's saved ones.
 */
export function ReportRunner({ def, ctx }: { def: AnyReportDef; ctx: ReportContext }) {
  const { t, i18n } = useTranslation()
  const user = ctx.user
  const [preset] = useState(() => loadPreset(user.id, def.id))
  const period = usePeriod(preset?.period?.range ?? periodDefault(def))
  // a saved custom range is put back once, on the first render
  const [customDone, setCustomDone] = useState(false)
  if (!customDone) {
    setCustomDone(true)
    if (preset?.period?.custom) period.setCustom(preset.period.custom)
  }
  const [draft, setDraft] = useState<FilterDraft>(() => draftOf(def, preset?.filters ?? null))
  const applied = useDebounced(draft, 300)
  const [picked, setPicked] = useState<Partial<ReportChoices> | null>(preset?.choices ?? null)
  const [flash, setFlash] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null)

  const filters = def.filters.filter((f) => !f.allowed || f.allowed(ctx))

  // options of the filters read from the database (cashiers, departments, doctors…)
  const withOptions = filters.filter((f) => f.loadOptions)
  const optionQs = useQueries({
    queries: withOptions.map((f) => ({
      queryKey: ['reports', 'options', def.id, f.key, user.id],
      queryFn: () => f.loadOptions!(ctx),
      staleTime: 5 * 60_000,
    })),
  })
  const options: Record<string, ReportOption[] | undefined> = {}
  const optionsLoading: Record<string, boolean> = {}
  withOptions.forEach((f, i) => {
    options[f.key] = optionQs[i]?.data
    optionsLoading[f.key] = !!optionQs[i]?.isPending
  })

  // the clinic's own fields (patient file settings) as columns
  const extraQ = useQuery({
    queryKey: ['reports', 'extraColumns', def.id, user.id],
    queryFn: () => def.extraColumns!(ctx),
    enabled: !!def.extraColumns,
    staleTime: 5 * 60_000,
  })
  const columns = useMemo(
    () => availableColumns([...def.columns, ...(extraQ.data ?? [])], ctx),
    [def, extraQ.data, ctx],
  )
  const choices = useMemo(() => cleanChoices(picked, def, columns), [picked, def, columns])
  const defaults = useMemo(() => defaultChoices(def, columns).columns, [def, columns])

  const values: ReportFilterValues = useMemo(
    () => ({
      ...applied,
      period: {
        range: period.range,
        from: period.from,
        to: period.to,
        label:
          period.from === period.to
            ? docDate(period.from)
            : t('report.range', { from: docDate(period.from), to: docDate(period.to) }),
      },
    }),
    [applied, period.range, period.from, period.to, t],
  )
  // the private columns the loader reads only when shown (and every sensitive column)
  const fetched = choices.columns.filter(
    (k) => def.fetchColumns?.includes(k) || columns.find((c) => c.key === k)?.sensitive,
  )
  const rowsQ = useQuery({
    queryKey: ['reports', 'rows', def.id, user.id, period.from, period.to, applied, fetched],
    queryFn: () => def.load(values, ctx, { columns: choices.columns }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const rows = rowsQ.data
  const model = useMemo(
    () => (rows ? buildModel({ def, rows, columns, choices, t }) : null),
    [rows, def, columns, choices, t],
  )
  const figures = useMemo(
    () => (rows && def.figures ? def.figures(rows, values) : []),
    [rows, def, values],
  )

  const letterhead = useLetterhead()
  const { data: clinicInfo } = useClinicInfo()
  const build = (): Report | null => {
    if (!model) return null
    const now = new Date()
    const r = buildReport({
      def,
      model,
      values,
      filters: filterLines({ def, values, options, ctx, t }),
      figures,
      totals: choices.totals,
      clinic: CLINIC_PROFILE,
      user,
      t,
      lang: i18n.language,
      printedAt: now,
    })
    return { ...r, letterhead: clinicInfo?.profile ? letterhead : undefined }
  }
  const run = async (kind: 'pdf' | 'xlsx') => {
    setFlash(null)
    const r = build()
    if (!r) {
      setFlash({ tone: 'error', text: t('report.notReady') })
      return
    }
    setBusy(kind)
    try {
      if (kind === 'xlsx') await downloadExcel(r)
      else if (!openPdf(r)) setFlash({ tone: 'error', text: t('report.popupBlocked') })
    } catch (e) {
      setFlash({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }
  const save = () => {
    const ok = savePreset(user.id, def.id, {
      choices,
      filters: draft,
      period: {
        range: period.range,
        custom: period.range === 'custom' ? period.custom : undefined,
      },
    })
    setFlash(
      ok
        ? { tone: 'ok', text: t('reports.ui.savedDefault') }
        : { tone: 'error', text: t('reports.ui.notSaved') },
    )
  }
  const reset = () => {
    clearPreset(user.id, def.id)
    setPicked(null)
    setDraft(draftOf(def, null))
    period.setRange(periodDefault(def))
    setFlash({ tone: 'ok', text: t('reports.ui.resetDone') })
  }

  const look = GROUP_LOOK[def.group]
  const countLabel = t(def.countLabel ?? 'reports.ui.rows')
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={cn(card, 'gap-3')}>
        <div className="flex flex-wrap items-start gap-3">
          <IconChip icon={look.icon} tint={look.hue} />
          <div className="min-w-[min(220px,100%)] flex-1">
            <h2 className="text-ink m-0 text-[20px] leading-tight font-semibold">{t(def.title)}</h2>
            <p className="text-ink-2 m-0 mt-1 max-w-[760px] text-[14px] leading-snug">
              {t(def.description)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="toolbar">
            <Button
              variant="tint-grey"
              onClick={() => void run('pdf')}
              loading={busy === 'pdf'}
              disabled={!model}
              title={t('report.pdfHint')}
            >
              {busy !== 'pdf' && <FileText size={16} aria-hidden="true" />}
              {t('reports.ui.printPdf')}
            </Button>
            <Button
              variant="tint-grey"
              onClick={() => void run('xlsx')}
              loading={busy === 'xlsx'}
              disabled={!model}
              title={t('report.excelHint')}
            >
              {busy !== 'xlsx' && <FileSpreadsheet size={16} aria-hidden="true" />}
              {t('report.excel')}
            </Button>
          </div>
        </div>
        {flash && (
          <p
            role={flash.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'm-0 rounded-md border px-3 py-2 text-[14px] font-medium',
              flash.tone === 'error'
                ? 'border-red/30 bg-red-bg text-red'
                : 'border-green/30 bg-green-bg text-green',
            )}
          >
            {flash.text}
          </p>
        )}
      </section>

      <section className={card} aria-labelledby="rep-filters">
        <h3 id="rep-filters" className={cn(sectionTitle, 'm-0 flex items-center gap-2')}>
          <Filter size={16} aria-hidden="true" className="text-primary" />
          {t('reports.ui.filters')}
        </h3>
        <ReportFilters
          filters={filters}
          period={period}
          draft={draft}
          onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
          options={options}
          loading={optionsLoading}
        />
      </section>

      <section className={card} aria-labelledby="rep-layout">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="rep-layout" className={cn(sectionTitle, 'm-0 flex flex-1 items-center gap-2')}>
            <SlidersHorizontal size={16} aria-hidden="true" className="text-primary" />
            {t('reports.ui.layout')}
          </h3>
          <Button size="sm" variant="tint-teal" onClick={save}>
            <Save size={14} aria-hidden="true" />
            {t('reports.ui.saveDefault')}
          </Button>
          <Button size="sm" variant="tint-grey" onClick={reset}>
            <RotateCcw size={14} aria-hidden="true" />
            {t('reports.ui.reset')}
          </Button>
        </div>
        <ReportLayout
          columns={columns as never}
          groups={(def.groups ?? []) as never}
          choices={choices}
          onChange={setPicked}
          defaults={defaults}
          countLabel={countLabel}
        />
      </section>

      {figures.length > 0 && <ReportFigures figures={figures} />}

      <section className={card} aria-labelledby="rep-preview" aria-busy={rowsQ.isFetching}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="rep-preview" className={cn(sectionTitle, 'm-0 flex flex-1 items-center gap-2')}>
            <TableProperties size={16} aria-hidden="true" className="text-primary" />
            {t('reports.ui.preview')}
          </h3>
          {model && (
            <span className="text-ink-2 text-[14px] tabular-nums">
              {model.summary || model.groups
                ? t('reports.ui.countGroups', {
                    n: docNumber(model.count),
                    what: countLabel,
                    groups: docNumber(model.groups),
                  })
                : t('reports.ui.countRows', { n: docNumber(model.count), what: countLabel })}
            </span>
          )}
          {rowsQ.isFetching && rows && (
            <Loader2
              size={16}
              aria-label={t('dashboard.loading')}
              className="text-ink-3 animate-spin"
            />
          )}
        </div>
        {def.filters.some((f) => f.kind === 'period') && (
          <p className="text-ink-3 m-0 text-[13px]">
            {t('reports.ui.periodLine', { period: values.period.label })}
          </p>
        )}
        {rowsQ.error && !rows ? (
          <ReportError error={rowsQ.error} />
        ) : !model ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label={t('dashboard.loading')}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-9 rounded-md" />
            ))}
          </div>
        ) : model.count === 0 ? (
          <p className="text-ink-2 bg-surface m-0 rounded-md px-4 py-8 text-center text-[15px]">
            {t('reports.ui.empty')}
          </p>
        ) : (
          <>
            {rowsQ.error && <ReportError error={rowsQ.error} />}
            <ReportPreview
              def={def}
              model={model}
              totalsAt={choices.totals}
              resetKey={`${JSON.stringify(choices)}-${model.rows.length}-${period.from}-${period.to}`}
            />
          </>
        )}
      </section>
    </div>
  )
}
