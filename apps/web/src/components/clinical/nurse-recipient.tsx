import { useState, type ReactNode } from 'react'
import { Users, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Select } from '@/components/ui/select'
import { useOrderNurses } from '@/lib/api/nurse-orders'
import { cn } from '@/lib/utils'

/**
 * "For whom" on everything a doctor sends to the nurses (a task, a step-6 order): two big
 * choices, "All the nurses" or "One nurse", and with the second the list of the employees whose
 * role is Nurse (0132; a doctor working at the nursing desk is not listed). value '' = all the nurses.
 */
export function NurseRecipient({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (id: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const { data: nurses = [], isLoading } = useOrderNurses()
  // "One nurse" stays chosen while the nurse is still to be picked
  const [one, setOne] = useState(value !== '')
  const single = one || value !== ''
  const choice = (on: boolean, icon: ReactNode, label: string, hint: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={single === on}
      onClick={() => {
        setOne(on)
        if (!on) onChange('')
      }}
      className={cn(
        'flex min-w-0 flex-1 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
        single === on
          ? 'border-primary bg-primary-tint text-ink ring-primary/20 ring-2'
          : 'border-border bg-surface text-ink-2 hover:bg-hover',
      )}
    >
      <span className={cn('mt-0.5', single === on ? 'text-primary' : 'text-ink-3')}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{label}</span>
        <span className="text-ink-3 block text-xs">{hint}</span>
      </span>
    </button>
  )
  return (
    <fieldset className={cn('m-0 flex min-w-0 flex-col gap-2 border-0 p-0', className)}>
      <legend className="text-ink-2 mb-1 p-0 text-[13px] font-semibold">
        {t('nurseOrders.forWhom')}
      </legend>
      <div role="radiogroup" aria-label={t('nurseOrders.forWhom')} className="flex flex-wrap gap-2">
        {choice(
          false,
          <Users size={16} aria-hidden="true" />,
          t('nurseOrders.allNurses'),
          t('nurseOrders.allNursesHint'),
        )}
        {choice(
          true,
          <UserRound size={16} aria-hidden="true" />,
          t('nurseOrders.oneNurse'),
          t('nurseOrders.oneNurseHint'),
        )}
      </div>
      {single && (
        <Select
          label={t('nurseOrders.whichNurse')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
        >
          <option value="">
            {isLoading
              ? t('nurseOrders.loadingNurses')
              : nurses.length
                ? t('nurseOrders.pickNurse')
                : t('nurseOrders.noNurses')}
          </option>
          {nurses.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </Select>
      )}
    </fieldset>
  )
}
