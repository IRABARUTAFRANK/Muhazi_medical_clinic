import { useState } from 'react'
import { Check, DoorOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconChip } from '@/components/dash/kit'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Flash } from '@/components/ui/flash'
import {
  DEFAULT_CEILINGS,
  DESKS,
  deskName,
  useRoleDeskActions,
  useRoleDeskMatrix,
  type DeskId,
} from '@/lib/api/desks'
import { MATRIX_ROLES } from '@/lib/api/permissions'
import { useDepartments, type DbRole } from '@/lib/api/staff'
import { useConfirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'

type DeskRole = Exclude<DbRole, 'manager'>
const ROLES = MATRIX_ROLES.filter((r): r is DeskRole => r !== 'manager')

/*
 * Settings → Who may do what → "What each role may do at the desks" (manager, migration 0085).
 * The role is the ceiling: the desks a person of that role may ever use. The departments a person
 * works in decide which of them they actually get; while no department gives a desk, the role
 * alone decides it, as before. Money never comes from a desk (it stays with the switches above).
 */
export function DesksCard() {
  const { t } = useTranslation()
  const { data: matrix, error: loadError } = useRoleDeskMatrix()
  const { data: departments = [] } = useDepartments()
  const { setRoleDesk } = useRoleDeskActions()
  const confirm = useConfirm()
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const has = (role: DeskRole, desk: DeskId) =>
    (matrix?.roles[role] ?? DEFAULT_CEILINGS[role]).includes(desk)
  // The departments that give each desk (the ones the manager sees on the Staff page).
  const givenBy = (desk: DeskId) =>
    departments.filter((d) => d.services.includes(desk)).map((d) => d.name)
  const readOnly = !matrix || matrix.fallback

  const toggle = async (role: DeskRole, desk: DeskId) => {
    const on = has(role, desk)
    const vars = { desk: deskName(desk, t), role: t(`staff.roles.${role}`) }
    const k = on ? 'confirm.perms.deskOff' : 'confirm.perms.deskOn'
    if (
      !(await confirm({
        title: t(`${k}.title`, vars),
        body: t(`${k}.body`, vars),
        confirmLabel: t(`${k}.yes`),
        tone: on ? 'danger' : 'primary',
      }))
    )
      return
    setError(null)
    setNotice(null)
    try {
      await setRoleDesk.mutateAsync({ role, desk, allowed: !on })
      setNotice(t(on ? 'perms.desks.off' : 'perms.desks.on', vars))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <IconChip icon={DoorOpen} tint="teal" />
          {t('perms.desks.title')}
        </span>
      </CardHeader>
      <CardBody className="gap-3">
        <p className="text-ink-2 m-0 text-[14px]">{t('perms.desks.lead')}</p>
        {matrix?.fallback && (
          <p className="border-amber/30 bg-amber-bg text-amber m-0 rounded-md border px-3 py-2 text-[14px] font-medium">
            {t('perms.desks.fallback')}
          </p>
        )}
        {(loadError || error) && (
          <Flash tone="error" onClose={() => setError(null)}>
            {error ?? loadError?.message}
          </Flash>
        )}
        {notice && (
          <Flash key={notice} onClose={() => setNotice(null)}>
            {notice}
          </Flash>
        )}
        <div className="border-border overflow-x-auto rounded-md border">
          <table className="w-full min-w-[820px] text-[14px]">
            <thead className="bg-hover/60 text-ink-2">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">{t('perms.desks.desk')}</th>
                {ROLES.map((r) => (
                  <th key={r} className="px-2 py-2 text-center font-semibold">
                    {t(`staff.roles.${r}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DESKS.map((desk) => {
                const by = givenBy(desk)
                return (
                  <tr key={desk} className="border-border border-t">
                    <td className="px-3 py-2">
                      <span className="block font-semibold">{deskName(desk, t)}</span>
                      <span className="text-ink-3 block text-xs">
                        {t(`desks.hints.${desk}`, { defaultValue: '' })}
                      </span>
                      <span
                        className={cn(
                          'block text-xs font-semibold',
                          by.length ? 'text-green' : 'text-ink-3',
                        )}
                      >
                        {by.length
                          ? t('perms.desks.offeredBy', { names: by.join(', ') })
                          : t('perms.desks.byRole')}
                      </span>
                    </td>
                    {ROLES.map((r) => {
                      const on = has(r, desk)
                      return (
                        <td key={r} className="px-2 py-2 text-center">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={on}
                            aria-label={`${deskName(desk, t)} · ${t(`staff.roles.${r}`)}`}
                            disabled={readOnly || setRoleDesk.isPending}
                            onClick={() => void toggle(r, desk)}
                            className={cn(
                              'inline-flex size-9 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed',
                              on
                                ? 'border-green/40 bg-green-bg text-green'
                                : 'border-border bg-card text-ink-3 hover:bg-hover',
                              readOnly && 'opacity-70',
                            )}
                          >
                            {on ? (
                              <Check size={16} strokeWidth={3} aria-hidden="true" />
                            ) : (
                              <X size={15} aria-hidden="true" />
                            )}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-ink-3 m-0 text-xs">{t('perms.desks.managerNote')}</p>
      </CardBody>
    </Card>
  )
}
