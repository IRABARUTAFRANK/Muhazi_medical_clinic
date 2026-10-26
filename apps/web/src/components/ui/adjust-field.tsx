import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdjustMode } from '@/lib/adjust'
import { cn } from '@/lib/utils'
import { controlClass } from './field'

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
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-ink-2 text-[13px] font-medium">
          {label}
        </label>
        <div
          role="radiogroup"
          aria-label={t('adjust.mode')}
          className="border-border bg-surface inline-flex h-7 gap-0.5 rounded-md border p-0.5"
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
                'min-w-9 rounded border px-2 text-[12px] font-medium transition-colors duration-120',
                mode === m
                  ? 'border-border bg-card text-ink'
                  : 'text-ink-3 hover:text-ink border-transparent',
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
        className={cn(controlClass, 'tabular-nums', invalid && 'border-red')}
      />
      {hint && <span className="text-ink-3 text-xs">{hint}</span>}
    </div>
  )
}
