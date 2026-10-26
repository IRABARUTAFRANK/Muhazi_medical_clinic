import { useState, type ReactNode } from 'react'
import { CircleAlert, Plus, Printer, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRwf, formatTime } from '@mmc/shared'
import { registrationText, useMyCredentials } from '@/lib/api/staff'
import { openDispenseLabels } from '@/lib/dispense-label'
import { allergyList } from '@/lib/doc-style'
import { useLetterhead } from '@/lib/report-parts'
import { useSession } from '@/store/session'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { SearchSelect } from '@/components/ui/search-select'
import { cn } from '@/lib/utils'
import { useHanded, type HandedGroup } from './handed'
import { newLine, type EditLine } from './util'

/**
 * The patient's allergies, shown first and in red when there are any: the pharmacist checks
 * every medicine against them before handing over.
 */
export function AllergyBox({ allergies }: { allergies: string | null | undefined }) {
  const { t } = useTranslation()
  const list = allergyList(allergies ?? null)
  if (list == null)
    return (
      <p className="border-amber/30 bg-amber-bg text-amber m-0 rounded border px-2.5 py-1 text-[12px] font-medium">
        {t('pharmacy.allergiesNotRecorded')}
      </p>
    )
  if (!list.length)
    return <p className="text-ink-3 m-0 text-[12px]">{t('pharmacy.noKnownAllergies')}</p>
  return (
    <p
      className="bg-red-bg text-red border-red m-0 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-[14px] font-semibold"
      role="alert"
    >
      <CircleAlert size={16} aria-hidden="true" className="mt-0.5 flex-none" />
      <span>
        {t('pharmacy.allergyFlag')}: {list.join(', ')}
      </span>
    </p>
  )
}

/**
 * What was just handed over, with its labels: printed after the hand-over from what was really
 * given (batch and expiry), and printed again with "Reprint". For visits it also says where the
 * patient goes next.
 */
