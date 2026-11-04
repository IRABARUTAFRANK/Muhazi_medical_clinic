import { useState } from 'react'
import { ChevronDown, ChevronRight, FlaskConical, History, Lock, Pill, Syringe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { PrivacyNotice } from '@/components/clinical/record-privacy'
import { usePastHistory, type PastVisit } from '@/lib/api/past-history'
import { noDiagnosisText } from '@/lib/no-diagnosis'
import { cn } from '@/lib/utils'

/**
 * Step 1: the patient's past, when it is not their first time (0127 visit_past_history). Each
 * earlier visit: date, desk and doctor, chief complaint, definitive diagnoses, plan, medicines,
 * nurse orders, tests with results; and the allergies and long-term conditions. The database
 * decides who sees it: the treating doctor when the clinic allows it (each opening logged), the
 * ways of 0088 otherwise (request / emergency), never someone who is not a doctor.
 */
export function PastHistoryPanel({
  encounterId,
  patientId,
  patientName,
  onMessage,
}: {
  encounterId: string
  patientId: string | null
  patientName: string
  onMessage?: (m: string) => void
}) {
  const { t } = useTranslation()
  const { data, error } = usePastHistory(encounterId)
  if (error)
    return (
      <p className="bg-red-bg text-red m-0 rounded-md px-3 py-2 text-[13px]">{error.message}</p>
    )
  if (!data) return null
  if (data.count === 0)
    return (
      <p className="text-ink-3 border-border m-0 rounded-md border border-dashed px-3 py-2 text-[13px]">
        <History size={14} aria-hidden="true" className="mr-1.5 inline align-[-2px]" />
        {t('pastHistory.firstVisit')}
      </p>
    )
  if (!data.allowed)
    return (
      <div className="border-violet/30 bg-violet-bg/40 flex flex-col gap-2 rounded-md border px-3 py-2.5">
        <span className="text-violet flex items-center gap-2 text-[14px] font-semibold">
          <Lock size={15} aria-hidden="true" />
          {t('pastHistory.title', { count: data.count })}
        </span>
        <span className="text-ink-2 text-[13px]">
          {t(`pastHistory.refused.${data.reason ?? 'not_treating'}`)}
        </span>
        {data.access && patientId && (
          <PrivacyNotice
            patientId={patientId}
            patientName={patientName}
            access={data.access}
            onMessage={onMessage}
          />
        )}
      </div>
    )
  const safety = data.safety
  return (
    <div className="border-primary/25 bg-primary-tint/30 flex flex-col gap-2 rounded-md border px-3 py-2.5">
      <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
        <History size={15} aria-hidden="true" className="text-primary" />
        {t('pastHistory.title', { count: data.count })}
        {data.via === 'treating' && (
          <span className="text-ink-3 text-xs font-normal">{t('pastHistory.logged')}</span>
        )}
      </span>
      {safety && (safety.allergies || (safety.chronic?.length ?? 0) > 0 || safety.alerts) && (
        <div className="flex flex-wrap gap-2 text-[13px]">
          {safety.allergies && (
            <Badge tone="red" dot={false}>
              {t('file.allergiesLabel')}: {safety.allergies}
            </Badge>
          )}
          {(safety.chronic ?? []).map((c) => (
            <Badge key={c.text} tone="orange" dot={false}>
              {t('pastHistory.longTerm')}: {c.text}
            </Badge>
          ))}
          {safety.alerts && (
            <Badge tone="yellow" dot={false}>
              {safety.alerts}
            </Badge>
          )}
        </div>
      )}
      <ol className="m-0 flex flex-col gap-1.5 p-0">
        {(data.visits ?? []).map((v, i) => (
          <PastVisitRow key={v.id} visit={v} open={i === 0} />
        ))}
      </ol>
    </div>
  )
}

function PastVisitRow({ visit: v, open: first }: { visit: PastVisit; open: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(first)
  // 0130: the visit screen shows no ICD-10 code
  const dx = v.diagnoses.map((d) => d.text).join('; ')
  const dxText = dx || (v.noDiagnosis ? noDiagnosisText(v.noDiagnosis) : t('pastHistory.noDx'))
  return (
    <li className="border-border bg-card list-none rounded-md border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="hover:bg-hover flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md bg-transparent px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={14} aria-hidden="true" className="self-center" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" className="self-center" />
        )}
        <span className="text-[14px] font-semibold tabular-nums">{formatDate(new Date(v.at))}</span>
        <span className="text-ink-2 min-w-0 flex-1 text-[14px]">
          <b className="text-ink font-semibold">{dxText}</b>
          {v.complaint ? ` · ${v.complaint}` : ''}
        </span>
        <span className="text-ink-3 text-xs">
          {[v.department ?? (v.desks[0] ? t(`register.stations.${v.desks[0]}`) : null), v.doctor]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </button>
      {open && (
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 px-3 pb-3 pl-8 text-[13px] sm:grid-cols-[10rem_1fr]">
          <dt className="text-ink-3 font-semibold">{t('sixSteps.sections.complaint')}</dt>
          <dd className="m-0">{v.complaint ?? '—'}</dd>
          <dt className="text-ink-3 font-semibold">{t('sixSteps.definitive.title')}</dt>
          <dd className="m-0">{dxText}</dd>
          {v.tests.length > 0 && (
            <>
              <dt className="text-ink-3 font-semibold">{t('sixSteps.tests.title')}</dt>
              <dd className="m-0 flex flex-col gap-0.5">
                {v.tests.map((x, i) => (
                  <span key={i}>
                    <FlaskConical
                      size={12}
                      aria-hidden="true"
                      className="mr-1 inline align-[-1px]"
                    />
                    <b className="font-semibold">{x.test}</b>
                    {': '}
                    {[x.findings, x.impression].filter(Boolean).join(' — ') ||
                      t(`clinical.status.${x.status}`, { defaultValue: x.status })}
                  </span>
                ))}
              </dd>
            </>
          )}
          <dt className="text-ink-3 font-semibold">{t('sixSteps.plan.title')}</dt>
          <dd className="m-0 flex flex-col gap-0.5">
            {v.plan && <span className="whitespace-pre-wrap">{v.plan}</span>}
            {v.medicines.map((m, i) => (
              <span key={i}>
                <Pill size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
                {[
                  `${m.item} × ${m.quantity}`,
                  m.dose,
                  m.frequency
                    ? t(`clinical.frequencies.${m.frequency}`, { defaultValue: m.frequency })
                    : null,
                  m.days ? t('clinical.forDays', { count: m.days }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ))}
            {v.nurseOrders.map((o, i) => (
              <span key={i} className={cn(o.status === 'cancelled' && 'line-through')}>
                <Syringe size={12} aria-hidden="true" className="mr-1 inline align-[-1px]" />
                {[o.text, o.dose, t(`nurseOrders.status.${o.status}`)].filter(Boolean).join(' · ')}
              </span>
            ))}
            {!v.plan && v.medicines.length === 0 && v.nurseOrders.length === 0 && '—'}
          </dd>
        </dl>
      )}
    </li>
  )
}
