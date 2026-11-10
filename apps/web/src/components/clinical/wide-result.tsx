import { useState } from 'react'
import { FlaskConical, Maximize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { SidePanel } from '@/components/ui/side-panel'

/** What a result is made of, wherever it is shown (the record, the doctor's results, the lab). */
export interface ResultView {
  test: string
  patient?: string | null
  station?: string | null
  region?: string | null
  findings?: string | null
  impression?: string | null
  verified: boolean
  corrected?: boolean
  correctionReason?: string | null
  by?: string | null
  at?: string | null
  /** 0141: the doctor who did the ultrasound in the desk's place. */
  doer?: string | null
  orderedBy?: string | null
  orderedAt?: string | null
  reason?: string | null
}

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/**
 * "Open wide" (0150): the result in a right-hand panel, at reading size — the region examined,
 * the findings as written (line breaks kept), the conclusion, then who wrote it and when.
 */
export function WideResult({ result, className }: { result: ResultView; className?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          'text-primary hover:bg-primary-tint inline-flex h-7 items-center gap-1 rounded border border-transparent bg-transparent px-1.5 text-[12px] font-semibold'
        }
      >
        <Maximize2 size={13} aria-hidden="true" />
        {t('results.openWide')}
      </button>
      <SidePanel
        open={open}
        onClose={() => setOpen(false)}
        hue="teal"
        icon={FlaskConical}
        title={result.test}
        subtitle={[result.patient, result.station].filter(Boolean).join(' · ') || undefined}
        ariaLabel={t('results.wideAria', { test: result.test })}
      >
        <div className="flex flex-col gap-4 text-[16px] leading-relaxed">
          {(result.orderedBy || result.orderedAt || result.reason) && (
            <p className="text-ink-3 m-0 text-[13px]">
              {[
                result.orderedBy ? t('results.orderedBy', { name: result.orderedBy }) : null,
                result.orderedAt ? when(result.orderedAt) : null,
                result.reason ? `“${result.reason}”` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          {result.region && (
            <section>
              <h3 className="text-ink-2 m-0 mb-1 text-[13px] font-semibold uppercase">
                {t('clinical.region')}
              </h3>
              <p className="m-0">{result.region}</p>
            </section>
          )}
          <section>
            <h3 className="text-ink-2 m-0 mb-1 text-[13px] font-semibold uppercase">
              {t('clinical.findings')}
            </h3>
            <p className="m-0 whitespace-pre-wrap">{result.findings || '—'}</p>
          </section>
          {result.impression && (
            <section>
              <h3 className="text-ink-2 m-0 mb-1 text-[13px] font-semibold uppercase">
                {t('clinical.impression')}
              </h3>
              <p className="m-0 font-semibold whitespace-pre-wrap">{result.impression}</p>
            </section>
          )}
          <p className="text-ink-3 border-border m-0 border-t pt-3 text-[13px]">
            {[
              result.verified ? t('clinical.verified') : t('clinical.notVerified'),
              result.corrected
                ? t('clinical.correctedWhy', { reason: result.correctionReason ?? '' })
                : null,
              result.doer ? t('clinical.scanDoneBy', { name: result.doer }) : null,
              result.by,
              result.at ? when(result.at) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </SidePanel>
    </>
  )
}
