import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdjustMode } from '@/lib/adjust'
import { cn } from '@/lib/utils'

/**
 * A number input with a small mode switch next to the label: % off, RWF off, × multiplier
 * and (when allowed) a different price. Typing "10%", "x0.8" or "2000 RWF" also works.
 */
export function AdjustField({
  label,
  mode,
  modes,
  value,
  onMode,
  onChange,
  disabled,
  invalid,
  hint,
}: {
  label: string
  mode: AdjustMode
  modes: AdjustMode[]
  value: string
  onMode: (m: AdjustMode) => void
  onChange: (v: string) => void
  disabled?: boolean
  invalid?: boolean
  hint?: string
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-ink-2 text-[13px] font-semibold">
          {label}
        </label>
        <div
          role="radiogroup"
          aria-label={t('adjust.mode')}
          className="bg-hover inline-flex rounded-lg p-0.5"
        >
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={disabled}
              title={t(`adjust.titles.${m}`)}
              onClick={() => onMode(m)}
              className={cn(
                'min-w-9 rounded-md px-2 py-1 text-xs font-bold transition-colors',
                mode === m ? 'bg-card text-primary shadow-sm' : 'text-ink-3 hover:text-ink',
              )}
            >
              {t(`adjust.short.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={t(`adjust.ph.${mode}`)}
        aria-invalid={invalid || undefined}
        className={cn(
          'border-border bg-card text-ink focus:border-primary focus:ring-primary-tint h-11 rounded-lg border px-3 text-[15px] tabular-nums outline-none focus:ring-[3px] disabled:opacity-60',
          invalid && 'border-red',
        )}
      />
      {hint && <span className="text-ink-3 text-xs">{hint}</span>}
    </div>
  )
}
