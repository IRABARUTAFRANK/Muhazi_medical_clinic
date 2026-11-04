import { useState, type FormEvent } from 'react'
import { History, Pencil, Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { useConfirm } from '@/lib/confirm'
import type { SectionKey, VisitSection } from '@/lib/api/patients'
import { cn } from '@/lib/utils'

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`
const area =
  'border-border bg-card text-ink focus:border-primary focus:ring-primary-tint w-full rounded-md border px-3 py-2 text-[15px] font-normal outline-none focus:ring-[3px]'

/**
 * One of the doctor's texts of a visit (0127): the chief complaint, the history of the present
 * illness, the physical examination, the treatment plan. Read: the text, who wrote it and when
 * (and its earlier versions); the doctor writes it at once when empty, or presses Edit. After the
 * visit is finished (inside the edit window), a change needs a reason.
 */
export function SectionEditor({
  section,
  value,
  editable,
  needReason = false,
  rows = 4,
  patientName,
  template,
  onSave,
}: {
  section: SectionKey
  value: VisitSection | undefined
  editable: boolean
  /** A finished visit, inside its edit window: the reason of the change. */
  needReason?: boolean
  /** 1: one line (the chief complaint). */
  rows?: number
  patientName: string
  /** A starting text the doctor may drop in (the examination by system). */
  template?: string
  onSave: (text: string, reason: string | null) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [versions, setVersions] = useState(false)
  const open = editable && (editing || !value)
  const text = editing || !value ? draft : value.text
  const label = t(`sixSteps.sections.${section}`)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const next = draft.trim()
    if (!next && !value) return
    if (
      !(await confirm({
        title: t(next ? 'sixSteps.saveQ' : 'sixSteps.clearQ', { what: label, name: patientName }),
        body: t('confirm.visit.recordBody'),
        confirmLabel: t('confirm.visit.saveYes'),
      }))
    )
      return
    setBusy(true)
    try {
      await onSave(next, needReason ? reason.trim() || null : null)
      setEditing(false)
      setDraft('')
      setReason('')
    } finally {
      setBusy(false)
    }
  }
  const history = value?.history ?? []
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ink-2 flex flex-wrap items-center gap-2 text-[13px] font-semibold">
        {label}
        {value && editable && !editing && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => {
              setDraft(value.text)
              setEditing(true)
            }}
          >
            <Pencil size={13} aria-hidden="true" />
            {t('clinical.editLine')}
          </Button>
        )}
      </span>
      {open ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          {rows <= 1 ? (
            <input
              aria-label={label}
              className={cn(area, 'h-11')}
              value={text}
              maxLength={500}
              placeholder={t(`sixSteps.placeholders.${section}`)}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <textarea
              aria-label={label}
              className={area}
              rows={rows}
              value={text}
              maxLength={8000}
              placeholder={t(`sixSteps.placeholders.${section}`)}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          {needReason && value && (
            <Field
              label={t('clinical.editWhy')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('clinical.editWhyPh')}
              required
              minLength={3}
            />
          )}
          <span className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!draft.trim() && !value}
            >
              {t('sixSteps.save')}
            </Button>
            {template && !draft.trim() && (
              <Button size="sm" onClick={() => setDraft(template)}>
                <Wand2 size={14} aria-hidden="true" />
                {t('sixSteps.useTemplate')}
              </Button>
            )}
            {editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('staff.form.cancel')}
              </Button>
            )}
          </span>
        </form>
      ) : value ? (
        <div className="bg-hover/40 border-border rounded-md border px-3 py-2">
          <p className="text-ink m-0 text-[15px] whitespace-pre-wrap">{value.text}</p>
          <span className="text-ink-3 mt-1 block text-xs">
            {[
              value.by,
              when(value.at),
              value.editedAt
                ? t('clinical.editedBy', { name: value.editedBy ?? '', when: when(value.editedAt) })
                : null,
              value.editReason ? t('clinical.editedWhy', { reason: value.editReason }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {history.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={versions}
                onClick={() => setVersions((v) => !v)}
                className="text-primary mt-1 inline-flex items-center gap-1 bg-transparent p-0 text-xs font-semibold hover:underline"
              >
                <History size={12} aria-hidden="true" />
                {t('clinical.previousVersions', { count: history.length })}
              </button>
              {versions && (
                <ul className="text-ink-2 mt-1 flex flex-col gap-1 pl-5 text-[13px]">
                  {history.map((v, i) => (
                    <li key={i}>
                      <span className="block whitespace-pre-wrap line-through">{v.text}</span>
                      <span className="text-ink-3 block text-xs">
                        {t('clinical.versionReplaced', {
                          name: v.replacedBy ?? '',
                          when: when(v.replacedAt),
                          reason: v.reason ?? '',
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ) : (
        <p className="text-ink-3 m-0 text-[14px] italic">{t('sixSteps.notWritten')}</p>
      )}
    </div>
  )
}
