import { useState, type ReactNode } from 'react'
import { Hand, Users, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Select } from '@/components/ui/select'
import { useOrderNurses } from '@/lib/api/nurse-orders'
import { cn } from '@/lib/utils'

type Mode = 'all' | 'one' | 'me'

/**
 * "For whom" on everything a doctor gives to the nurses (a task, a step-6 order): big choices,
 * "All the nurses", "One nurse" (then the list of the employees whose role is Nurse, 0132) and,
 * with selfId, "Me — I do it myself" (0133: nobody is told, the doctor records it done himself).
 * value '' = all the nurses; selfId = me; any other id = that nurse.
 */
export function NurseRecipient({
  value,
  onChange,
  selfId,
  className,
}: {
  value: string
  onChange: (id: string) => void
  /** The doctor filling the form: offers "Me — I do it myself". */
  selfId?: string
  className?: string
}) {
  const { t } = useTranslation()
  const { data: nurses = [], isLoading } = useOrderNurses()
  const fromValue = (): Mode => (value === '' ? 'all' : selfId && value === selfId ? 'me' : 'one')
  // "One nurse" stays chosen while the nurse is still to be picked
  const [picked, setPicked] = useState<Mode>(fromValue)
  const mode: Mode = value === '' ? (picked === 'one' ? 'one' : 'all') : fromValue()
  const pick = (m: Mode) => {
    setPicked(m)
    if (m === 'all') onChange('')
    else if (m === 'me' && selfId) onChange(selfId)
    else if (m === 'one' && mode !== 'one') onChange('')
  }
  const choice = (m: Mode, icon: ReactNode, label: string, hint: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => pick(m)}
      className={cn(
        'flex min-w-[12rem] flex-1 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
        mode === m
          ? 'border-primary bg-primary-tint text-ink ring-primary/20 ring-2'
          : 'border-border bg-surface text-ink-2 hover:bg-hover',
      )}
    >
      <span className={cn('mt-0.5', mode === m ? 'text-primary' : 'text-ink-3')}>{icon}</span>
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
          'all',
          <Users size={16} aria-hidden="true" />,
          t('nurseOrders.allNurses'),
          t('nurseOrders.allNursesHint'),
        )}
        {choice(
          'one',
          <UserRound size={16} aria-hidden="true" />,
          t('nurseOrders.oneNurse'),
          t('nurseOrders.oneNurseHint'),
        )}
        {selfId &&
          choice(
            'me',
            <Hand size={16} aria-hidden="true" />,
            t('nurseOrders.me'),
            t('nurseOrders.meHint'),
          )}
      </div>
      {mode === 'one' && (
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
