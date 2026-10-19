import { useTranslation } from 'react-i18next'
import { type TextSize, usePrefs } from '@/store/prefs'
import { cn } from '@/lib/utils'

const SIZES: { value: TextSize; glyph: string }[] = [
  { value: 'normal', glyph: 'text-[13px]' },
  { value: 'large', glyph: 'text-[16px]' },
  { value: 'xlarge', glyph: 'text-[20px]' },
]

/**
 * Text size switch (Normal / Large / Extra large): three "A" of growing size. Kept per device
 * with the language and theme; the whole staff screen scales with it.
 */
export function TextSizeControl({ full = false }: { full?: boolean }) {
  const { t } = useTranslation()
  const size = usePrefs((s) => s.textSize)
  const setSize = usePrefs((s) => s.setTextSize)
  return (
    <div
      role="radiogroup"
      aria-label={t('textSize.title')}
      className={cn('bg-surface border-border flex gap-1 rounded-xl border p-1', full && 'w-full')}
    >
      {SIZES.map((s) => {
        const on = size === s.value
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={t(`textSize.${s.value}`)}
            onClick={() => setSize(s.value)}
            className={cn(
              'flex min-h-11 flex-1 flex-col items-center justify-center rounded-lg px-3 py-1 transition-colors',
              on ? 'bg-navy text-white shadow-sm' : 'text-ink-2 hover:bg-hover',
            )}
          >
            <span className={cn('leading-none font-extrabold', s.glyph)}>A</span>
            {full && (
              <span
                className={cn(
                  'mt-1 text-[12px] font-semibold',
                  on ? 'text-white/85' : 'text-ink-3',
                )}
              >
                {t(`textSize.${s.value}`)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