export function HandedStrip({
  kind,
  only,
  onBlocked,
}: {
  kind: HandedGroup['kind']
  /** Only this visit (the visit screen). */
  only?: string
  onBlocked: () => void
}) {
  const { t } = useTranslation()
  const letterhead = useLetterhead()
  const me = useSession((s) => s.user)
  const creds = useMyCredentials(me?.id ?? '').data
  const all = useHanded((s) => s.groups)
  const update = useHanded((s) => s.update)
  const remove = useHanded((s) => s.remove)
  const groups = all.filter((g) => g.kind === kind && (!only || g.key === only))
  if (!groups.length) return null
  const print = (g: HandedGroup) => {
    const ok = openDispenseLabels(
      {
        clinic: {
          name: letterhead.legalName,
          contacts: letterhead.contacts,
          phone: letterhead.phone,
        },
        patient: g.patient,
        date: new Date(g.at),
        lines: g.lines,
        dispensedBy: me ? { name: me.name, registrationNo: registrationText(creds) } : null,
      },
      {
        title: t('pharmacy.labelTitle'),
        days: (n) => t('pharmacy.labelDays', { count: n }),
      },
    )
    if (!ok) onBlocked()
    else update(g.key, { printed: true })
  }
  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => (
        <div
          key={g.key}
          className="border-green bg-green-bg/60 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border px-3 py-2"
        >
          <span className="min-w-[200px] flex-1 text-[14px]">
            <span className="text-ink block font-semibold">
              {t(kind === 'sale' ? 'pharmacy.handedSale' : 'pharmacy.handedTo', {
                name: g.patient.name,
                count: g.lines.length,
              })}{' '}
              <span className="text-ink-3 font-normal">· {formatTime(new Date(g.at))}</span>
            </span>
            {kind === 'visit' && g.done && (
              <span className="text-ink-2 block font-semibold">
                {g.toPay != null && g.toPay > 0
                  ? t('pharmacy.nextCashier', { amount: formatRwf(g.toPay) })
                  : t('pharmacy.nextNothingToPay')}
              </span>
            )}
            <span className="text-ink-3 block text-[12px]">
              {g.lines
                .map((l) =>
                  [
                    `${l.item} × ${l.quantity}`,
                    l.batchNo ? `${t('pharmacy.batch')} ${l.batchNo}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                )
                .join('; ')}
            </span>
          </span>
          <Button size="sm" variant={g.printed ? 'default' : 'primary'} onClick={() => print(g)}>
            <Printer size={14} aria-hidden="true" />
            {g.printed ? t('pharmacy.reprintLabels') : t('pharmacy.printLabelsNow')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={t('pharmacy.dismiss')}
            aria-label={t('pharmacy.dismiss')}
            onClick={() => remove(g.key)}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      ))}
    </div>
  )
}

/** A reason to type (with quick choices) before a refusal, a cancel or a decline. */
export function ReasonBox({
  title,
  choices = [],
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  initial = '',
}: {
  title: string
  choices?: string[]
  confirmLabel: string
  busy?: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
  initial?: string
}) {
  const { t } = useTranslation()
  const [reason, setReason] = useState(initial)
  return (
    <Reveal focus block="nearest">
      <div className="border-border bg-card flex flex-col gap-2 rounded-md border p-2.5">
        <span className="text-[14px] font-semibold">{title}</span>
        {choices.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {choices.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setReason(c)}
                className={cn(
                  'rounded border px-2.5 py-1 text-[12px] font-medium transition-colors duration-120',
                  reason === c
                    ? 'border-primary bg-primary text-white'
                    : 'border-border text-ink-2 hover:bg-hover',
                )}
              >
                {c}
              </button>
            ))}
          </span>
        )}
        <input
          className="border-border bg-card focus:border-primary h-10 rounded-md border px-2.5 text-[14px] outline-none"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('pharmacy.reasonPh')}
          aria-label={t('pharmacy.reasonPh')}
        />
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={reason.trim().length < 3 || busy}
            loading={busy}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('staff.form.cancel')}
          </Button>
        </span>
      </div>
    </Reveal>
  )
}

/** Medicines and quantities (a counter sale, a transfer note): add, change, remove lines. */
export function LinesEditor({
  lines,
  onChange,
  options,
  below,
}: {
  lines: EditLine[]
  onChange: (lines: EditLine[]) => void
  options: { value: string; label: string }[]
  /** Under each line: price, stock, the batches it takes… */
  below?: (l: EditLine) => ReactNode
}) {
  const { t } = useTranslation()
  const set = (key: string, patch: Partial<EditLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  return (
    <div className="flex flex-col gap-2">
      {lines.map((l, i) => (
        <div key={l.key} className="bg-surface/70 flex flex-col gap-1.5 rounded-md p-2">
          <div className="grid grid-cols-[minmax(0,1fr)_96px_auto] items-end gap-2">
            <SearchSelect
              label={i === 0 ? t('stock.cols.item') : ''}
              value={l.itemId}
              onChange={(v) => set(l.key, { itemId: v })}
              emptyLabel={t('visit.add.pickItem')}
              options={options.filter(
                (o) => o.value === l.itemId || !lines.some((x) => x.itemId === o.value),
              )}
            />
            <Field
              label={i === 0 ? t('stock.quantity') : ''}
              inputMode="numeric"
              value={l.quantity}
              onChange={(e) => set(l.key, { quantity: e.target.value.replace(/[^\d]/g, '') })}
              aria-label={t('stock.quantity')}
            />
            <Button
              size="icon"
              variant="ghost"
              title={t('pharmacy.removeLine')}
              aria-label={t('pharmacy.removeLine')}
              disabled={lines.length === 1 && !l.itemId}
              onClick={() =>
                onChange(lines.length === 1 ? [newLine()] : lines.filter((x) => x.key !== l.key))
              }
            >
              <Trash2 size={16} aria-hidden="true" />
            </Button>
          </div>
          {l.itemId && below?.(l)}
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => onChange([...lines, newLine()])}
      >
        <Plus size={14} aria-hidden="true" />
        {t('pharmacy.addLine')}
      </Button>
    </div>
  )
}
