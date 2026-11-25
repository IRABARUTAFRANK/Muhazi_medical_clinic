import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/** 0204 · The box in the question before printing a prescription: the registration no. or not. */
export function RegistrationTick({ onChange }: { onChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const [on, setOn] = useState(false)
  return (
    <label className="text-ink flex min-w-0 cursor-pointer items-start gap-2 text-[14px]">
      <input
        type="checkbox"
        className="accent-primary mt-0.5 size-4 flex-none"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked)
          onChange(e.target.checked)
        }}
      />
      <span className="min-w-0">
        <span className="block font-medium">{t('rxDoc.printAsk.includeReg')}</span>
        <span className="text-ink-3 block text-[13px]">{t('rxDoc.printAsk.regHint')}</span>
      </span>
    </label>
  )
}
