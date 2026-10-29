import { useId, useState } from 'react'
import { CircleCheck, FileText, Printer, Search, Stethoscope, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CLINIC_PROFILE, type StaffUser } from '@mmc/shared'
import { Hint, Kpi, Panel } from '@/components/dash/kit'
import { Button } from '@/components/ui/button'
import { Field, controlClass } from '@/components/ui/field'
import { StaffLink } from '@/components/staff/staff-link'
import {
  fetchVisitDocuments,
  useVisitsInPeriod,
  type VisitFilters,
  type VisitRow,
} from '@/lib/api/analytics-documents'
import type { AnalyticsAccess } from '@/lib/api/analytics'
import { registrationText, useMyCredentials } from '@/lib/api/staff'
import { useLetterhead, useMedicalReportLabels } from '@/lib/report-parts'
import { visitsListReport } from '@/lib/reports/build'
import { openReportsBatch } from '@/lib/reports/documents-print'
import { roleLabel } from '@/lib/roles'
import type { Period } from '@/lib/period'
import { cn } from '@/lib/utils'
import { num, when } from './format'
import {
  DataTable,
  Figures,
  LoadError,
  NeedsUpdate,
  Quiet,
  useExport,
  ViewSkeleton,
  type Col,
} from './kit'
import type { AnalyticsSearch, UpdateSearch } from './search'
import { tx } from './words'

/**
 * Patients' documents (0102): the visits treated in the period with the page's filters
 * (department, doctor, service, insurer, only closed visits, a search), their counts, and the
 * actions: print every medical report in one document, export the list, or print / open one
 * visit. The period comes from the page (the Analytics period control). The department is the
 * page's (`dept=`), the doctor `person=`, the service `group=`, the insurer `kind`… no: the
 * insurer and the search are local state (the address keeps the period, department and doctor).
 */
