import { useTranslation } from 'react-i18next'
import { type TextSize, usePrefs } from '@/store/prefs'
import { cn } from '@/lib/utils'

const SIZES: { value: TextSize; glyph: string }[] = [
  { value: 'normal', glyph: 'text-[12px]' },
  { value: 'large', glyph: 'text-[15px]' },
  { value: 'xlarge', glyph: 'text-[18px]' },
]

/**
 * Text size switch (Normal / Large / Extra large): three "A" of growing size on a segmented
 * control. Kept per device with the language and theme; the whole staff screen scales with it.
 */
export function TextSizeControl({ full = false }: { full?: boolean }) {
  const { t } = useTranslation()
  const size = usePrefs((s) => s.textSize)
  const setSize = usePrefs((s) => s.setTextSize)
  return (
    <div
      role="radiogroup"
      aria-label={t('textSize.title')}
      className={cn(
        'bg-surface border-border inline-flex gap-0.5 rounded-md border p-0.5',
        full ? 'w-full' : 'self-start',
      )}
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
              'flex min-h-8 flex-1 flex-col items-center justify-center rounded border px-3 transition-colors duration-120',
              on
                ? 'border-border bg-card text-primary'
                : 'text-ink-2 hover:bg-hover hover:text-ink border-transparent',
            )}
          >
            <span className={cn('leading-none font-semibold', s.glyph)}>A</span>
            {full && (
              <span className={cn('mt-1 text-[12px]', on ? 'text-ink' : 'text-ink-3')}>
                {t(`textSize.${s.value}`)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
