import { useState, type FormEvent } from 'react'
import { CheckCircle2, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate, formatTime } from '@mmc/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Reveal } from '@/components/ui/reveal'
import { useConfirm } from '@/lib/confirm'
import type { DefinitiveSave, Diagnosis } from '@/lib/api/patients'
import {
  OUTCOME_TONE,
  confirmedLink,
  dxKey,
  dxWords,
  outcomeOf,
  type DxOutcome,
} from '@/lib/diagnosis-outcome'
import { cn } from '@/lib/utils'

const when = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(new Date(iso))}`

/** A typed line: a stable key; `added` lines (Add another) come into view with the cursor. */
interface Line {
  key: number
  text: string
  added: boolean
}
let lineKey = 0
const newLine = (added = false): Line => ({ key: ++lineKey, text: '', added })

/**
 * One possible diagnosis with its tick box, what was decided, by whom and when. writtenByHand:
 * the same words already stand as a definitive diagnosis not linked to it (written in step 5
 * before 0192): a note says what ticking it or leaving it does; nothing is decided from it.
 */
function PickRow({
  d,
  outcome,
  confirmedBy,
  writtenByHand,
  checked,
  disabled,
  onToggle,
}: {
  d: Diagnosis
  outcome: DxOutcome
  confirmedBy: Diagnosis | undefined
  writtenByHand: boolean
  checked: boolean
  disabled: boolean
  onToggle: (on: boolean) => void
}) {
  const { t } = useTranslation()
  const locked = outcome === 'confirmed'
  const meta =
    locked && confirmedBy
      ? t('sixSteps.confirmedBy', { name: confirmedBy.by ?? '', when: when(confirmedBy.at) })
      : outcome === 'not_confirmed' && d.notConfirmedAt
        ? t('sixSteps.notConfirmedBy', {
            name: d.notConfirmedBy ?? '',
            when: when(d.notConfirmedAt),
          })
        : null
  return (
    <li className="list-none">
      <label
        className={cn(
          'flex min-h-9 items-start gap-3 rounded-md border px-3 py-2',
          locked
            ? 'border-green/25 bg-green-bg/50 cursor-default'
            : checked
              ? 'border-primary/40 bg-primary-tint cursor-pointer'
              : 'border-border bg-card hover:bg-hover cursor-pointer',
        )}
      >
        <input
          type="checkbox"
          className="accent-primary mt-0.5 size-4.5 flex-none"
          checked={locked || checked}
          disabled={locked || disabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1">
          <span className="min-w-0 flex-[1_1_12rem]">
            <span className="block text-[15px] font-semibold">{d.text}</span>
            {meta && <span className="text-ink-3 block text-xs">{meta}</span>}
            {writtenByHand && (
              <span className="text-amber block text-xs font-semibold">
                {t('sixSteps.pick.alsoWritten')}
              </span>
            )}
          </span>
          <Badge tone={OUTCOME_TONE[outcome]} dot={false} className="flex-none">
            {t(`dxOutcome.${outcome}`)}
          </Badge>
        </span>
      </label>
    </li>
  )
}

/**
 * 0192, step 5: the doctor ticks which possible diagnoses (step 3) are confirmed — one, several
 * or none — writes any other diagnosis, and saves once. The box before saving lists what will be
 * written: the confirmed ones, the ones left unticked ("not confirmed", under his name), the
 * others, and the main diagnosis. A confirmed one stays ticked (taken back by removing its
 * definitive diagnosis); a "not confirmed" one may be ticked later. Nothing is decided from the
 * words: a typed diagnosis that is in the list above is refused ("tick it instead", or "it is
 * confirmed already"), and the same words written by hand before only bring a note.
 */
export function DefinitivePick({
  differentials,
  definitive,
  hasPrimary,
  primaryText,
  noDiagnosisText,
  patientName,
  saving,
  onSave,
}: {
  /** The standing possible diagnoses, in step 3's order. */
  differentials: Diagnosis[]
  /** The standing definitive diagnoses (they say which possible ones are confirmed). */
  definitive: Diagnosis[]
  /** A main (primary) diagnosis stands already: it stays the main one. */
  hasPrimary: boolean
  primaryText: string | null
  /** The reason no diagnosis was found, if one stands: a main diagnosis written replaces it. */
  noDiagnosisText: string | null
  patientName: string
  saving: boolean
  /** Saves; true when saved (the ticks and the typed lines are then cleared). */
  onSave: (i: DefinitiveSave) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set())
  const [lines, setLines] = useState<Line[]>(() => [newLine()])
  const rows = differentials.map((d) => {
    const outcome = outcomeOf(d, definitive)
    return {
      d,
      outcome,
      link: confirmedLink(d, definitive),
      // the same words stand as a definitive diagnosis that is not linked to it: only a note
      writtenByHand:
        outcome !== 'confirmed' &&
        definitive.some(
          (x) => !x.removedAt && x.differentialId !== d.id && dxKey(x.text) === dxKey(d.text),
        ),
    }
  })
  /**
   * The possible diagnosis a typed line repeats (trimmed, any case): one not confirmed yet is
   * ticked instead; one confirmed already needs nothing (as the database answers).
   */
  const clashOf = (text: string) => {
    const k = dxKey(text)
    if (!k) return undefined
    const same = rows.filter((r) => dxKey(r.d.text) === k)
    return same.find((r) => r.outcome !== 'confirmed') ?? same[0]
  }
  const typed = lines.map((l) => dxWords(l.text)).filter(Boolean)
  const clash = lines.some((l) => !!clashOf(l.text))
  const toConfirm = rows.filter((r) => r.outcome !== 'confirmed' && ticked.has(r.d.id))
  const undecided = rows.filter((r) => r.outcome === 'not_decided')
  const canSave = !clash && (toConfirm.length > 0 || typed.length > 0 || undecided.length > 0)

  const toggle = (id: string, on: boolean) =>
    setTicked((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const setLine = (key: number, text: string) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, text } : l)))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSave || saving) return
    const confirmIds = toConfirm.map((r) => r.d.id)
    // left unticked: the not decided ones become "not confirmed"; a "not confirmed" one stays
    const notConfirmed = undecided.filter((r) => !ticked.has(r.d.id))
    const staying = rows.filter((r) => r.outcome === 'not_confirmed' && !ticked.has(r.d.id))
    const seen = new Set<string>()
    const other = typed.filter((x) => !seen.has(dxKey(x)) && !!seen.add(dxKey(x)))
    // 0130: the first definitive diagnosis is the main one: the first ticked, else the first typed
    const newMain = hasPrimary ? null : (toConfirm[0]?.d.text ?? other[0] ?? null)
    const mainLine = hasPrimary
      ? primaryText
        ? t('sixSteps.pick.sumMainStays', { dx: primaryText })
        : null
      : newMain
        ? t('sixSteps.pick.sumMain', { dx: newMain })
        : t('sixSteps.pick.sumNoMain')
    const list = (xs: string[]) => xs.join(', ')
    const summary: { k: string; text: string }[] = [
      ...(toConfirm.length
        ? [
            {
              k: 'c',
              text: t('sixSteps.pick.sumConfirmed', { list: list(toConfirm.map((r) => r.d.text)) }),
            },
          ]
        : []),
      ...(notConfirmed.length + staying.length
        ? [
            {
              k: 'n',
              text: t('sixSteps.pick.sumNotConfirmed', {
                list: list([...notConfirmed, ...staying].map((r) => r.d.text)),
              }),
            },
          ]
        : []),
      ...(other.length
        ? [{ k: 'o', text: t('sixSteps.pick.sumOther', { list: list(other) }) }]
        : []),
      ...(mainLine ? [{ k: 'm', text: mainLine }] : []),
      ...(newMain && noDiagnosisText
        ? [{ k: 'r', text: t('sixSteps.pick.sumReplacesNoDx', { reason: noDiagnosisText }) }]
        : []),
    ]
    if (
      !(await confirm({
        title: t('sixSteps.pick.q', { name: patientName }),
        body: (
          <div className="flex flex-col gap-2">
            <ul className="m-0 flex flex-col gap-1 pl-5">
              {summary.map((s) => (
                <li key={s.k}>{s.text}</li>
              ))}
            </ul>
            <p className="m-0">{t('confirm.visit.recordBody')}</p>
          </div>
        ),
        confirmLabel: t('confirm.visit.saveYes'),
      }))
    )
      return
    const saved = await onSave({
      confirm: confirmIds,
      notConfirmed: notConfirmed.map((r) => r.d.id),
      other,
    })
    if (saved) {
      setTicked(new Set())
      setLines([newLine()])
    }
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <fieldset className="border-border bg-hover/40 m-0 flex min-w-0 flex-col gap-2 rounded-md border p-3">
        <legend className="text-ink px-1 text-[14px] font-semibold">
          {t('sixSteps.pick.title')}
        </legend>
        {rows.length > 0 ? (
          <ul className="m-0 flex flex-col gap-1.5 p-0">
            {rows.map((r) => (
              <PickRow
                key={r.d.id}
                d={r.d}
                outcome={r.outcome}
                confirmedBy={r.link}
                writtenByHand={r.writtenByHand}
                checked={ticked.has(r.d.id)}
                disabled={saving}
                onToggle={(on) => toggle(r.d.id, on)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-ink-3 m-0 text-[13px]">{t('sixSteps.pick.none')}</p>
        )}
        {lines.map((l) => {
          const same = clashOf(l.text)
          const field = (
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-end gap-2">
                <Field
                  label={t(rows.length ? 'sixSteps.pick.other' : 'sixSteps.pick.otherAlone')}
                  value={l.text}
                  onChange={(e) => setLine(l.key, e.target.value)}
                  placeholder={t('clinical.dxPh')}
                  maxLength={300}
                  disabled={saving}
                  aria-invalid={same ? true : undefined}
                  wrapperClassName="min-w-0 flex-1"
                  className="w-full"
                />
                {lines.length > 1 && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('sixSteps.pick.removeLine')}
                    title={t('sixSteps.pick.removeLine')}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <X size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
              {same && (
                <Reveal block="nearest">
                  <p role="alert" className="text-red m-0 text-[13px] font-semibold">
                    {t(
                      same.outcome === 'confirmed'
                        ? 'sixSteps.pick.inListConfirmed'
                        : 'sixSteps.pick.inList',
                      { dx: same.d.text },
                    )}
                  </p>
                </Reveal>
              )}
            </div>
          )
          return l.added ? (
            <Reveal key={l.key} focus block="nearest">
              {field}
            </Reveal>
          ) : (
            <div key={l.key} className="min-w-0">
              {field}
            </div>
          )
        })}
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={saving}
          onClick={() => setLines((ls) => [...ls, newLine(true)])}
        >
          <Plus size={14} aria-hidden="true" />
          {t('sixSteps.pick.addLine')}
        </Button>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>
          <CheckCircle2 size={16} aria-hidden="true" />
          {t('sixSteps.pick.save')}
        </Button>
        {!canSave && !clash && (
          <span className="text-ink-3 text-xs">{t('sixSteps.pick.nothing')}</span>
        )}
      </div>
    </form>
  )
}