export function PatientsDocuments({
  user,
  period,
  search,
  update,
  dept,
}: {
  user: StaffUser
  /** The person's access (the page passes it; the figures come from the server's scope). */
  access?: AnalyticsAccess
  period: Period
  search: AnalyticsSearch
  update: UpdateSearch
  /** The department of the page (null: the whole clinic, for the manager). */
  dept: string | null
}) {
  const { t } = useTranslation()
  const p = { from: period.from, to: period.to }
  const [service, setService] = useState('')
  const [insurer, setInsurer] = useState('')
  const [closedOnly, setClosedOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filters: VisitFilters = {
    department: dept,
    doctor: search.person ?? null,
    service: service || null,
    insurer: insurer || null,
    closedOnly,
    search: query,
  }
  const q = useVisitsInPeriod(p, filters)
  const letterhead = useLetterhead()
  const labels = useMedicalReportLabels()
  const { data: creds } = useMyCredentials(user.id)
  const ids = { doctor: useId(), service: useId(), insurer: useId(), closed: useId() }
  const d = q.data

  const filterWords = (): string[] =>
    (
      [
        [t('analytics.department'), d?.options.departments.find((x) => x.id === dept)?.name],
        [
          tx(t, 'documents.cols.doctor', 'Doctor'),
          d?.options.doctors.find((x) => x.id === filters.doctor)?.name,
        ],
        [tx(t, 'documents.service', 'Service'), service ? serviceName(service) : null],
        [
          t('rxDoc.insurer', { defaultValue: 'Insurer' }),
          d?.options.insurers.find((x) => x.id === insurer)?.name,
        ],
        [
          tx(t, 'documents.closedOnly', 'Only closed visits'),
          closedOnly ? t('common.yes', { defaultValue: 'Yes' }) : null,
        ],
        [t('patients.search'), query.trim() || null],
      ] as [string, string | null | undefined][]
    )
      .filter((x) => !!x[1])
      .map(([k, v]) => `${k}: ${v}`)
  const serviceName = (s: string) => t(`prices.groups.${s}`, { defaultValue: s })
  useExport(() =>
    d && !d.needsUpdate ? visitsListReport(d, filterWords(), CLINIC_PROFILE, user, t) : null,
  )

  const author = {
    name: user.name,
    title: creds?.specialty?.trim() || roleLabel(user, t),
    registrationNo: registrationText(creds),
  }

  const printAll = async (rows: VisitRow[]) => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const docs = await fetchVisitDocuments(rows)
      const ok = openReportsBatch({
        docs,
        from: d?.from || p.from,
        to: d?.to || p.to,
        clinic: letterhead,
        labels,
        author,
        printedBy: user.name,
        filters: filterWords().map((w) => {
          const [k, ...rest] = w.split(': ')
          return [k ?? w, rest.join(': ')]
        }),
      })
      if (!ok)
        setError(
          docs.every((x) => x.private)
            ? tx(t, 'documents.allPrivate', 'These records are private: nothing to print.')
            : t('report.popupBlocked'),
        )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (q.error) return <LoadError error={q.error} />
  if (!d) return <ViewSkeleton />
  if (d.needsUpdate) return <NeedsUpdate />

  const patients = new Set(d.visits.map((v) => v.patient.id)).size
  const cols: Col<VisitRow>[] = [
    {
      key: 'patient',
      label: t('analytics.patient'),
      cell: (r) => (
        <span className="block min-w-0">
          <StaffLink
            to="/app/patient"
            search={{ id: r.patient.id }}
            className="text-primary font-semibold [overflow-wrap:anywhere]"
          >
            {r.patient.name}
          </StaffLink>
          <span className="text-ink-3 block text-[12px]">{r.patient.fileNumber}</span>
        </span>
      ),
      sort: (r) => r.patient.name,
    },
    {
      key: 'at',
      label: t('report.cols.dateTime'),
      cell: (r) => (
        <span className="block">
          <span className="whitespace-nowrap">{when(r.at)}</span>
          {r.reference && <span className="text-ink-3 block text-[12px]">{r.reference}</span>}
        </span>
      ),
      sort: (r) => r.at,
    },
    {
      key: 'doctor',
      label: tx(t, 'documents.cols.doctor', 'Doctor'),
      wide: true,
      cell: (r) => r.doctor?.name ?? '—',
      sort: (r) => r.doctor?.name ?? null,
    },
    {
      key: 'diagnosis',
      label: tx(t, 'documents.cols.diagnosis', 'Diagnosis'),
      cell: (r) => (r.diagnosis ? `${r.diagnosis}${r.icd10 ? ` (${r.icd10})` : ''}` : '—'),
      sort: (r) => r.diagnosis,
    },
    {
      key: 'status',
      label: tx(t, 'documents.cols.status', 'Status'),
      wide: true,
      cell: (r) => (
        <span
          className={cn(
            'font-semibold whitespace-nowrap',
            r.status === 'closed' ? 'text-green' : 'text-amber',
          )}
        >
          {r.status === 'closed'
            ? tx(t, 'documents.status.closed', 'Closed')
            : tx(t, 'documents.status.open', 'Open')}
        </span>
      ),
      sort: (r) => r.status,
    },
    {
      key: 'actions',
      label: '',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="tint-grey"
            onClick={() => void printAll([r])}
            title={t('report.pdfHint')}
          >
            <Printer size={14} aria-hidden="true" />
            {t('dashboard.print')}
          </Button>
          <StaffLink
            to="/app/visit"
            search={{ encounter: r.id }}
            className="text-primary text-[13px] font-semibold whitespace-nowrap"
          >
            {tx(t, 'documents.openVisit', 'Open the visit')} →
          </StaffLink>
        </span>
      ),
    },
  ]

  return (
    <>
      <Figures>
        <Kpi
          i={0}
          icon={Stethoscope}
          tint="teal"
          label={t('dashboard.tiles.visits')}
          value={d.count}
          unit={period.label}
        />
        <Kpi
          i={1}
          icon={Users}
          tint="navy"
          label={tx(t, 'documents.patients', 'Patients')}
          value={patients}
          unit={period.label}
        />
        <Kpi
          i={2}
          icon={CircleCheck}
          tint="mint"
          label={tx(t, 'documents.closedVisits', 'Closed visits')}
          value={d.closed}
          unit={period.label}
        />
        <Kpi
          i={3}
          icon={FileText}
          tint="amber"
          label={tx(t, 'documents.openVisits', 'Open visits')}
          value={d.open}
          unit={period.label}
        />
      </Figures>
      <Hint>
        {tx(
          t,
          'documents.logNote',
          'Every record printed here is logged as an opening of that patient’s past records, as on the visit screen.',
        )}
      </Hint>

      <Panel i={1} icon={Search} tint="teal" title={tx(t, 'documents.filters', 'Filters')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={ids.doctor} className="text-ink-2 text-[13px] font-medium">
              {tx(t, 'documents.cols.doctor', 'Doctor')}
            </label>
            <select
              id={ids.doctor}
              value={filters.doctor ?? ''}
              onChange={(e) => update({ person: e.target.value || undefined }, { replace: true })}
              className={cn(controlClass, 'w-full max-w-full')}
            >
              <option value="">{tx(t, 'documents.allDoctors', 'All doctors')}</option>
              {d.options.doctors.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={ids.service} className="text-ink-2 text-[13px] font-medium">
              {tx(t, 'documents.service', 'Service')}
            </label>
            <select
              id={ids.service}
              value={service}
              onChange={(e) => setService(e.target.value)}
              className={cn(controlClass, 'w-full max-w-full')}
            >
              <option value="">{tx(t, 'documents.allServices', 'All services')}</option>
              {d.options.services.map((x) => (
                <option key={x} value={x}>
                  {serviceName(x)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={ids.insurer} className="text-ink-2 text-[13px] font-medium">
              {t('rxDoc.insurer', { defaultValue: 'Insurer' })}
            </label>
            <select
              id={ids.insurer}
              value={insurer}
              onChange={(e) => setInsurer(e.target.value)}
              className={cn(controlClass, 'w-full max-w-full')}
            >
              <option value="">{tx(t, 'documents.allInsurers', 'All insurers and cash')}</option>
              {d.options.insurers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          <Field
            label={t('patients.search')}
            placeholder={t('register.searchPh')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            wrapperClassName="sm:col-span-2"
          />
          <label
            htmlFor={ids.closed}
            className="text-ink-2 flex min-h-9 items-center gap-2 self-end text-[14px] font-medium"
          >
            <input
              id={ids.closed}
              type="checkbox"
              checked={closedOnly}
              onChange={(e) => setClosedOnly(e.target.checked)}
              className="size-4"
            />
            {tx(t, 'documents.closedOnly', 'Only closed visits')}
          </label>
        </div>
      </Panel>

      <Panel
        i={2}
        icon={FileText}
        tint="navy"
        title={tx(t, 'documents.visitsTitle', 'Visits treated')}
        right={tx(t, 'documents.found', '{{count}} found', { count: d.count })}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void printAll(d.visits)}
            loading={busy}
            disabled={d.visits.length === 0}
          >
            {!busy && <Printer size={16} aria-hidden="true" />}
            {tx(t, 'documents.printAll', 'Print all medical reports')}
          </Button>
          <span className="text-ink-3 text-[13px]">
            {tx(t, 'documents.exportHint', 'Excel and PDF above export this list.')}
          </span>
          {error && <span className="text-red text-[13px] font-semibold">{error}</span>}
        </div>
        <DataTable<VisitRow>
          rows={d.visits}
          rowKey={(r) => r.id}
          cols={cols}
          initialSort={{ key: 'at', desc: false }}
          empty={<Quiet>{t('analytics.noData')}</Quiet>}
          caption={tx(t, 'documents.visitsTitle', 'Visits treated')}
        />
        {d.count >= 2000 && (
          <Quiet>
            {tx(t, 'documents.limit', 'The first 2,000 visits are listed: narrow the period.')}
          </Quiet>
        )}
        <span className="sr-only">{num(d.count)}</span>
      </Panel>
    </>
  )
}
